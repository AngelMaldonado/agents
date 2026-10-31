#!/usr/bin/env python3
"""Preparación local del corte: catálogo concreto, drenado y modelo de control; nunca apply."""
import copy
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
DOCKER = ["docker", "--context", "default"]  # Estos argv son para reko-3, NO el Mac.
TERMINAL = {"SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"}
COUNTERS = ("liveRuns", "pendingMessages", "pendingDeliveries", "busyDesigns", "sandboxWriters")
STEPS = (
    "preflight", "close-admission", "drain", "stop-writers", "confirm-frozen",
    "final-snapshot", "prepare-target", "start-target", "accept-target", "admit-production",
)
# Todo lo anterior a confirm-frozen puede fallar sin haber creado/modificado el destino.
# Hasta el arranque puede recuperar trabajo/escribir estado: no presumir rollback seguro.
RECONCILE_FROM = "start-target"
INPUTS = (
    "release/config.json", "deploy/beta.compose.yaml", "deploy/image-transition.json",
    "scripts/deploy/cutover.py", "scripts/deploy/drain.sql", "scripts/deploy/remote.py",
    "scripts/deploy/restore.mjs", "scripts/deploy/dbos.mjs", "scripts/deploy/data-copy.mjs",
    "scripts/deploy/signatures.mjs", "scripts/deploy/boot.mjs", "scripts/deploy/network.mjs",
    "scripts/egress-check.sh", "release/cosign.pub",
)


class StopCutover(Exception):
    """Sólo códigos fijos: ninguna excepción privada forma parte del informe."""


def plan_hash(body):
    value = {k: v for k, v in body.items() if k != "planSha256"}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def plan(root=ROOT):
    inputs = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in INPUTS}
    config = json.loads((root / "release/config.json").read_text())
    body = {
        "schema": 1, "kind": "cutover-control-plan", "host": "reko-3",
        "deploymentEnabled": config["deploymentEnabled"], "cutoverAuthorized": False,
        "backups": {"state": "pending", "workAuthorizedNow": False, "skipAuthorized": False},
        "liveExecutorImplemented": False, "readyForCutover": False,
        "inputs": inputs, "steps": list(STEPS),
        "target": {"database": "agents_beta1", "data": "/srv/agents/releases/beta1/data",
                   "volumes": [f"agents-prod-beta1-agent-{i}" for i in range(10, 19)]},
        "releaseSha": "f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3",
        "commandsForReviewOnly": commands(),
        "stopPolicy": "conservar mantenimiento y evidencia; nunca reinicio/reintento/rollback automáticos",
    }
    return {**body, "planSha256": plan_hash(body)}


def commands():
    """Catálogo acotado de argv. No se ejecuta ni se emite un shell runnable."""
    compose = DOCKER + ["compose", "--project-name", "agents", "--project-directory",
                       "/etc/komodo/stacks/agents", "--env-file", "/etc/komodo/stacks/agents/.env",
                       "-f", "/etc/komodo/stacks/agents/compose.yaml"]
    return {
        "drain": {name: DOCKER + ["exec", "-i", "-e",
                    "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15s -c lock_timeout=3s",
                    container, "psql", "-X", "-qAt", "-U", "agents", "-d", "agents", "-v", "ON_ERROR_STOP=1"]
                  for name, container in (("development", "agents-dev-postgres-1"),
                                          ("production", "agents-postgres-1"))},
        "drainStdin": "scripts/deploy/drain.sql",
        "stopBridgeFirst": DOCKER + ["stop", "--time", "30", "agents-dev-whatsapp-1"],
        "stopAfterDrain": DOCKER + ["stop", "--time", "120", "agents-dev-web-1",
                                    "agents-dev-server-1", "agents-server-1"],
        "sourceSandboxes": {instance: DOCKER + ["ps", "--filter", f"label=agents.instance={instance}",
                             "--format", "{{.ID}}"] for instance in ("dev", "prod")},
        # Sólo después de instalar/revisar el candidato y verificar destino ya preparado.
        "startPreparedServer": compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "server"],
        "futureBackupSwitchPending": compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "backup"],
        "notAutomated": ["mantenimiento HTTP/WS y pausa/restauración de agendas",
                         "respaldo final coordinado y restauración comprobada",
                         "promoción DB/data/volúmenes a destinos vacíos",
                         "instalación del candidato privado y aceptación real",
                         "admisión pública y reconciliación de escrituras tras fallo"],
    }


def drained(observation):
    """Fail-closed: no inferir cero si falta un contador o aparece un estado durable desconocido."""
    if not isinstance(observation, dict) or set(observation) != {"development", "production"}:
        return False
    for env in observation.values():
        if not isinstance(env, dict):
            return False
        if any(type(env.get(k)) is not int or env[k] != 0 for k in COUNTERS):
            return False
        states = env.get("dbosStatuses")
        if not isinstance(states, list):
            return False
        if any(not isinstance(s, dict) or s.get("status") not in TERMINAL
               or type(s.get("count")) is not int or s["count"] < 0 for s in states):
            return False
    return True


def require_entry_gates(p, facts):
    # PENDIENTE no significa aprobación para omitir el respaldo, ni activa trabajo S3.
    if p.get("backups") != {"state": "resolved", "workAuthorizedNow": True, "skipAuthorized": False}:
        raise StopCutover("backups-pending")
    if p.get("deploymentEnabled") is not True or p.get("cutoverAuthorized") is not True:
        raise StopCutover("cutover-not-authorized")
    if (p.get("planSha256") != plan_hash(p) or facts.get("planSha256") != p["planSha256"]
            or facts.get("ciExactHeadPassed") is not True):
        raise StopCutover("stale-plan-or-ci")
    if facts.get("windowOpen") is not True or facts.get("destinationAbsent") is not True:
        raise StopCutover("window-or-target-conflict")


class ControlRehearsal:
    """Modelo puro, NO executor Docker. El ensayo no acredita los hechos de las fixtures."""
    def __init__(self, p):
        self.plan = p
        self.journal = []
        self.finished = []
        self.uncertain = False
        self.reconciliation_required = False

    def run(self, fixture):
        try:
            require_entry_gates(self.plan, fixture["entry"])
            for step in STEPS:
                if step in ("drain", "confirm-frozen") and not drained(fixture[step]):
                    raise StopCutover("not-drained-" + step)
                if step == "final-snapshot" and fixture.get("coordinatedSnapshotVerified") is not True:
                    raise StopCutover("final-snapshot-unverified")
                if step == "prepare-target" and fixture.get("targetIndependentAndVerified") is not True:
                    raise StopCutover("target-not-verified")
                if step == "start-target" and fixture.get("targetSchedulesPaused") is not True:
                    raise StopCutover("target-cron-not-paused")
                if step == "accept-target" and fixture.get("acceptanceAuthorized") is not True:
                    raise StopCutover("acceptance-not-authorized")
                if step == "admit-production" and any(fixture.get(k) is not True for k in
                        ("acceptancePassed", "sourceStopped", "cronNoBackfill", "accessEffectsAccepted")):
                    raise StopCutover("admission-not-safe")
                # Registrar INTENTO antes de una acción. Un timeout puede haberla aplicado.
                self.journal.append({"step": step, "state": "attempting"})
                if STEPS.index(step) >= STEPS.index(RECONCILE_FROM):
                    self.reconciliation_required = True
                if fixture.get("failAt") == step:
                    self.uncertain = True
                    raise StopCutover("action-outcome-unknown")
                self.journal.append({"step": step, "state": "verified"})
                self.finished.append(step)
            return self.result(True, None)
        except StopCutover as error:
            return self.result(False, str(error))

    def result(self, ok, error):
        return {"ok": ok, "error": error, "finished": self.finished,
                "journal": self.journal, "outcomeUncertain": self.uncertain,
                "reconciliationRequired": self.reconciliation_required,
                "automaticRollback": False, "automaticRetry": False}


def fixture(p):
    # Inventada y pública; nada se obtiene de producción. No simula copiar tablas/perfiles.
    zero = {k: 0 for k in COUNTERS}
    zero["dbosStatuses"] = [{"status": "SUCCESS", "count": 2}]
    observed = {env: copy.deepcopy(zero) for env in ("development", "production")}
    return {"entry": {"planSha256": p["planSha256"], "ciExactHeadPassed": True,
                      "windowOpen": True, "destinationAbsent": True},
            "drain": copy.deepcopy(observed), "confirm-frozen": copy.deepcopy(observed),
            "coordinatedSnapshotVerified": True, "targetIndependentAndVerified": True,
            "targetSchedulesPaused": True, "acceptanceAuthorized": True,
            "acceptancePassed": True, "sourceStopped": True, "cronNoBackfill": True,
            "accessEffectsAccepted": True}


def rehearse(p):
    simulated = copy.deepcopy(p)
    simulated.update(deploymentEnabled=True, cutoverAuthorized=True)
    simulated["backups"] = {"state": "resolved", "workAuthorizedNow": True, "skipAuthorized": False}
    simulated["planSha256"] = plan_hash(simulated)
    cases = {}
    f = fixture(simulated)
    cases["pending-backups-block-before-admission"] = not ControlRehearsal(p).run(f)["journal"]
    cases["happy-path-control-only"] = ControlRehearsal(simulated).run(f)["ok"]
    for step in STEPS:
        failed = ControlRehearsal(simulated).run({**f, "failAt": step})
        cases["failure-" + step] = (not failed["ok"] and failed["outcomeUncertain"]
            and step not in failed["finished"] and not failed["automaticRollback"]
            and failed["reconciliationRequired"] == (STEPS.index(step) >= STEPS.index(RECONCILE_FROM)))
    return {"schema": 1, "kind": "synthetic-cutover-control-rehearsal", "ok": all(cases.values()),
            "planSha256": p["planSha256"], "cases": cases,
            "liveExecutorImplemented": False, "readyForCutover": False,
            "remoteCalls": 0, "databasesAccessed": 0, "backupsCreated": 0, "s3Requests": 0,
            "realAcceptanceTested": False, "deploymentEnabled": p["deploymentEnabled"],
            "backups": p["backups"]}


def main(args=None):
    args = sys.argv[1:] if args is None else args
    action = args[0] if args else "plan"
    if len(args) > 1 or action not in ("plan", "rehearse", "apply"):
        print("Uso: just cutover plan | rehearse. apply permanece bloqueado.", file=sys.stderr)
        return 2
    p = plan()
    if action == "apply":
        # No SSH, subprocess ni lectura de credenciales. Cambiar un flag no crea un executor.
        print("Corte bloqueado: respaldos pendientes, sin autorización de ventana y sin executor remoto integrado.",
              file=sys.stderr)
        return 2
    result = p if action == "plan" else rehearse(p)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if action == "plan" or result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
