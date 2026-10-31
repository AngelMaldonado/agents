"""S3 opt-in sobre backups existentes. Sólo se ejecuta por SSH en reko-3, en tmux visible."""
import datetime
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import uuid
from urllib.parse import urlsplit

RESTIC_IMAGE = 'restic/restic@sha256:08916bcda4a4435f9d9828ebb4e91bb7ada3d2c8a53699788930e0ae1bd4fa67'
TOOLS_IMAGE = 'registry.cubytest.space/cuby/agents-release-tools@sha256:9f3b8a9c4e4e8f16701aa60147f31b97b5da10eaea84b4087e7d80b6d64b2826'
DOCKER = ['docker', '--context', 'default']
CONFIG_FILE = '/etc/komodo/stacks/agents/.env'
RUN_ID = re.compile(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}')
SNAPSHOT_ID = re.compile(r'[a-f0-9]{64}')
CONFIG_KEYS = ('ENABLED', 'REPOSITORY', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN', 'PASSWORD')
PREFIX = 'AGENTS_BACKUP_S3_'


class BackupError(Exception):
    """Sólo códigos definidos aquí; nunca excepciones de proveedor, URLs o rutas privadas."""


class CommandError(BackupError):
    def __init__(self, code):
        super().__init__('command-failed')
        self.code = code


def configuration(text):
    values = {}
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?(AGENTS_BACKUP_S3_[A-Z_]+)\s*=(.*)$', line)
        if not match or match[1][len(PREFIX):] not in CONFIG_KEYS:
            continue
        name, value = match.groups()
        if name in values:
            raise BackupError('duplicate-configuration')
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if '\x00' in value or '\r' in value or '\n' in value:
            raise BackupError('invalid-configuration')
        values[name] = value
    enabled = values.get(PREFIX + 'ENABLED', 'false')
    if enabled not in ('false', 'true'):
        raise BackupError('invalid-enable-flag')
    if enabled != 'true':
        return None
    required = ('REPOSITORY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'PASSWORD')
    if any(not values.get(PREFIX + k) or '${' in values[PREFIX + k] for k in required):
        raise BackupError('missing-required-configuration')
    repository = values[PREFIX + 'REPOSITORY']
    if not repository.startswith('s3:https://'):
        raise BackupError('repository-requires-s3-https')
    url = urlsplit(repository[3:])
    parts = url.path.strip('/').split('/')
    if (not url.hostname or url.username or url.password or url.query or url.fragment or len(parts) < 2
            or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', p) or p in ('.', '..') for p in parts)
            or url.path.endswith('/')):
        raise BackupError('invalid-repository-or-missing-dedicated-prefix')
    if len(values[PREFIX + 'PASSWORD']) < 20 or values[PREFIX + 'PASSWORD'] == values[PREFIX + 'SECRET_ACCESS_KEY']:
        raise BackupError('use-a-separate-repository-password-at-least-20-characters')
    region = values.get(PREFIX + 'REGION') or 'us-east-1'
    if not re.fullmatch(r'[a-z0-9-]{1,64}', region):
        raise BackupError('invalid-region')
    # No generic AWS/profile/password-command inheritance, IMDS fallback or TLS exceptions.
    env = {'RESTIC_REPOSITORY': repository, 'RESTIC_PASSWORD': values[PREFIX + 'PASSWORD'],
           'AWS_ACCESS_KEY_ID': values[PREFIX + 'ACCESS_KEY_ID'], 'AWS_SECRET_ACCESS_KEY': values[PREFIX + 'SECRET_ACCESS_KEY'],
           'AWS_DEFAULT_REGION': region, 'AWS_EC2_METADATA_DISABLED': 'true', 'RESTIC_CACHE_DIR': '/tmp/cache'}
    if values.get(PREFIX + 'SESSION_TOKEN'):
        env['AWS_SESSION_TOKEN'] = values[PREFIX + 'SESSION_TOKEN']
    return env


def private_directory(path):
    if path.is_symlink() or not path.is_dir() or path.stat().st_mode & 0o077:
        raise BackupError('source-or-recovery-directory-not-private')
    return path


def source_for(target):
    if target == 'daily':
        source = Path('/srv/agents/backups')
        if source.is_symlink() or not source.is_dir():
            raise BackupError('daily-source-not-found')
        return source, ['agents-backup', 'kind:database-dumps'], None
    if not RUN_ID.fullmatch(target):
        raise BackupError('invalid-migration-run-id')
    parent = private_directory(Path.home() / '.local/state/agents-migration')
    source = private_directory(parent / target)
    # El manifest sólo se devuelve después de verificarlo en helper con acceso root readonly.
    return source, ['agents-backup', 'kind:migration', 'run:' + target], target


class Runner:
    def __init__(self):
        self.run = uuid.uuid4().hex
        self.containers = []

    def command(self, args, *, data=None, env=None, timeout=30):
        # Allowlist: no credentials from user/global Docker/Git/RESTIC/AWS environment.
        safe = {k: os.environ[k] for k in ('PATH', 'HOME', 'SSH_AUTH_SOCK', 'DOCKER_CONFIG') if k in os.environ}
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**safe, **(env or {})}, timeout=timeout)
        if result.returncode:
            raise CommandError(result.returncode)
        return result.stdout

    def docker(self, *args, **kwargs):
        return self.command(DOCKER + list(args), **kwargs)

    def container(self, image, args, *, mounts=(), env=None, network='none', data=None, timeout=300, source_caps=False):
        name = 'agents-s3-' + self.run + '-' + str(len(self.containers))
        self.containers.append(name)
        command = ['run', '--rm', '--name', name, '--pull=never', '--network', network, '--read-only',
                   '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m',
                   '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--ulimit', 'core=0',
                   '--label', 'agents.backup.s3=' + self.run, '--log-driver', 'none',
                   '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777']
        if source_caps:
            command += ['--cap-add', 'DAC_READ_SEARCH', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER']
        if data is not None:
            command += ['-i']
        for mount in mounts:
            command += ['--mount', mount]
        for key in (env or {}):
            command += ['-e', key]  # Sólo nombres en argv; valores en memoria del proceso Docker.
        return self.docker(*command, '--entrypoint', args[0], image, *args[1:], data=data, env=env, timeout=timeout)

    def restic(self, env, args, *, source=None, destination=None, timeout=1200):
        mounts = []
        if source:
            mounts.append(f'type=bind,src={source},dst=/source,readonly')
        if destination:
            mounts.append(f'type=bind,src={destination},dst=/restore')
        try:
            return self.container(RESTIC_IMAGE, ['restic', '--json', '--no-cache', '--retry-lock', '30s', *args],
                                  mounts=mounts, env=env, network='bridge', timeout=timeout, source_caps=True)
        except CommandError as error:
            # No raw Restic/S3 stderr: puede contener rutas de archivos, endpoint o credenciales.
            meanings = {3: 'incomplete-snapshot-not-a-success', 10: 'repository-missing-use-explicit-init',
                        11: 'repository-locked-no-auto-unlock', 12: 'wrong-repository-password-no-auto-init'}
            raise BackupError(meanings.get(error.code, 'restic-failed-private-details-omitted')) from None

    def load_config(self):
        script = """const fs=require('fs'); const names=new Set(JSON.parse(process.argv[1]));
const rows=fs.readFileSync('/config','utf8').split(/\\r?\\n/).filter(l=>{const m=/^\\s*(?:export\\s+)?(AGENTS_BACKUP_S3_[A-Z_]+)\\s*=/.exec(l);return m&&names.has(m[1]);});
process.stdout.write(rows.join('\\n'));"""
        raw = self.container(TOOLS_IMAGE, ['node', '-e', script, json.dumps([PREFIX + k for k in CONFIG_KEYS])],
                             mounts=[f'type=bind,src={CONFIG_FILE},dst=/config,readonly'], source_caps=True)
        return configuration(raw.decode())

    def validate_source(self, source, run_id):
        script = r"""const fs=require('fs'),crypto=require('crypto');
const root='/source',id=process.argv[1];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name,s=fs.lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1))throw Error('unsafe-source');if(s.isDirectory())walk(p);}}
walk(root);
if(!id){const names=fs.readdirSync(root),pattern=/^agents(?:-beta1)?-\d{4}-\d{2}-\d{2}\.dump(?:\.tmp)?$/;if(names.some(n=>!pattern.test(n)||!fs.statSync(root+'/'+n).isFile()))throw Error('unknown-daily-file');const dumps=names.filter(n=>n.endsWith('.dump'));if(!dumps.length)throw Error('no-dumps');console.log(JSON.stringify({kind:'database-dumps',dumpCount:dumps.length,includesProfiles:false}));}
else{const s=JSON.parse(fs.readFileSync(root+'/status.json','utf8'));
if(s.run!==id||s.ok!==true||s.phase!=='complete'||!Array.isArray(s.cleanupFailures)||s.cleanupFailures.length||!s.backupChecksums||s.snapshotConsistency!=='online-rehearsal-only-not-a-coordinated-cutover-backup')throw Error('incomplete-run');
const required=['development.dump','production.dump','prepared.dump',...Array.from({length:9},(_,i)=>'agent-'+(i+10)+'.tar'),'development-data.tar','development-cliproxy.tar','production-data.tar','production-cliproxy.tar'];
for(const n of required){if(!/^[a-f0-9]{64}$/.test(s.backupChecksums[n]??''))throw Error('missing-checksum');const hash=crypto.createHash('sha256'),fd=fs.openSync(root+'/'+n,'r'),b=Buffer.alloc(1048576);let len;try{while((len=fs.readSync(fd,b,0,b.length,null))>0)hash.update(b.subarray(0,len));}finally{fs.closeSync(fd);}if(hash.digest('hex')!==s.backupChecksums[n])throw Error('changed-source');}
for(const n of ['development.env','production.env','production.compose.yaml','prepared/data-plan.json'])if(!fs.statSync(root+'/'+n).isFile())throw Error('missing-config');
console.log(JSON.stringify({kind:'migration',archives:13,dumps:3,includesProfiles:true,checksumsVerified:true,consistency:s.snapshotConsistency}));}"""
        return json.loads(self.container(TOOLS_IMAGE, ['node', '-e', script, run_id or ''],
                         mounts=[f'type=bind,src={source},dst=/source,readonly'], source_caps=True))

    def verify(self, env, snapshot):
        if not SNAPSHOT_ID.fullmatch(snapshot):
            raise BackupError('full-snapshot-id-required')
        snapshots = json.loads(self.restic(env, ['snapshots', snapshot], timeout=120))
        if len(snapshots) != 1 or snapshots[0].get('id') != snapshot or 'agents-backup' not in snapshots[0].get('tags', []) or snapshots[0].get('paths') != ['/source']:
            raise BackupError('unexpected-snapshot')
        parent = Path.home() / '.local/state/agents-backup-restore'
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        private_directory(parent)
        # Evitar llenar el host: tamaño del snapshot + 1 GiB antes de descargar.
        size = json.loads(self.restic(env, ['stats', snapshot, '--mode', 'restore-size'], timeout=180)).get('total_size')
        if not isinstance(size, int) or size < 0 or shutil.disk_usage(parent).free < size + 1024**3:
            raise BackupError('insufficient-recovery-space')
        destination = parent / self.run
        destination.mkdir(mode=0o700)
        try:
            self.restic(env, ['restore', snapshot, '--target', '/restore', '--verify'], destination=destination)
            tags = snapshots[0].get('tags', [])
            runs = [t[4:] for t in tags if t.startswith('run:')]
            if 'kind:migration' in tags:
                if len(runs) != 1 or not RUN_ID.fullmatch(runs[0]):
                    raise BackupError('unexpected-migration-snapshot')
                # Incluye manifest y hashes originales; confirma que se recuperaron completos.
                self.validate_source(destination / 'source', runs[0])
            elif 'kind:database-dumps' not in tags:
                raise BackupError('unexpected-backup-kind')
            return {'snapshot': snapshot, 'restoredAndVerified': True, 'restoredBytes': size,
                    'restoreLocation': 'temporary-private-on-reko-3', 'recoveryAcrossHostLossTested': False}
        finally:
            # Un cliente Docker con timeout puede dejar restic escribiendo: detenerlo antes de borrar.
            if self.cleanup():
                raise BackupError('restore-cleanup-unconfirmed-private-copy-retained')
            # Sólo el directorio de esta ejecución, no bases/perfiles en uso ni origen.
            self.container(TOOLS_IMAGE, ['sh', '-c', 'find /restore -mindepth 1 -delete'],
                           mounts=[f'type=bind,src={destination},dst=/restore'], source_caps=True)
            destination.rmdir()

    def cleanup(self):
        failed = []
        try:
            ids = self.docker('ps', '-aq', '--filter', 'label=agents.backup.s3=' + self.run).decode().split()
        except Exception:
            return ['cannot-confirm-temporary-container-state']
        for container in ids:
            try:
                if self.docker('inspect', container, '--format', '{{index .Config.Labels "agents.backup.s3"}}').decode().strip() != self.run:
                    raise BackupError('foreign-container-not-removed')
                self.docker('container', 'rm', '-f', container)
            except Exception:
                failed.append(container)
        return failed


def main(request, runner=None):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    runner = runner or Runner()
    report = {'ok': False, 'enabled': False, 'sourceChanged': False, 'deploymentExecuted': False,
              'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        action, target = request['action'], request.get('target', '')
        if action not in ('init', 'check', 'push', 'verify') or (action in ('init', 'check') and target):
            raise BackupError('invalid-operation')
        if runner.docker('info', '--format', '{{.Name}}|{{.ID}}').decode().strip() != 'reko-3|13ec1fd9-550a-447e-9d33-6a834d309d3f':
            raise BackupError('wrong-daemon')
        env = runner.load_config()
        if env is None:
            report.update(ok=action == 'check', state='disabled-no-s3-requests')
            return report
        report['enabled'] = True
        try:
            platform = runner.docker('image', 'inspect', RESTIC_IMAGE, '--format', '{{.Os}}|{{.Architecture}}').decode().strip()
        except CommandError:
            raise BackupError('pinned-restic-image-missing-preload-approved-digest') from None
        if platform != 'linux|amd64':
            raise BackupError('wrong-restic-platform')
        if action == 'init':
            report['remoteChangesMayExist'] = True
            runner.restic(env, ['init'], timeout=180)
            report.update(ok=True, state='repository-initialized')
        elif action == 'check':
            runner.restic(env, ['check'], timeout=300)
            report.update(ok=True, state='repository-structure-checked', allDataRead=False)
        elif action == 'verify':
            report.update(runner.verify(env, target), ok=True)
        else:
            source, tags, run_id = source_for(target)
            report['source'] = runner.validate_source(source, run_id)
            args = ['backup', '--host', 'reko-3-agents', '--read-concurrency', '1']
            for tag in tags:
                args += ['--tag', tag]
            if target == 'daily':
                args += ['--exclude', '*.tmp']
            report['remoteChangesMayExist'] = True
            raw = runner.restic(env, [*args, '/source'])
            # Nunca reenviar nombres/rutas/eventos privados de stdout.
            summaries = [v for line in raw.decode().splitlines() if (v := json.loads(line)).get('message_type') == 'summary']
            if len(summaries) != 1 or not SNAPSHOT_ID.fullmatch(summaries[0].get('snapshot_id', '')):
                raise BackupError('backup-summary-missing')
            report['snapshot'] = summaries[0]['snapshot_id']
            report['snapshotCreated'] = True
            # Verificación completa y comprobación de manifest antes de declarar éxito.
            report.update(runner.verify(env, report['snapshot']), ok=True)
        return report
    except Exception as error:
        report['error'] = str(error) if isinstance(error, BackupError) else 'private-error-details-omitted'
        return report
    finally:
        report['cleanupFailures'] = runner.cleanup()
        if report['cleanupFailures']:
            report['ok'] = False
        # Persistencia sólo de metadatos; conserva evidencia aun si se pierde la sesión Mac.
        if runner.__class__ is Runner:
            directory = Path.home() / '.local/state/agents-backup-reports'
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            private_directory(directory)
            with (directory / (runner.run + '.json')).open('x') as f:
                json.dump(report, f, indent=2)


if 'request' in globals():
    print(json.dumps(main(request)))
