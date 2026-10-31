#!/usr/bin/env python3
"""Traslado beta1 autorizado: Mac coordina; credenciales/datos no se escriben en el Mac."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = r'''
import json,os,pathlib,shlex,subprocess,sys
os.umask(0o077)
p=json.load(sys.stdin)
root=pathlib.Path.home()/'.local/state/agents-transfer'
root.mkdir(parents=True,exist_ok=True,mode=0o700)
if root.is_symlink() or root.stat().st_mode & 0o077: raise ValueError('private-root')
d=root/p['transferRun']
if p['action']=='recover':
 if not (d/'status.json').is_file(): raise ValueError('missing-journal')
else:d.mkdir(mode=0o700)
fifo=d/'private.input';os.mkfifo(fifo,0o600)
runner=d/'runner.py'
runner.write_text("import json,os,pathlib,sys\nos.umask(0o077)\np=pathlib.Path(__file__).parent\nwith (p/'private.input').open() as f:x=json.load(f)\n(p/'private.input').unlink()\ntry:exec(compile(x['transferProgram'],'transfer_remote','exec'),{'transferPayload':x})\nexcept BaseException as e:\n print(json.dumps({'errorType':type(e).__name__,'phase':'runner-failed'}),flush=True)\n")
log=d/'operator.log'
fd=os.open(log,os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600);os.close(fd)
session='agents-transfer-'+p['transferRun']
cmd='python3 -B '+shlex.quote(str(runner))+' 2>> '+shlex.quote(str(log))+' | tee -a '+shlex.quote(str(log))
subprocess.run(['tmux','new-session','-d','-s',session,'-n','operation',cmd],check=True,capture_output=True)
with fifo.open('w') as f:json.dump(p,f)
p.clear()
print(json.dumps({'launched':True,'session':session,'metadata':str(d/'status.json')}))
'''


def command(args, **kwargs):
    r = subprocess.run(args, capture_output=True, **kwargs)
    if r.returncode: raise RuntimeError('Fallo de comando; detalles privados omitidos')
    return r.stdout


def exact_ci(head, pr):
    checks = {c.get('name'): c.get('conclusion') for c in pr.get('statusCheckRollup', [])}
    return pr.get('headRefOid') == head and all(checks.get(n) == 'SUCCESS' for n in ('Quality', 'Sandbox E2E', 'Required checks'))


def payload(action, run):
    config = json.loads((ROOT/'release/config.json').read_text())
    authorization = json.loads((ROOT/'deploy/transfer-authorization.json').read_text())
    head = command(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip()
    if action == 'apply':
        if command(['git','status','--porcelain'],cwd=ROOT).strip(): raise ValueError('Checkout sucio; no se ejecuta corte')
        pr = json.loads(command(['gh','pr','view','4','--json','headRefOid,statusCheckRollup'],cwd=ROOT,timeout=30))
        if not exact_ci(head,pr): raise ValueError('Faltan checks exact-head; no se abre ventana')
    if not config['publicationEnabled'] or not config['deploymentEnabled'] or not authorization['cutoverAuthorized']:
        raise ValueError('Despliegue/corte desautorizado')
    raw_manifest = (ROOT/'.release/verify-first-release/release-manifest.json').read_bytes()
    if hashlib.sha256(raw_manifest).hexdigest() != '52c9dbd1124134774806312a53e3aff81766af6da440654db6d56d2fae383b3c':
        raise ValueError('Manifiesto diferente al asset publicado')
    manifest = json.loads(raw_manifest)
    order = ['remote.py','restore.mjs','dbos.mjs','data-copy.mjs','signatures.mjs','boot.mjs','network.mjs']
    files = [(ROOT/'scripts/deploy'/name).read_text() for name in order]
    egress = (ROOT/'scripts/egress-check.sh').read_text()
    p = {'action':action,'mode':'frozen-snapshot','run':run,'transferRun':run,'operatorSha':head,
         'manifest':manifest,'tools':config['toolsImage'],'deploymentEnabled':True,'transferAuthorization':authorization,
         'program':files[0],'worker':files[1],'dbosWorker':files[2],'copyWorker':files[3],
         'signatureWorker':files[4],'bootWorker':files[5],'networkWorker':files[6],'egressWorker':egress,
         'operatorSourceSha256':hashlib.sha256(''.join(files+[egress]).encode()).hexdigest(),
         'decision':json.loads((ROOT/'deploy/image-transition.json').read_text()),
         'candidate':(ROOT/'deploy/beta.compose.yaml').read_text(),
         'drainSql':(ROOT/'scripts/deploy/drain.sql').read_text(),
         'transferProgram':(ROOT/'scripts/deploy/transfer_remote.py').read_text(),
         'acceptWorker':(ROOT/'scripts/deploy/accept.mjs').read_text(),
         'writerWorker':(ROOT/'scripts/deploy/writers.mjs').read_text()}
    p['app'] = 'registry.cubytest.space/cuby/agents-app@sha256:8a8d92f6ad22e024e3defba54261e903e60b24e43a18f5efd0d1e13a534916a8'
    p['sandbox'] = 'registry.cubytest.space/cuby/agents-sandbox@sha256:04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40'
    # Mismos nombres/contrato de prepare.py; manifiesto ya auditado, sin nueva publicación.
    p['publicKey'] = (ROOT/'release/cosign.pub').read_text()
    return p


def visible(action, run):
    if not os.environ.get('TMUX') or command(['tmux','display-message','-p','-t',os.environ.get('TMUX_PANE',''), '#S']).decode().strip() != 'cuby-agents-prod':
        raise ValueError('Operación remota fuera de la sesión de producción visible')
    p = payload(action,run)
    command(['ssh','-o','ConnectTimeout=5','reko-3','true'],timeout=10)
    raw = command(['op','item','get','Komodo Admin','--vault','Cuby','--fields','label=username,label=password','--format=json','--reveal'],timeout=60)
    selected=json.loads(raw);del raw
    if not isinstance(selected,list): raise ValueError('Respuesta de credencial ambigua')
    fields={f['label']:f.get('value') for f in selected};del selected
    if not fields.get('username') or not fields.get('password'): raise ValueError('Credencial incompleta')
    p['credential']={'username':fields['username'],'password':fields['password']};fields.clear()
    boot=json.loads(command(['ssh','reko-3','python3','-c',shlex.quote(BOOTSTRAP)],input=json.dumps(p).encode(),timeout=45))
    p.pop('credential',None)
    print(json.dumps(boot),flush=True)
    report=ROOT/'.release/deploy-prepare'/('transfer-'+run+'.json')
    poll="import json,pathlib; p=pathlib.Path.home()/'.local/state/agents-transfer'/"+repr(run)+"/'status.json';print(p.read_text() if p.exists() else json.dumps({'phase':'launching'}))"
    last=None
    for _ in range(600):
        try: status=json.loads(command(['ssh','-o','ConnectTimeout=5','reko-3','python3','-c',shlex.quote(poll)],timeout=15))
        except Exception:
            print('Resultado remoto incierto; revisar journal, no reintentar operación.',flush=True);return 2
        if status['phase']!=last:
            print(json.dumps(status),flush=True);last=status['phase']
            report.parent.mkdir(parents=True,exist_ok=True)
            report.write_text(json.dumps(status,indent=2));report.chmod(0o600)
        if last in ('complete','failed','audit-complete','recovered-original'):return 0 if status.get('ok') or last=='recovered-original' else 2
        time.sleep(2)
    print('Tiempo de observación agotado; el job remoto puede seguir activo. No reintentar.',flush=True)
    return 2


def main():
    os.umask(0o077)
    args=[a for a in sys.argv[1:] if a != '--visible']
    action=args[0] if args else ''
    if action not in ('audit','apply','recover'):raise ValueError('Uso: just transfer audit|apply|recover [run]')
    run=args[1] if len(args)>1 else datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
    if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{8}',run):raise ValueError('Run inválido')
    if action=='recover' and len(args)!=2:raise ValueError('Recover exige el run anterior')
    if '--visible' in sys.argv[1:]:return visible(action,run)
    session='cuby-agents-prod';window='transfer-'+action+'-'+str(os.getpid())
    exists=subprocess.run(['tmux','has-session','-t',session],capture_output=True).returncode==0
    cmd=shlex.join([sys.executable,'-B',str(Path(__file__).resolve()),action,run,'--visible'])+'; printf "\\nTRANSFER_END\\n"; exec zsh'
    if exists:subprocess.run(['tmux','new-window','-d','-t',session,'-n',window,'-c',str(ROOT),cmd],check=True)
    else:subprocess.run(['tmux','new-session','-d','-s',session,'-n',window,'-c',str(ROOT),cmd],check=True)
    print(json.dumps({'run':run,'window':session+':'+window,'attach':'tmux attach -t '+session}))
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:print('Operación detenida: '+type(e).__name__+'; no se muestra salida privada.');sys.exit(2)
