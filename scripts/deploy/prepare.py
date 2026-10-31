#!/usr/bin/env python3
"""Visible, preparation-only entrypoint. No deploy/apply operation exists here."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SESSION = "cuby-agents-prod"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "plan"
    if mode == "plan":
        print("Preparación solamente: desarrollo -> producción; excluir Test sólo del destino.")
        print("just deploy inspect: metadatos y búsqueda de imágenes; sin modificar stacks.")
        print("just deploy rehearse: respaldo privado en reko-3 y restauración aislada, sin corte.")
        print("Imágenes: reutilizar app/sandbox publicados de v0.0.1-beta por digest; sin rebuild.")
        print("Angel autoriza nuevas revisiones sólo de agentes activos en la copia; retirados intactos.")
        print("Las copias online NO son el respaldo definitivo de un corte coordinado.")
        print("No existe apply; deploymentEnabled sigue false.")
        return
    if mode not in ("inspect", "rehearse"):
        raise SystemExit("Sólo plan | inspect | rehearse. Corte y publicación no autorizados aquí.")
    visible = "--visible" in sys.argv[2:]
    if not visible:
        exists = subprocess.run(["tmux", "has-session", "-t", SESSION], capture_output=True).returncode == 0
        window = f"migration-{mode}"
        command = f"cd {shlex.quote(str(ROOT))} && python3 scripts/deploy/prepare.py {mode} --visible; exec zsh"
        if exists:
            subprocess.run(["tmux", "new-window", "-d", "-t", SESSION, "-n", window, "-c", str(ROOT), command], check=True)
        else:
            subprocess.run(["tmux", "new-session", "-d", "-s", SESSION, "-n", window, "-c", str(ROOT), command], check=True)
            subprocess.run(["tmux", "set-option", "-t", SESSION, "@owner", "operator"], check=True)
            subprocess.run(["tmux", "set-option", "-t", SESSION, "@purpose", "Agents beta: preparación sin corte"], check=True)
        print(f"Preparación visible en {SESSION}:{window}; tmux attach -t {SESSION}")
        return
    if not os.environ.get("TMUX") or subprocess.check_output(
        ["tmux", "display-message", "-p", "#S"], text=True
    ).strip() != SESSION:
        raise SystemExit("Las operaciones remotas requieren la sesión de producción visible.")
    subprocess.run(["ssh", "-o", "ConnectTimeout=5", "reko-3", "true"], check=True)
    config = json.loads((ROOT / "release/config.json").read_text())
    asset = ROOT / ".release/verify-first-release/release-manifest.json"
    if not asset.is_file():
        # Immutable asset ID, existing gh authentication; no publication or secret export.
        result = subprocess.run(["gh", "api", "repos/AngelMaldonado/agents/releases/assets/694052321",
                                 "-H", "Accept: application/octet-stream"], capture_output=True, timeout=30)
        if result.returncode or hashlib.sha256(result.stdout).hexdigest() != "52c9dbd1124134774806312a53e3aff81766af6da440654db6d56d2fae383b3c":
            raise SystemExit("No se pudo obtener el manifiesto auditado de GitHub; no se muestran detalles de autenticación.")
        asset.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(asset, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(result.stdout)
    raw_manifest = asset.read_bytes()
    if hashlib.sha256(raw_manifest).hexdigest() != "52c9dbd1124134774806312a53e3aff81766af6da440654db6d56d2fae383b3c":
        raise SystemExit("El manifiesto no coincide con el asset publicado y auditado.")
    manifest = json.loads(raw_manifest)
    if manifest["version"] != "0.0.1-beta" or manifest["sha"] != "f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3":
        raise SystemExit("Este ensayo es para el manifiesto auditado de la primera beta.")
    payload = {
        "mode": mode,
        "tools": config["toolsImage"],
        "app": manifest["images"]["agents-app"]["ref"],
        "sandbox": manifest["images"]["agents-sandbox"]["ref"],
        "decision": json.loads((ROOT / "deploy/image-transition.json").read_text()),
        "worker": (ROOT / "scripts/deploy/restore.mjs").read_text(),
        "program": (ROOT / "scripts/deploy/remote.py").read_text(),
    }
    command = "import json,sys; payload=json.load(sys.stdin); exec(compile(payload['program'], 'agents-migration-remote', 'exec'))"
    print(f"reko-3: {mode}; llaves y respaldos permanecen en ese host. Espera el informe final.", flush=True)
    result = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=5", "reko-3", "python3", "-c", shlex.quote(command)],
        input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800,
    )
    # The remote program emits only an allowlisted report. Never print raw remote errors.
    try:
        report = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise SystemExit("No llegó un informe válido. Revisar estado parcial en reko-3; no reintentar a ciegas.") from None
    dest = ROOT / ".release/deploy-prepare" / f"{report['run']}.json"
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(json.dumps(report, indent=2))
    print(f"Informe privado: {dest}")
    if result.returncode or not report.get("ok"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
