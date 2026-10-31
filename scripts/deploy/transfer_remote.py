"""Operación puntual beta1 en reko-3. Sólo se carga mediante el entrypoint visible."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import types
import urllib.error
import urllib.request

ROOT = Path.home() / '.local/state/agents-transfer'
WRITERS = ('agents-dev-whatsapp-1', 'agents-dev-web-1', 'agents-dev-server-1', 'agents-server-1')
INFRA = ('agents-postgres-1', 'agents-cliproxy-1', 'agents-backup-1', 'agents-dev-postgres-1', 'agents-dev-cliproxy-1')
FINGERPRINT_SQL = """do $$ declare t record; h text; begin
create temporary table migration_hashes(name text,hash text);
for t in select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') and schemaname not like 'pg_%' order by 1,2 loop
execute format('select md5(coalesce(string_agg(to_jsonb(x)::text,''|'' order by to_jsonb(x)::text),'''')) from %I.%I x',t.schemaname,t.tablename) into h;
insert into migration_hashes values(t.schemaname||'.'||t.tablename,h); end loop; end $$;
select json_agg(json_build_object('table',name,'hash',hash) order by name) from migration_hashes;"""


def approved(p):
    a = p.get('transferAuthorization', {})
    return (a.get('id') == 'angel-transfer-beta1-2026-10-31' and a.get('cutoverAuthorized') is True
            and a.get('localCoordinatedBackupAuthorized') is True and a.get('enableS3') is False
            and a.get('preserveOriginalDatabasesAndVolumes') is True
            and a.get('excludeTestOnlyAtDestination') is True and a.get('preserveSeparateProductionIdentity') is True
            and a.get('realInferenceAcceptanceAuthorized') is False
            and a.get('releaseSha') == 'f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3'
            and p.get('deploymentEnabled') is True)


class Transfer:
    def __init__(self, p):
        self.p = p
        if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{8}', p['transferRun']):
            raise ValueError('Identidad de operación inválida')
        self.run = p['transferRun']
        self.directory = ROOT / self.run
        self.state = {'run': self.run, 'ok': False, 'phase': 'created', 'bootAttempted': False,
                      's3Enabled': False, 'newBackupScheduleCreated': False,
                      'operatorSha': p['operatorSha'], 'authorization': p['transferAuthorization']['id']}
        if (self.directory / 'status.json').exists():
            self.state = json.loads((self.directory / 'status.json').read_text())
        self.core = types.ModuleType('agents_snapshot')
        exec(compile(p['program'], 'agents_snapshot', 'exec'), self.core.__dict__)
        self.docker = self.core.docker
        self.backup = Path(self.state['backupDirectory']) if self.state.get('backupDirectory') else None
        self.token = None
        self.env = None

    def save(self, phase, **extra):
        self.state.update(phase=phase, **extra)
        tmp = self.directory / 'status.tmp'
        with tmp.open('w') as f:
            json.dump(self.state, f, indent=2); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, self.directory / 'status.json')
        fd = os.open(self.directory, os.O_RDONLY); os.fsync(fd); os.close(fd)
        print(json.dumps({'run': self.run, 'phase': phase, 'ok': self.state['ok']}), flush=True)

    def api(self, group, kind, params):
        headers = {'Content-Type': 'application/json'}
        if self.token: headers['Authorization'] = self.token
        request = urllib.request.Request('https://komodo.cubytest.space/' + group + '/' + kind,
            data=json.dumps(params).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)  # Nunca se exporta la respuesta cruda de Komodo.

    def login(self):
        login = self.api('auth/login', 'LoginLocalUser', self.p.pop('credential'))
        self.token = login.get('jwt') or (login.get('data') or {}).get('jwt')
        if not self.token: raise ValueError('Login sin JWT; no se elude segundo factor')

    def inspect(self, name):
        return json.loads(self.docker('inspect', name))[0]  # Config.Env permanece en reko-3.

    def infrastructure(self):
        return {n: {'id': x['Id'], 'started': x['State']['StartedAt']} for n in INFRA for x in [self.inspect(n)]}

    def helper(self, mounts, *args, **kw):
        return self.core.helper(self.p['tools'], self.run, mounts, *args, **kw)

    def private_file(self, path):
        return self.helper([f'type=bind,src={path},dst=/input,readonly'], 'node', '-e',
            "process.stdout.write(require('fs').readFileSync('/input'))", caps=True)

    def compose(self, file, *args):
        command = self.core.DOCKER + ['compose', '--project-name', 'agents', '--project-directory',
            '/etc/komodo/stacks/agents', '--env-file', '/dev/null', '-f', str(file), *args]
        r = subprocess.run(command, env={**os.environ, **self.env}, capture_output=True, timeout=120)
        if r.returncode: raise RuntimeError('compose-failed-private-details-omitted')
        return r.stdout

    def query_target(self, query):
        return self.docker('exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=off -c statement_timeout=120s -c lock_timeout=5s',
            'agents-postgres-1', 'psql', '-X', '-qAt', '-U', 'agents', '-d', 'agents_beta1', '-v', 'ON_ERROR_STOP=1',
            data=query.encode(), timeout=140).decode().strip()

    def audit(self):
        if not approved(self.p): raise ValueError('Falta autorización específica o gate de despliegue')
        if self.docker('info', '--format', '{{.Name}}|{{.ID}}').decode().strip() != 'reko-3|13ec1fd9-550a-447e-9d33-6a834d309d3f':
            raise ValueError('Daemon no autorizado')
        for image in (self.core.EXPECTED_APP, self.core.EXPECTED_SANDBOX, self.core.EXPECTED_TOOLS):
            self.docker('image', 'inspect', image)
        self.login()
        stack = self.api('read', 'GetStack', {'stack': 'agents'})
        config = stack['config']
        if stack['name'] != 'agents' or config['server_id'] != '6aa97dc3daaf3ef3a2d2580c' or config['auto_update'] or config.get('repo') or not config.get('file_contents'):
            raise ValueError('Stack gestionado distinto del auditado')
        self.stack = stack
        self.old_text = self.private_file('/etc/komodo/stacks/agents/compose.yaml').decode()
        # Sólo las variables referenciadas por ambos Compose; no cargar secretos S3 ajenos.
        names = sorted(set(re.findall(r'(?<!\$)\$\{([A-Z][A-Z0-9_]+)', self.old_text + self.p['candidate'])))
        self.state['composeVariableNames'] = names
        if any(not n.startswith('AGENTS_') and n != 'IMAGE_TAG' for n in names): raise ValueError('Variable Compose desconocida')
        code = "const fs=require('fs');const text=fs.readFileSync('/input','utf8');const out={};for(const name of " + json.dumps(names) + ") {const lines=text.split('\\n').filter(l=>l.startsWith(name+'='));if(!lines.length)continue;if(lines.length!==1)throw Error('env');let v=lines[0].slice(name.length+1).trim();if((v.startsWith('\\\"')&&v.endsWith('\\\"'))||(v.startsWith(\"'\")&&v.endsWith(\"'\")))v=v.slice(1,-1);out[name]=v;}console.log(JSON.stringify(out));"
        self.env = json.loads(self.helper(['type=bind,src=/etc/komodo/stacks/agents/.env,dst=/input,readonly'], 'node', '-e', code, caps=True))
        old = self.directory / 'current.compose.yaml'; old.write_text(self.old_text)
        new = self.directory / 'candidate.compose.yaml'; new.write_text(self.p['candidate'])
        a = json.loads(self.compose(old, 'config', '--format', 'json'))
        # El respaldo automatizado quedó pendiente: conservar ÍNTEGRO el servicio actual.
        # Compose acepta JSON como YAML. --no-interpolate conserva referencias, nunca valores secretos.
        raw_old = json.loads(self.compose(old, 'config', '--no-interpolate', '--format', 'json'))
        raw_new = json.loads(self.compose(new, 'config', '--no-interpolate', '--format', 'json'))
        raw_new['services']['backup'] = raw_old['services']['backup']
        self.effective_candidate = json.dumps(raw_new, indent=2)
        new.write_text(self.effective_candidate)
        b = json.loads(self.compose(new, 'config', '--format', 'json'))
        if a['services']['backup'] != b['services']['backup']: raise ValueError('Backup actual no se conserva íntegro')
        self.state['effectiveComposeSha256'] = hashlib.sha256(self.effective_candidate.encode()).hexdigest()
        self.state['existingDailyBackupStillTargetsOriginalDatabase'] = True
        for service in ('postgres', 'cliproxy'):
            if a['services'][service] != b['services'][service]: raise ValueError('Infraestructura divergente')
        if a['networks'] != b['networks'] or a['services']['server']['labels'] != b['services']['server']['labels']:
            raise ValueError('Red/routing divergentes')
        for field in ('image', 'restart', 'volumes', 'networks'):
            if a['services']['backup'][field] != b['services']['backup'][field]: raise ValueError('Backup existente divergente')
        old.unlink()  # La copia completa definitiva se guarda después del freeze, dentro del backup.
        dbs = self.core.sql('agents-postgres-1', "select count(*) from pg_database where datname='agents_beta1'")
        if dbs != '0': raise ValueError('DB destino ya existe; reconciliar, no sobrescribir')
        for i in range(10, 19):
            r = subprocess.run(self.core.DOCKER + ['volume', 'inspect', f'agents-prod-beta1-agent-{i}'], capture_output=True)
            if not r.returncode: raise ValueError('Volumen destino ya existe')
        probe = "const fs=require('fs');for(const p of ['/root/releases','/root/releases/beta1']){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('symlink');}console.log(JSON.stringify({absent:!fs.existsSync('/root/releases/beta1')}));"
        exists = json.loads(self.helper(['type=bind,src=/srv/agents,dst=/root,readonly'], 'node', '-e', probe, caps=True))
        if not exists['absent']: raise ValueError('Directorio destino ya existe')
        meta = self.core.metadata()
        if meta['development']['people'] != 7 or meta['development']['test'] != [1] or [a['id'] for a in meta['development']['agents']] != list(range(10, 19)) or meta['production']['people'] != 1 or meta['production']['agents']:
            raise ValueError('Cambió alcance/identidad de origen o destino')
        self.state['writers'] = {n: {'id': x['Id'], 'running': x['State']['Running']} for n in WRITERS for x in [self.inspect(n)]}
        if not all(x['running'] for x in self.state['writers'].values()): raise ValueError('Servicios no están en estado inicial esperado')
        self.state['infra'] = self.infrastructure()
        self.state['oldStackSha256'] = hashlib.sha256(config['file_contents'].encode()).hexdigest()
        self.drained()
        self.state['hostWriterPreflight'] = self.external_writers(enforce=False)
        self.save('preflight-verified')

    def drained(self):
        # core.sql ya fija agents + default_transaction_read_only=on. Evitar el tag DO en stdout.
        query = 'SELECT' + self.p['drainSql'].split('SELECT', 1)[1]
        for container in ('agents-dev-postgres-1', 'agents-postgres-1'):
            data = json.loads(self.core.sql(container, query))
            if any(data[k] != 0 for k in ('liveRuns', 'pendingMessages', 'pendingDeliveries', 'busyDesigns')):
                raise ValueError('Trabajo pendiente; no se cancela para fabricar drenado')
            if any(x['status'] not in ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED') for x in data['dbosStatuses']):
                raise ValueError('DBOS no terminal')
        for instance in ('dev', 'prod'):
            if self.docker('ps', '-q', '--filter', 'label=agents.instance=' + instance).strip(): raise ValueError('Sandbox activo')
        # Detectar también montajes del estado real por procesos sin esos labels.
        for x in json.loads(self.docker('ps', '-q').strip() and self.docker('inspect', *self.docker('ps', '-q').decode().split()) or b'[]'):
            for m in x.get('Mounts', []):
                if m.get('Name') in {f'agents-dev-agent-{i}' for i in range(10,19)}:
                    raise ValueError('Escritor de perfil real todavía activo')

    def external_writers(self, enforce=True):
        mounts=['type=bind,src=/proc,dst=/hostproc,readonly']
        for i in range(10,19):
            mounts.append(f'type=volume,src=agents-dev-agent-{i},dst=/sources/agent-{i},readonly,volume-nocopy')
        for name in ('agents-dev-server-1','agents-server-1'):
            source=next(m for m in self.core.mounts(name) if m['Destination']=='/data')
            self.core.approved_data_mount(name,source)
            mounts.append(self.core.mount_arg(source,'/sources/'+name))
        args=['run','--rm','--pull=never','--network','none','--pid','host','--read-only','--cap-drop','ALL',
              '--cap-add','SYS_PTRACE','--cap-add','DAC_READ_SEARCH','--cap-add','DAC_OVERRIDE',
              '--security-opt','no-new-privileges','--security-opt','apparmor=unconfined',
              '--memory','256m','--cpus','1','--pids-limit','32','--label','agents.transferHelper='+self.run]
        for mount in mounts: args.extend(['--mount',mount])
        result=json.loads(self.docker(*args,'--entrypoint','timeout',self.p['tools'],'80','node','-e',self.p['writerWorker'],timeout=90))
        if result['minimumFreeBytes'] < result['sourceBytes'] * 3 + 2 * 1024**3: raise ValueError('Espacio libre insuficiente para snapshot y destinos')
        if result['inaccessible'] or (enforce and result['writers']): raise ValueError('Inspección de escritores externos incompleta o no drenada')
        return result

    def maintenance(self):
        name = 'agents-transfer-' + self.run
        self.save('maintenance-attempt', maintenance=name)
        code = "Bun.serve({port:8787,fetch(){return new Response('Agents en mantenimiento temporal',{status:503,headers:{'Cache-Control':'no-store','Retry-After':'60','X-Agents-Maintenance':process.env.RUN}})}})"
        self.docker('run', '-d', '--name', name, '--pull=never', '--network', 'proxy', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '32', '--log-driver', 'none',
            '--label', 'agents.transfer=' + self.run, '--label', 'traefik.enable=true', '--label', 'traefik.docker.network=proxy',
            '--label', 'traefik.http.routers.agents-transfer.rule=Host(`agents.cubytest.space`) || Host(`agents-dev.cubytest.space`)',
            '--label', 'traefik.http.routers.agents-transfer.entrypoints=websecure', '--label', 'traefik.http.routers.agents-transfer.priority=1000000',
            '--label', 'traefik.http.routers.agents-transfer.service=agents-transfer', '--label', 'traefik.http.services.agents-transfer.loadbalancer.server.port=8787',
            '-e', 'RUN=' + self.run, '--entrypoint', 'bun', self.p['app'], '-e', code)
        self.state['maintenance'] = name
        for attempt in range(25):
            passed = []
            for host in ('agents.cubytest.space', 'agents-dev.cubytest.space'):
                try: urllib.request.urlopen('https://' + host + '/', timeout=5); passed.append(False)
                except urllib.error.HTTPError as e: passed.append(e.code == 503 and e.headers.get('X-Agents-Maintenance') == self.run)
            if all(passed): break
            time.sleep(1)
        else: raise ValueError('Mantenimiento no comprobado en ambos hosts')
        self.save('freeze-attempt')
        self.docker('stop', '--time', '30', self.state['writers']['agents-dev-whatsapp-1']['id'], timeout=40)
        self.drained()
        self.docker('stop', '--time', '60', *[self.state['writers'][n]['id'] for n in WRITERS if n != 'agents-dev-whatsapp-1'], timeout=80)
        self.core.assert_frozen(); self.drained()
        self.save('frozen-verified', frozenStorageWriters=self.external_writers())

    def snapshot(self):
        self.save('coordinated-backup-attempt')
        r = self.core.main({**self.p, 'mode': 'frozen-snapshot'})
        self.state['snapshotRun'] = r['run']
        if r.get('backupDirectory'): self.state['backupDirectory'] = r['backupDirectory']
        if not r['ok'] or r['cleanupFailures'] or not r.get('frozenSourcesVerified'):
            self.save('coordinated-backup-failed', snapshotPhase=r.get('phase')); raise ValueError('Snapshot/ensayo final falló')
        self.backup = Path(r['backupDirectory'])
        (self.backup / 'transfer-preparation.json').write_text(json.dumps(r, indent=2))
        (self.backup / 'original-komodo-stack.json').write_text(json.dumps(self.stack))
        self.state['preserved'] = r['databaseRehearsal']
        self.state['backupChecksums'] = r['backupChecksums']
        self.save('coordinated-backup-verified')

    def stage(self):
        self.core.assert_frozen()
        self.state['storageWritersBeforeStage']=self.external_writers()
        self.save('stage-target-attempt')
        self.helper(['type=bind,src=/srv/agents,dst=/root'], 'node', '-e',
            "const fs=require('fs');if(fs.existsSync('/root/releases')&&fs.lstatSync('/root/releases').isSymbolicLink())throw Error('symlink');fs.mkdirSync('/root/releases',{recursive:true,mode:0o700});fs.mkdirSync('/root/releases/beta1',{mode:0o700});fs.mkdirSync('/root/releases/beta1/data',{mode:0o700})", caps=True)
        for i in range(10,19):
            name = f'agents-prod-beta1-agent-{i}'
            self.docker('volume','create','--label','agents.transfer='+self.run,name)
            self.helper([f'type=bind,src={self.backup},dst=/backup,readonly',f'type=volume,src={name},dst=/copy,volume-nocopy'],
                'sh','-c',f'tar --acls --xattrs -xpf /backup/agent-{i}.tar -C /copy && tar --acls --xattrs -df /backup/agent-{i}.tar -C /copy',caps=True)
        tmp = 'agents-transfer-' + self.run + '-data'
        self.docker('volume','create','--label','agents.transfer='+self.run,tmp)
        try:
            self.helper([f'type=bind,src={self.backup},dst=/backup,readonly',f'type=volume,src={tmp},dst=/copy,volume-nocopy'],
                'tar','--acls','--xattrs','-xpf','/backup/development-data.tar','-C','/copy',caps=True)
            script = "process.env.AGENTS_FILTERED_COPY='true';import('data:text/javascript;base64," + base64.b64encode(self.p['copyWorker'].encode()).decode() + "')"
            self.state['dataCopy'] = json.loads(self.helper([f'type=volume,src={tmp},dst=/source,readonly,volume-nocopy',
                'type=bind,src=/srv/agents/releases/beta1/data,dst=/destination',f'type=bind,src={self.backup}/prepared,dst=/plan,readonly'],
                'node','-e',script,caps=True))
        finally: self.docker('volume','rm',tmp)
        self.docker('exec','-e','PGOPTIONS=-c default_transaction_read_only=off','agents-postgres-1','createdb','-U','agents','-T','template0','agents_beta1')
        with (self.backup / 'prepared.dump').open('rb') as f:
            r = subprocess.run(self.core.DOCKER + ['exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=off -c statement_timeout=120s',
                'agents-postgres-1','pg_restore','-U','agents','-d','agents_beta1','--exit-on-error','--no-owner','--no-privileges'],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=150)
            if r.returncode: raise ValueError('Restauración destino falló; detalles privados omitidos')
        if json.loads(self.query_target(FINGERPRINT_SQL)) != json.loads((self.backup/'prepared/fingerprints.json').read_text()):
            raise ValueError('Destino no idéntico al dump preparado')
        schedules = json.loads(self.query_target("select coalesce(json_agg(json_build_object('name',schedule_name,'status',status) order by schedule_name),'[]') from dbos.workflow_schedules"))
        if any(x['status'] not in ('ACTIVE','PAUSED') or not re.fullmatch(r'agent:\d+:[a-f0-9]+',x['name']) for x in schedules): raise ValueError('Agenda inesperada')
        (self.backup/'prepared/original-schedule-statuses.json').write_text(json.dumps(schedules))
        self.query_target("update dbos.workflow_schedules set status='PAUSED'")
        self.save('target-verified-before-boot', tablesIdenticalBeforeBoot=True, profilesCopied=9)

    def activate(self):
        if time.monotonic() - self.start > 840: raise ValueError('Presupuesto de ventana agotado antes de arranque')
        self.core.assert_frozen()
        if self.private_file('/etc/komodo/stacks/agents/compose.yaml').decode() != self.old_text:
            raise ValueError('Compose privado cambió durante ventana')
        if self.private_file('/etc/komodo/stacks/agents/.env') != self.private_file(self.backup/'production.env'):
            raise ValueError('Environment privado cambió desde snapshot')
        old_env=dict(v.split('=',1) for v in self.inspect('agents-server-1')['Config']['Env'])
        if any(old_env[k] != self.env[k] for k in ('AGENTS_MASTER_KEY','AGENTS_ADMIN_PIN','AGENTS_PROXY_KEY')):
            raise ValueError('Llaves/PIN privados difieren del preflight')
        self.save('managed-stack-update-attempt', managedStackUpdateAttempted=True)
        original = self.stack['config']
        latest = self.api('read','GetStack',{'stack':'agents'})
        if latest['config'] != original: raise ValueError('Stack cambió durante ventana')
        sid = self.stack['_id']['$oid'] if isinstance(self.stack['_id'],dict) else self.stack['_id']
        self.api('write','UpdateStack',{'id':sid,'config':{'file_contents':self.effective_candidate}})
        after = self.api('read','GetStack',{'stack':'agents'})['config']
        if after != {**original, 'file_contents':self.effective_candidate}: raise ValueError('Cambio gestionado no acotado')
        self.state['managedStackChanged'] = True
        self.helper(['type=bind,src=/etc/komodo/stacks/agents,dst=/stack'], 'node','-e',
            "const fs=require('fs');const b=fs.readFileSync(0);fs.writeFileSync('/stack/compose.transfer.tmp',b,{mode:0o600,flag:'wx'});fs.renameSync('/stack/compose.transfer.tmp','/stack/compose.yaml')",caps=True,data=self.effective_candidate.encode())
        self.save('target-boot-attempt', bootAttempted=True)
        self.compose(self.directory/'candidate.compose.yaml','up','-d','--no-deps','--no-build','--pull','never','server')
        for _ in range(60):
            try:
                self.docker('exec','agents-server-1','bun','-e',"const r=await fetch('http://127.0.0.1:8787/healthz');const j=await r.json();if(!j.ready||j.sha!=='f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3')process.exit(1)",timeout=5);break
            except RuntimeError:
                if not self.inspect('agents-server-1')['State']['Running']: raise ValueError('Destino terminó antes de salud')
                time.sleep(1)
        else: raise ValueError('Destino no saludable')
        runtime = self.inspect('agents-server-1')
        actual_env = dict(v.split('=',1) for v in runtime['Config']['Env'])
        if runtime['Config']['Image'] != self.p['app'] or not actual_env['AGENTS_DATABASE_URL'].endswith('/agents_beta1'):
            raise ValueError('Imagen/DB efectiva distinta')
        if any(actual_env[k] != self.env[k] for k in ('AGENTS_MASTER_KEY','AGENTS_ADMIN_PIN','AGENTS_PROXY_KEY')):
            raise ValueError('Llave/PIN/proxy efectiva cambió')
        verify = "import('data:text/javascript;base64," + base64.b64encode(self.p['acceptWorker'].encode()).decode() + "')"
        self.state['acceptance'] = json.loads(self.docker('exec','-e','AGENTS_RESTORE_MODULE='+base64.b64encode(self.p['worker'].encode()).decode(),
            'agents-server-1','bun','-e',verify,timeout=60))
        if not self.state['acceptance'].get('ok') or self.state['acceptance']['fieldsDecrypted'] != self.state['preserved']['secretsReencrypted']:
            raise ValueError('Validación de destino o cifrados falló')
        egress = self.docker('run','--rm','--pull=never','--network','agents-prod-sandbox','--dns','1.1.1.1','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--label','agents.transfer='+self.run,'--user','agent','--memory','128m','--pids-limit','32',
            '-e','SERVER=agents-prod-server','--entrypoint','bash',self.p['sandbox'],'-c',self.p['egressWorker'],timeout=60)
        self.state['sandboxEgress'] = {'ok':True,'checks':egress.decode().splitlines()}
        if self.infrastructure() != self.state['infra']: raise ValueError('Infraestructura fue recreada inesperadamente')
        # No reiniciar ni repuntar el backup existente: la automatización para beta1 sigue pendiente.
        self.state['existingDailyBackupDatabaseUpdated'] = False
        # Las agendas sólo se restauran después de verificar que el origen sigue detenido.
        for name in ('agents-dev-server-1','agents-dev-web-1','agents-dev-whatsapp-1'):
            if self.inspect(name)['State']['Running']: raise ValueError('Origen reactivado')
        schedules = json.loads((self.backup/'prepared/original-schedule-statuses.json').read_text())
        literal = json.dumps(schedules).replace("'", "''")
        self.query_target("update dbos.workflow_schedules s set status=x.status from jsonb_to_recordset('"+literal+"'::jsonb) as x(name text,status text) where s.schedule_name=x.name")
        self.save('admission-attempt', schedulesRestored=len(schedules), realBrowserLoginTested=False, acceptanceInferenceRequests=0)
        self.remove_maintenance()
        health={}
        for _ in range(15):
            try:
                with urllib.request.urlopen('https://agents.cubytest.space/healthz',timeout=5) as r: health=json.load(r)
                if health.get('sha') == self.p['transferAuthorization']['releaseSha'] and health.get('ready'): break
            except (urllib.error.HTTPError,urllib.error.URLError): pass
            time.sleep(1)
        else: raise ValueError('Salud pública diferente')
        self.save('complete', ok=True, publicHealth=health, sourceApplicationStopped=True,
                  originalDatabasesAndVolumesPreserved=True, localCoordinatedBackupVerified=True)

    def remove_maintenance(self):
        name=self.state.get('maintenance')
        if not name: return
        if not self.docker('ps','-aq','--filter','name=^'+name+'$').strip(): return
        x=self.inspect(name)
        if x['Config']['Labels'].get('agents.transfer') != self.run: raise ValueError('Mantenimiento ajeno')
        self.docker('rm','-f',x['Id'])

    def recover(self):
        if self.state.get('bootAttempted'): raise ValueError('Arranque intentado: requiere reconciliación explícita, no rollback')
        if self.state.get('managedStackUpdateAttempted'):
            if not self.backup: raise ValueError('Falta copia original; reconciliar')
            self.login()
            original=json.loads((self.backup/'original-komodo-stack.json').read_text())
            current=self.api('read','GetStack',{'stack':'agents'})
            candidate=(self.directory/'candidate.compose.yaml').read_text()
            if current['config'] not in (original['config'],{**original['config'],'file_contents':candidate}):
                raise ValueError('Stack ajeno al cambio esperado; reconciliar')
            sid=original['_id']['$oid']
            if current['config'] != original['config']:
                self.api('write','UpdateStack',{'id':sid,'config':{'file_contents':original['config']['file_contents']}})
                if self.api('read','GetStack',{'stack':'agents'})['config'] != original['config']: raise ValueError('Recuperación de stack incierta')
            disk=self.private_file('/etc/komodo/stacks/agents/compose.yaml')
            old_disk=self.private_file(self.backup/'production.compose.yaml')
            if disk not in (old_disk,candidate.encode()): raise ValueError('Compose modificado por otro actor')
            if disk != old_disk:
                self.helper(['type=bind,src=/etc/komodo/stacks/agents,dst=/stack'],'node','-e',
                    "require('fs').writeFileSync('/stack/compose.yaml',require('fs').readFileSync(0),{mode:0o600})",caps=True,data=old_disk)
        for name, old in self.state.get('writers',{}).items():
            current=self.inspect(name)
            if current['Id'] != old['id']: raise ValueError('Identidad del servicio cambió')
            if old['running'] and not current['State']['Running']: self.docker('start',old['id'])
        self.remove_maintenance()
        self.save('recovered-original', recoveredOriginal=True)

    def execute(self):
        self.start=time.monotonic()
        if self.p['action']=='recover': self.recover();return
        if self.state['phase']!='created': raise ValueError('Operación ya iniciada; no se reintenta')
        self.audit()
        if self.p['action']=='audit': self.save('audit-complete',ok=True);return
        self.maintenance();self.snapshot();self.stage();self.activate()


def main(p):
    os.umask(0o077)
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_mode & 0o077: raise ValueError('Raíz operativa no privada')
    lock=os.open(ROOT/'.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    t=Transfer(p)
    try:
        t.execute()
    except Exception as e:
        t.save('failed',errorType=type(e).__name__,failedPhase=t.state['phase'],
            reason=str(e) if type(e) in (ValueError,RuntimeError) else 'private-details-omitted',
            recoveryRequiresReconciliation=t.state.get('bootAttempted',False))
    finally:
        t.env=None;t.token=None;p.pop('credential',None)
        if t.backup and t.state.get('bootAttempted'):
            with (t.backup/'production-app-after-cutover.log').open('wb') as f:
                subprocess.run(t.core.DOCKER+['logs','--tail','200','agents-server-1'],stdout=f,stderr=f,timeout=10)
        print(json.dumps(t.state),flush=True)
    return t.state


if 'transferPayload' in globals():
    main(transferPayload)
