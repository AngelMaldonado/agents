#!/usr/bin/env python3
"""Entrada visible al transporte S3. No lee secretos en el Mac ni despliega servicios."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SESSION = 'cuby-agents-prod'
ACTIONS = ('plan', 'check', 'init', 'push', 'verify')


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'plan'
    target = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '--visible' else ''
    if action not in ACTIONS:
        raise SystemExit('Sólo plan | check | init | push <run|daily> | verify <snapshot completo>.')
    if action == 'plan':
        print('S3 deshabilitado salvo AGENTS_BACKUP_S3_ENABLED=true en Environment del stack agents de Komodo.')
        print('restic 0.19.1 fijado por digest; cifrado cliente con contraseña independiente de AGENTS_MASTER_KEY.')
        print('just backup check: validar configuración/repositorio; sin init ni subida automática.')
        print('just backup init: crear repositorio nuevo, explícitamente, sólo tras habilitar/configurar.')
        print('just backup push <run>: enviar respaldo completo ya terminado de agents-migration; no crearlo ni detener escritores.')
        print('just backup push daily: enviar dumps PostgreSQL existentes; NO incluye perfiles/archivos/config.')
        print('push restaura/verifica el snapshot completo en reko-3 antes de declarar éxito; verify <id> lo repite.')
        print('Sin cron nuevo, prune, retención remota automática, despliegue, migración o corte. Ver deploy/backup-s3.md.')
        return
    if (action in ('init', 'check') and target) or (action == 'push' and target != 'daily' and not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}', target)) or (action == 'verify' and not re.fullmatch(r'[a-f0-9]{64}', target)):
        raise SystemExit('Argumento inválido; no se hace ninguna operación remota.')
    if '--visible' not in sys.argv:
        window = 's3-' + action + '-' + str(os.getpid())
        args = [sys.executable, str(Path(__file__).resolve()), action]
        if target:
            args.append(target)
        command = shlex.join(args + ['--visible']) + '; exec zsh'
        exists = subprocess.run(['tmux', 'has-session', '-t', SESSION], capture_output=True).returncode == 0
        if exists:
            subprocess.run(['tmux', 'new-window', '-d', '-t', SESSION, '-n', window, '-c', str(ROOT), command], check=True)
        else:
            subprocess.run(['tmux', 'new-session', '-d', '-s', SESSION, '-n', window, '-c', str(ROOT), command], check=True)
            subprocess.run(['tmux', 'set-option', '-t', SESSION, '@owner', 'agent'], check=True)
            subprocess.run(['tmux', 'set-option', '-t', SESSION, '@purpose', 'Respaldo S3 Agents: operación visible opt-in, sin corte'], check=True)
        print('Ventana: ' + SESSION + ':' + window + '; tmux attach -t ' + SESSION)
        return
    if not os.environ.get('TMUX') or subprocess.check_output(['tmux', 'display-message', '-p', '#S'], text=True).strip() != SESSION:
        raise SystemExit('Las operaciones remotas requieren cuby-agents-prod visible.')
    subprocess.run(['ssh', '-o', 'ConnectTimeout=5', 'reko-3', 'true'], check=True)
    program = (ROOT / 'scripts/backup/s3_remote.py').read_text()
    command = "import json,sys; p=json.load(sys.stdin); request=p['request']; exec(compile(p['program'],'agents-s3-remote','exec'))"
    print('reko-3: ' + action + '; credenciales/datos sólo en ese host. Esperar informe final.', flush=True)
    try:
        result = subprocess.run(['ssh', '-o', 'ConnectTimeout=5', 'reko-3', 'python3', '-c', shlex.quote(command)],
                                input=json.dumps({'program': program, 'request': {'action': action, 'target': target}}).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3600)
        report = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, ValueError, UnicodeError):
        raise SystemExit('Sin informe válido; puede haber estado parcial remoto. Revisar reports en reko-3, no reintentar a ciegas.') from None
    report['operatorSourceSha256'] = hashlib.sha256(program.encode()).hexdigest()
    print(json.dumps(report, indent=2))
    if result.returncode or not report.get('ok'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
