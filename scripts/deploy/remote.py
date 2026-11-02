"""Executed over SSH on reko-3. Emits metadata only; backups never leave the host."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

DOCKER = ["docker", "--context", "default"]
RO = "-c default_transaction_read_only=on -c statement_timeout=30s -c lock_timeout=5s"
EXPECTED_APP = "registry.cubytest.space/cuby/agents-app@sha256:8a8d92f6ad22e024e3defba54261e903e60b24e43a18f5efd0d1e13a534916a8"
EXPECTED_SANDBOX = "registry.cubytest.space/cuby/agents-sandbox@sha256:04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40"
EXPECTED_TOOLS = "registry.cubytest.space/cuby/agents-release-tools@sha256:9f3b8a9c4e4e8f16701aa60147f31b97b5da10eaea84b4087e7d80b6d64b2826"


def run(args, data=None, timeout=60, output=None):
    result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # stderr can contain data paths or database values; never forward it to Mac.
        text = result.stderr.decode(errors="replace").lower()
        kind = next((k for k in ("permission denied", "operation not permitted", "no such file", "unknown flag") if k in text), "subprocess")
        raise RuntimeError(f"{kind}: exit {result.returncode}")
    return result.stdout


def docker(*args, **kwargs):
    return run(DOCKER + list(args), **kwargs)


def sql(container, query):
    if container not in ("agents-dev-postgres-1", "agents-postgres-1"):
        raise ValueError("Contenedor de origen no autorizado")
    return docker("exec", "-i", "-e", "PGOPTIONS=" + RO, container,
                  "psql", "-X", "-U", "agents", "-d", "agents", "-At", "-v", "ON_ERROR_STOP=1",
                  data=query.encode()).decode().strip()


def mounts(container):
    return json.loads(docker("inspect", container, "--format", "{{json .Mounts}}"))


def mount_arg(mount, target, readonly=True):
    kind = mount["Type"]
    if kind == "volume":
        name = mount["Name"]
        docker("volume", "inspect", name)  # Don't auto-create an absent source volume.
        spec = f"type=volume,src={name},dst={target},volume-nocopy"
    elif kind == "bind":
        name = mount["Source"]
        if "," in name or not name.startswith("/"):
            raise ValueError("Ruta de montaje inválida")
        spec = f"type=bind,src={name},dst={target}"
    else:
        raise ValueError("Tipo de montaje no soportado")
    return spec + (",readonly" if readonly else "")


def approved_data_mount(container, mount):
    suffix = mount["Destination"].lstrip("/")
    if suffix not in ("data", "cliproxy"):
        raise ValueError("Destino de datos desconocido")
    if container == "agents-dev-server-1":
        valid = mount["Type"] == "volume" and mount.get("Name") == "agents-dev_" + suffix
    elif container == "agents-server-1":
        valid = mount["Type"] == "bind" and mount.get("Source") == "/srv/agents/" + suffix
    else:
        valid = False
    if not valid:
        raise ValueError("Montaje inesperado; no se respalda una ruta más amplia")
    return mount


def helper(tools, run_id, extra_mounts, *command, timeout=300, caps=False, data=None):
    args = ["run", "--rm", "--pull=never", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m",
            "--cpus", "0.5", "--pids-limit", "64", "--label", "agents.migration=" + run_id,
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m"]
    if data is not None:
        args += ["-i"]
    if caps:
        args += ["--cap-add", "DAC_READ_SEARCH", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN", "--cap-add", "FOWNER"]
    for mount in extra_mounts:
        args += ["--mount", mount]
    return docker(*args, "--entrypoint", "timeout", tools, str(timeout - 5), *command, timeout=timeout, data=data)


def metadata():
    query = """select json_build_object(
      'people',(select count(*) from people),
      'test',(select json_agg(id) from people where key='test'),
      'liveRuns',(select count(*) from runs where status in ('queued','starting','running','blocked')),
      'pendingMessages',(select count(*) from messages where routed_at is null),
      'pendingDeliveries',(select count(*) from webhook_deliveries where status='pending'),
      'dbosColumns',(select json_agg(json_build_object('table',table_name,'column',column_name,'type',data_type) order by table_name,ordinal_position)
         from information_schema.columns where table_schema='dbos'),
      'dbosStatuses',(select json_agg(x) from (select status,count(*) as count from dbos.workflow_status group by status order by status) x),
      'dbosSchedules',(select coalesce(json_agg(json_build_object('name',schedule_name,'status',status,'workflow',workflow_name,'backfill',automatic_backfill,'timezone',cron_timezone) order by schedule_name),'[]') from dbos.workflow_schedules),
      'dbosVersions',(select json_agg(version_name order by version_name) from dbos.application_versions),
      'agents',(select coalesce(json_agg(json_build_object('id',a.id,'volume',a.state_ref,'image',a.harness_image)
        order by a.id),'[]') from agents a join people p on p.id=a.person_id where p.key<>'test'));
    """
    return {"development": json.loads(sql("agents-dev-postgres-1", query)),
            "production": json.loads(sql("agents-postgres-1", query))}


REGISTRY_SCAN = r"""
const fs=require('fs'),path=require('path'); const out=[];
for(const repo of ['cuby/agents-sandbox','agents-sandbox','cuby/agents-release-probe-sandbox']) {
 const root=path.join('/registry',repo),index=path.join(root,'index.json');
 if(!fs.existsSync(index)) continue;
 const seen=new Set();
 function visit(desc,depth=0) {
  if(depth>3||seen.size>300||!/^sha256:[a-f0-9]{64}$/.test(desc.digest)) throw Error('invalid OCI graph');
  if(seen.has(desc.digest))return; seen.add(desc.digest);
  const blob=path.join(root,'blobs','sha256',desc.digest.slice(7));
  const d=JSON.parse(fs.readFileSync(blob));
  if(d.manifests){for(const child of d.manifests)visit(child,depth+1);return;}
  if(d.config)out.push({repository:repo,manifest:desc.digest,config:d.config.digest});
 }
 for(const d of JSON.parse(fs.readFileSync(index)).manifests)visit(d);
}
console.log(JSON.stringify(out));
"""


def assert_frozen():
    """El modo de snapshot final exige escritores detenidos, no una afirmación del cliente."""
    for name in ('agents-dev-server-1', 'agents-dev-web-1', 'agents-dev-whatsapp-1', 'agents-server-1'):
        if docker('inspect', name, '--format', '{{.State.Running}}').decode().strip() != 'false':
            raise ValueError('Escritor de origen todavía activo')
    for instance in ('dev', 'prod'):
        if docker('ps', '-q', '--filter', 'label=agents.instance=' + instance).strip():
            raise ValueError('Sandbox todavía activo')
    query = """select (select count(*) from runs where status in ('queued','starting','running','blocked'))+
        (select count(*) from messages where routed_at is null)+
        (select count(*) from webhook_deliveries where status='pending')+
        (select count(*) from agent_designs where busy_token is not null or validation_pending)+
        (select count(*) from dbos.workflow_status where status is null or status not in
         ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED'))+
        (select count(*) from pg_stat_activity where datname='agents' and backend_type='client backend'
          and pid<>pg_backend_pid());"""
    for container in ('agents-dev-postgres-1', 'agents-postgres-1'):
        if sql(container, query) != '0':
            raise ValueError('Trabajo pendiente en origen detenido; requiere recuperación')


def main(payload):
    os.umask(0o077)
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    report = {"run": run_id, "ok": False, "readyForCutover": False, "sourceChangedByPreparation": False,
              "snapshotConsistency": "online-rehearsal-only-not-a-coordinated-cutover-backup",
              "operatorSourceSha256": hashlib.sha256(''.join(payload.get(k, '') for k in ('program', 'worker', 'dbosWorker', 'copyWorker', 'signatureWorker', 'bootWorker', 'networkWorker', 'egressWorker')).encode()).hexdigest()}
    resources = []
    backup = None
    verified_daemon = False
    try:
        if payload["app"] != EXPECTED_APP or payload["tools"] != EXPECTED_TOOLS or payload["sandbox"] != EXPECTED_SANDBOX:
            raise ValueError("Referencias distintas de los artefactos auditados")
        if docker("info", "--format", "{{.Name}}|{{.ID}}").decode().strip() != "reko-3|13ec1fd9-550a-447e-9d33-6a834d309d3f":
            raise ValueError("Daemon distinto de reko-3")
        verified_daemon = True
        for image in (EXPECTED_TOOLS, EXPECTED_APP, EXPECTED_SANDBOX):
            docker("image", "inspect", image, "--format", "{{.Id}}")
        sandbox_id = docker("image", "inspect", EXPECTED_SANDBOX, "--format", "{{.Id}}").decode().strip()
        report["imageTransitionDecisionSha256"] = hashlib.sha256(json.dumps(payload["decision"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        report["phase"] = "read-only-inventory"
        report["before"] = metadata()
        dev = report["before"]["development"]
        if dev["test"] != [1]:
            raise ValueError("Test cambió")
        if payload["mode"] == "rehearse" and (dev["liveRuns"] or report["before"]["production"]["liveRuns"]):
            raise ValueError("Hay corridas activas; no se pausa ningún entorno")
        agents = dev["agents"]
        if not agents or any(a["volume"] != f"agents-dev-agent-{a['id']}" for a in agents):
            raise ValueError("Referencias de estado inesperadas")
        report["missingImages"] = []
        for image in sorted({a["image"] for a in agents if a["image"]}):
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
                raise ValueError("Pin no reconocido")
            try:
                docker("image", "inspect", image, "--format", "{{.Id}}")
            except RuntimeError:
                report["missingImages"].append(image)
        report["phase"] = "registry-inspection"
        registry = next(m for m in mounts("registry") if m["Destination"] == "/var/lib/registry")
        if registry["Type"] != "bind" or registry["Source"] != "/opt/platform/registry/data":
            raise ValueError("Montaje de registro inesperado")
        candidates = json.loads(helper(EXPECTED_TOOLS, run_id, [mount_arg(registry, "/registry")],
                                       "node", "-e", REGISTRY_SCAN, caps=True))
        report["registryCandidates"] = [c for c in candidates if
                                        c["manifest"] in report["missingImages"] or c["config"] in report["missingImages"]]
        report["registryManifestsExamined"] = len(candidates)
        report["phase"] = "published-signature-verification"
        signature_script = "process.env.AGENTS_SIGNATURE_CHECK='true';process.env.AGENTS_PUBLIC_KEY=" + json.dumps(payload["publicKey"]) + ";import('data:text/javascript;base64," + base64.b64encode(payload["signatureWorker"].encode()).decode() + "')"
        report["publishedSignatures"] = json.loads(helper(EXPECTED_TOOLS, run_id, [mount_arg(registry, "/registry")], "node", "-e", signature_script, caps=True))
        if payload["mode"] == "inspect":
            report["ok"] = True
            return report
        frozen = payload['mode'] == 'frozen-snapshot'
        if payload['mode'] not in ('rehearse', 'frozen-snapshot'):
            raise ValueError('Operación no autorizada')
        if frozen:
            approval = payload.get('transferAuthorization', {})
            if approval.get('id') != 'angel-transfer-beta1-2026-10-31' or approval.get('cutoverAuthorized') is not True or approval.get('localCoordinatedBackupAuthorized') is not True:
                raise ValueError('Snapshot final no autorizado')
            assert_frozen()
            report['snapshotConsistency'] = 'application-writers-stopped-coordinated-cutover-copy'
            report['frozenSourcesVerified'] = True
        parent = Path.home() / ".local/state/agents-migration"
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if parent.is_symlink() or parent.stat().st_mode & 0o077:
            raise ValueError("Directorio de respaldos no privado")
        if shutil.disk_usage(parent).free < 5 * 1024**3:
            raise ValueError("Menos de 5 GiB libres; se cancela")
        backup = parent / run_id
        backup.mkdir(mode=0o700)
        report["backupDirectory"] = str(backup)
        (backup / "status.json").write_text(json.dumps({"state": "running", "run": run_id}))
        (backup / "prepared").mkdir(mode=0o700)
        for label, container in (("development", "agents-dev-postgres-1"), ("production", "agents-postgres-1")):
            report["phase"] = "dump-" + label
            path = backup / (label + ".dump")
            with path.open("xb") as f:
                os.chmod(path, 0o600)
                docker("exec", "-e", "PGOPTIONS=" + RO, container, "pg_dump", "-U", "agents", "-d", "agents",
                       "-Fc", "--lock-wait-timeout=5s", output=f, timeout=180)
        dest = f"type=bind,src={backup},dst=/backup"
        files = [("/home/woz/dev/work/agents/.env.dev", "development.env"),
                 ("/etc/komodo/stacks/agents/.env", "production.env"),
                 ("/etc/komodo/stacks/agents/compose.yaml", "production.compose.yaml")]
        for source, name in files:
            report["phase"] = "backup-config-" + name
            helper(EXPECTED_TOOLS, run_id, [f"type=bind,src={source},dst=/input,readonly", dest],
                   "sh", "-c", f"umask 077; cp /input /backup/{name}; chmod 600 /backup/{name}", caps=True)
        report["phase"] = "effective-production-key-custody"
        custody_script = "process.env.AGENTS_BOOT_PROBE='custody';import('data:text/javascript;base64," + base64.b64encode(payload["bootWorker"].encode()).decode() + "')"
        effective_env = docker("inspect", "agents-server-1", "--format", "{{json .Config.Env}}")
        report["keyCustody"] = json.loads(helper(EXPECTED_APP, run_id,
            [f"type=bind,src={backup / 'production.env'},dst=/run/production.env,readonly"], "bun", "-e", custody_script, data=effective_env))
        del effective_env
        existing_volumes = set(docker("volume", "ls", "-q").decode().split())
        if any(f"agents-prod-beta1-agent-{a['id']}" in existing_volumes for a in agents):
            raise ValueError("Ya existe un destino reservado; no se sobrescribe")
        archives = []
        for a in agents:
            archives.append((f"agent-{a['id']}", {"Type": "volume", "Name": a["volume"]}))
        for container, prefix in (("agents-dev-server-1", "development"), ("agents-server-1", "production")):
            for m in mounts(container):
                if m["Destination"] in ("/data", "/cliproxy"):
                    archives.append((prefix + "-" + m["Destination"][1:], approved_data_mount(container, m)))
        report["archives"] = []
        for name, m in archives:
            report["phase"] = "archive-" + name
            helper(EXPECTED_TOOLS, run_id, [mount_arg(m, "/input"), dest],
                   "sh", "-c", f"umask 077; tar --numeric-owner --acls --xattrs -cpf /backup/{name}.tar -C /input .", caps=True)
            if frozen:
                helper(EXPECTED_TOOLS, run_id, [mount_arg(m, '/input'), dest],
                       'tar', '--acls', '--xattrs', '-df', '/backup/' + name + '.tar', '-C', '/input', caps=True)
            report["archives"].append(name)
        report["phase"] = "isolated-postgres"
        pg_image = docker("inspect", "agents-dev-postgres-1", "--format", "{{.Image}}").decode().strip()
        socket_volume = "agents-migration-" + run_id + "-socket"
        container = "agents-migration-" + run_id + "-postgres"
        docker("volume", "create", "--label", "agents.migration=" + run_id, socket_volume)
        resources.append(("volume", socket_volume))
        docker("run", "-d", "--rm", "--pull=never", "--name", container, "--network", "none",
               "--label", "agents.migration=" + run_id, "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
               "--pids-limit", "128", "--tmpfs", "/var/lib/postgresql:rw,nosuid,size=512m",
               "--mount", f"type=volume,src={socket_volume},dst=/var/run/postgresql,volume-nocopy",
               "-e", "POSTGRES_USER=agents", "-e", "POSTGRES_DB=agents_migration_rehearsal",
               "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "--entrypoint", "timeout", pg_image,
               "900", "/usr/local/bin/docker-entrypoint.sh", "postgres")
        resources.append(("container", container))
        for attempt in range(45):
            try:
                docker("exec", container, "pg_isready", "-U", "agents", "-d", "agents_migration_rehearsal", timeout=5)
                break
            except RuntimeError:
                time.sleep(1)
        else:
            raise RuntimeError("Postgres aislado no inició")
        docker("exec", container, "createdb", "-U", "agents", "-T", "template0", "agents_migration_existing")
        for label, database in (("development", "agents_migration_rehearsal"), ("production", "agents_migration_existing")):
            with (backup / (label + ".dump")).open("rb") as f:
                result = subprocess.run(DOCKER + ["exec", "-i", container, "pg_restore", "-U", "agents", "-d", database,
                                                 "--exit-on-error", "--no-owner", "--no-privileges"], stdin=f,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if result.returncode:
                    raise RuntimeError("Falló restauración aislada; no se muestran datos privados")
        worker_args = ["run", "--rm", "--pull=never", "--network", "none", "--read-only", "--cap-drop", "ALL",
                       "--security-opt", "no-new-privileges", "--cap-add", "DAC_READ_SEARCH", "--cap-add", "DAC_OVERRIDE", "--memory", "256m", "--memory-swap", "256m",
                       "--ulimit", "core=0", "--cpus", "1", "--pids-limit", "64",
                       "--label", "agents.migration=" + run_id,
                       "--mount", f"type=bind,src={backup},dst=/backup,readonly",
                       "--mount", f"type=bind,src={backup / 'prepared'},dst=/plan",
                       "--mount", f"type=volume,src={socket_volume},dst=/socket,readonly,volume-nocopy",
                       "-e", "AGENTS_MIGRATION_DBOS_MODULE=" + base64.b64encode(payload["dbosWorker"].encode()).decode(),
                       "-e", "AGENTS_MIGRATION_WORKER=true", "--entrypoint", "bun", EXPECTED_APP, "-e", payload["worker"]]
        report["phase"] = "probe-release-sandbox-before-image-transition"
        harness_rows = json.loads(docker("exec", container, "psql", "-X", "-U", "agents", "-d", "agents_migration_rehearsal", "-Atqc",
            "select json_agg(json_build_object('id',id,'harness',harness) order by id) from agents where person_id<>1"))
        report["proposedSandboxProbes"] = []
        for row in harness_rows:
            wrapper = "process.env.AGENTS_HARNESS=require('fs').readFileSync(0,'utf8');import('/opt/agents/harness-probe.mjs').catch(()=>process.exit(1));"
            raw = docker("run", "--rm", "-i", "--pull=never", "--network", "none", "--read-only", "--user", "agent",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--memory-swap", "512m",
                "--cpus", "1", "--pids-limit", "64", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
                "--label", "agents.migration=" + run_id, "--entrypoint", "node", EXPECTED_SANDBOX, "-e", wrapper,
                data=json.dumps(row["harness"]).encode(), timeout=40)
            markers = [line[len("AGENTS_HARNESS_PROBE "):] for line in raw.decode().splitlines() if line.startswith("AGENTS_HARNESS_PROBE ")]
            if len(markers) != 1:
                raise RuntimeError("Prueba sin resultado único")
            probe = json.loads(markers[0])
            if not probe.get("ok"):
                raise RuntimeError("Falló prueba aislada del harness")
            runtime = probe["runtime"]
            report["proposedSandboxProbes"].append({"agent": row["id"], "ok": True, "approved": False,
                "image": EXPECTED_SANDBOX, "imageId": sandbox_id,
                "inputSha256": hashlib.sha256(json.dumps(row["harness"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest(),
                "runtimeDigest": runtime["digest"], "toolCount": len(runtime["tools"])})
        transition = {"decision": payload["decision"], "probes": report["proposedSandboxProbes"], "imageId": sandbox_id}
        # Public decision/probe metadata only; no agent secret enters argv/environment.
        worker_args[worker_args.index("--entrypoint"):worker_args.index("--entrypoint")] = [
            "-e", "AGENTS_MIGRATION_TRANSITION=" + json.dumps(transition, separators=(",", ":"))]
        report["phase"] = "isolated-database-transform"
        report["databaseRehearsal"] = json.loads(docker(*worker_args, timeout=120))
        if not report["databaseRehearsal"].get("ok"):
            raise RuntimeError("Falló transformación aislada")
        report["phase"] = "recovery-from-prepared-dump"
        with (backup / "prepared.dump").open("xb") as f:
            docker("exec", "-e", "PGOPTIONS=" + RO, container, "pg_dump", "-U", "agents", "-d", "agents_migration_rehearsal", "-Fc", output=f, timeout=120)
        docker("exec", container, "createdb", "-U", "agents", "-T", "template0", "agents_migration_recovery")
        with (backup / "prepared.dump").open("rb") as f:
            result = subprocess.run(DOCKER + ["exec", "-i", container, "pg_restore", "-U", "agents", "-d", "agents_migration_recovery",
                "--exit-on-error", "--no-owner", "--no-privileges"], stdin=f, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            if result.returncode:
                raise RuntimeError("Falló recuperación del destino preparado")
        fingerprint_sql = r"""do $$ declare t record; h text; begin
          create temporary table migration_hashes(name text, hash text);
          for t in select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') and schemaname not like 'pg_%' order by 1,2 loop
            execute format('select md5(coalesce(string_agg(to_jsonb(x)::text,''|'' order by to_jsonb(x)::text),'''')) from %I.%I x',t.schemaname,t.tablename) into h;
            insert into migration_hashes values(t.schemaname||'.'||t.tablename,h);
          end loop; end $$;
          select json_agg(json_build_object('table',name,'hash',hash) order by name) from migration_hashes;"""
        fingerprints = []
        for database in ("agents_migration_rehearsal", "agents_migration_recovery"):
            raw = docker("exec", "-i", container, "psql", "-X", "-qAt", "-U", "agents", "-d", database, "-v", "ON_ERROR_STOP=1", data=fingerprint_sql.encode())
            fingerprints.append(json.loads(raw))
        if fingerprints[0] != fingerprints[1]:
            raise RuntimeError("Recuperación de datos no idéntica")
        report["preparedRecovery"] = {"ok": True, "tablesCompared": len(fingerprints[0]), "allRowsIdentical": True}
        if frozen:
            # Datos derivados privados, sólo en reko-3 para comparar el destino ANTES de arrancarlo.
            (backup / 'prepared/fingerprints.json').write_text(json.dumps(fingerprints[0]))
        # Restore every archive into its OWN disposable volume and compare content+metadata.
        report["archivesVerified"] = []
        for index, name in enumerate(report["archives"]):
            report["phase"] = "restore-compare-" + name
            volume = "agents-migration-" + run_id + f"-copy-{index}"
            docker("volume", "create", "--label", "agents.migration=" + run_id, volume)
            resources.append(("volume", volume))
            helper(EXPECTED_TOOLS, run_id,
                   [f"type=bind,src={backup},dst=/backup,readonly", f"type=volume,src={volume},dst=/copy,volume-nocopy"],
                   "sh", "-c", f"tar --acls --xattrs -xpf /backup/{name}.tar -C /copy && tar --acls --xattrs -df /backup/{name}.tar -C /copy", caps=True)
            report["archivesVerified"].append(name)
            if name == "development-data":
                filtered = "agents-migration-" + run_id + "-filtered-data"
                docker("volume", "create", "--label", "agents.migration=" + run_id, filtered)
                resources.append(("volume", filtered))
                report["phase"] = "filtered-application-data"
                script = "process.env.AGENTS_FILTERED_COPY='true';import('data:text/javascript;base64," + base64.b64encode(payload["copyWorker"].encode()).decode() + "')"
                report["filteredData"] = json.loads(helper(EXPECTED_TOOLS, run_id,
                    [f"type=volume,src={volume},dst=/source,readonly,volume-nocopy", f"type=volume,src={filtered},dst=/destination,volume-nocopy",
                     f"type=bind,src={backup / 'prepared'},dst=/plan,readonly"], "node", "-e", script, caps=True))
                report["phase"] = "published-app-isolated-boot"
                probe = "agents-migration-" + run_id + "-app"
                app_script = "import('data:text/javascript;base64," + base64.b64encode(payload["bootWorker"].encode()).decode() + "')"
                app_args = ["run", "-d", "--pull=never", "--name", probe, "--label", "agents.migration=" + run_id,
                    "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "128",
                    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--tmpfs", "/cliproxy:rw,nosuid,nodev,size=4m",
                    "--mount", f"type=volume,src={socket_volume},dst=/socket,readonly,volume-nocopy",
                    "--mount", f"type=volume,src={filtered},dst=/data,volume-nocopy",
                    "--mount", f"type=bind,src={backup / 'production.env'},dst=/run/production.env,readonly",
                    "-e", "AGENTS_BOOT_PROBE=server", "-e", "AGENTS_INSTANCE=" + run_id,
                    "-e", "AGENTS_DATABASE_URL=postgres://agents@localhost/agents_migration_recovery?host=/socket",
                    "-e", "AGENTS_CLIPROXY_CONFIG=/cliproxy/config.yaml", "-e", "AGENTS_CLIPROXY_URL=http://127.0.0.1:8317",
                    "-e", "AGENTS_PUBLIC_URL=https://agents.cubytest.space", "-e", "AGENTS_APP_VERSION=v2",
                    "-e", "AGENTS_RELEASE_VERSION=0.0.1-beta", "-e", "AGENTS_RELEASE_SHA=f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3",
                    "--entrypoint", "bun", EXPECTED_APP, "-e", app_script]
                docker(*app_args)
                resources.append(("container", probe))
                try:
                    for attempt in range(40):
                        try:
                            docker("exec", probe, "bun", "-e", "if(!(await fetch('http://127.0.0.1:8787/healthz')).ok)process.exit(1)", timeout=5)
                            break
                        except RuntimeError:
                            if docker("inspect", probe, "--format", "{{.State.Running}}").decode().strip() != "true":
                                raise RuntimeError("App de ensayo terminó antes de salud")
                            time.sleep(1)
                    else:
                        raise RuntimeError("App no saludable dentro del límite")
                    report["phase"] = "published-app-private-access"
                    report["applicationBoot"] = json.loads(docker("exec", "-e", "AGENTS_BOOT_PROBE=verify", probe, "bun", "-e", app_script))
                finally:
                    with (backup / "prepared/app.log").open("xb") as log:
                        # Potentially private app logs stay only on reko-3.
                        subprocess.run(DOCKER + ["logs", probe], stdout=log, stderr=log, timeout=10)
                    docker("container", "rm", "-f", probe)
                    resources.remove(("container", probe))
                docker("volume", "rm", filtered)
                resources.remove(("volume", filtered))
            docker("volume", "rm", volume)
            resources.remove(("volume", volume))
        report["phase"] = "production-backend-readonly-proxy-check"
        network_script = "import('data:text/javascript;base64," + base64.b64encode(payload["networkWorker"].encode()).decode() + "')"
        report["proxyNetwork"] = json.loads(docker("run", "--rm", "--pull=never", "--network", "agents-prod-internal" if frozen else "container:agents-server-1",
            "--label", "agents.migration=" + run_id, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5", "--pids-limit", "64",
            "--mount", f"type=volume,src={socket_volume},dst=/socket,readonly,volume-nocopy",
            "--mount", f"type=bind,src={backup / 'production.env'},dst=/run/production.env,readonly",
            "-e", "AGENTS_NETWORK_PROBE_NAMESPACE=" + ('production-internal-before-cutover' if frozen else 'production-server'),
            "-e", "AGENTS_BOOT_MODULE=" + base64.b64encode(payload["bootWorker"].encode()).decode(),
            "-e", "AGENTS_RESTORE_MODULE=" + base64.b64encode(payload["worker"].encode()).decode(),
            "--entrypoint", "bun", EXPECTED_APP, "-e", network_script, timeout=90))
        if not report["proxyNetwork"]["ok"]:
            raise RuntimeError("Proxies/modelos requieren atención; no se modifica configuración")
        if frozen:
            report['sandboxEgress'] = {'deferredUntilTargetStarted': True, 'tested': False}
            assert_frozen()
        else:
            report["phase"] = "production-sandbox-egress-check"
            egress = docker("run", "--rm", "--pull=never", "--network", "agents-prod-sandbox", "--dns", "1.1.1.1",
                "--label", "agents.migration=" + run_id, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--user", "agent", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "--pids-limit", "32",
                "-e", "SERVER=agents-prod-server", "--entrypoint", "bash", EXPECTED_SANDBOX, "-c", payload["egressWorker"], timeout=60)
            report["sandboxEgress"] = {"ok": True, "checks": egress.decode().splitlines(), "secretsMounted": False}
        report["after"] = metadata()
        activity = ("liveRuns", "pendingMessages", "pendingDeliveries", "dbosStatuses")
        stable = lambda snapshots: {env: {k: v for k, v in values.items() if k not in activity} for env, values in snapshots.items()}
        report["liveMetadataUnchanged"] = stable(report["before"]) == stable(report["after"])
        report["liveActivityMayContinue"] = not frozen
        checksum_code = """const fs=require('fs'),crypto=require('crypto'),out={};
for(const n of fs.readdirSync('/backup').filter(n=>/^[a-z0-9-]+\\.(tar|dump)$/.test(n))){
 const h=crypto.createHash('sha256'),fd=fs.openSync('/backup/'+n,'r'),b=Buffer.alloc(1048576);let len;
 try{while((len=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,len));}finally{fs.closeSync(fd);}
 out[n]=h.digest('hex');} console.log(JSON.stringify(out));"""
        report["backupChecksums"] = json.loads(helper(EXPECTED_TOOLS, run_id,
            [f"type=bind,src={backup},dst=/backup,readonly"], "node", "-e", checksum_code, caps=True))
        report["phase"] = "complete"
        report["ok"] = report["liveMetadataUnchanged"]
        return report
    except Exception as error:
        report["failureType"] = type(error).__name__
        if isinstance(error, RuntimeError) and re.fullmatch(r"(?:permission denied|operation not permitted|no such file|unknown flag|subprocess): exit -?\d+", str(error)):
            report["failureClass"] = str(error)
        # Errors intentionally exclude values, full commands, paths within profiles and DB error details.
        return report
    finally:
        report["cleanupFailures"] = []
        for kind, name in reversed(resources):
            try:
                fmt = "{{index .Labels \"agents.migration\"}}" if kind == "volume" else "{{index .Config.Labels \"agents.migration\"}}"
                owner = docker(kind, "inspect", name, "--format", fmt).decode().strip()
                if owner != run_id:
                    raise RuntimeError("Recurso ajeno; no se borra")
                docker(kind, "rm", *( ["-f"] if kind == "container" else []), name)
            except Exception:
                report["cleanupFailures"].append(name)
                report["ok"] = False
        # Catch helper containers left behind if an attached Docker client timed out.
        for kind in (("container", "volume") if verified_daemon else ()):
            try:
                command = ["ps", "-a"] if kind == "container" else ["volume", "ls"]
                ids = docker(*command, "--filter", "label=agents.migration=" + run_id, "-q").decode().split()
                for name in ids:
                    fmt = "{{index .Labels \"agents.migration\"}}" if kind == "volume" else "{{index .Config.Labels \"agents.migration\"}}"
                    if docker(kind, "inspect", name, "--format", fmt).decode().strip() != run_id:
                        raise RuntimeError("Recurso ajeno")
                    docker(kind, "rm", *(["-f"] if kind == "container" else []), name)
            except Exception:
                report["cleanupFailures"].append("label-sweep-" + kind)
                report["ok"] = False
        if backup:
            (backup / "status.json").write_text(json.dumps(report, indent=2))


if "payload" in globals():
    print(json.dumps(main(payload)))
