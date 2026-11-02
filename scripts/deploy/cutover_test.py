#!/usr/bin/env python3
"""Regresiones focalizadas del control del corte, sin red/DB/Docker/respaldos."""
import contextlib
import copy
import io
import unittest
from unittest.mock import patch
import cutover as c


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.public = c.plan()
        self.simulated = copy.deepcopy(self.public)
        self.simulated.update(deploymentEnabled=True, cutoverAuthorized=True)
        self.simulated["backups"] = {"state": "resolved", "workAuthorizedNow": True, "skipAuthorized": False}
        self.simulated["planSha256"] = c.plan_hash(self.simulated)
        self.fixture = c.fixture(self.simulated)

    def run_model(self, fixture=None, plan=None):
        return c.ControlRehearsal(plan or self.simulated).run(fixture or self.fixture)

    def test_pending_backup_does_not_mean_permission_to_skip_or_freeze(self):
        r = self.run_model(plan=self.public)
        self.assertEqual(r["error"], "backups-pending")
        self.assertEqual(r["journal"], [])
        self.assertFalse(self.public["backups"]["skipAuthorized"])
        self.assertFalse(self.public["backups"]["workAuthorizedNow"])

    def test_authorization_window_target_and_ci_are_separate_gates(self):
        for field in ("deploymentEnabled", "cutoverAuthorized"):
            p = copy.deepcopy(self.simulated)
            p[field] = False
            self.assertEqual(self.run_model(plan=p)["journal"], [])
        for field in ("ciExactHeadPassed", "windowOpen", "destinationAbsent", "planSha256"):
            f = copy.deepcopy(self.fixture)
            f["entry"][field] = False
            self.assertEqual(self.run_model(f)["journal"], [])

    def test_changed_plan_body_cannot_keep_old_hash(self):
        p = copy.deepcopy(self.simulated)
        p["target"]["database"] = "agents"
        r = self.run_model(plan=p)
        self.assertEqual(r["error"], "stale-plan-or-ci")
        self.assertEqual(r["journal"], [])

    def test_missing_negative_noninteger_or_active_counters_fail_closed(self):
        for key in c.COUNTERS:
            for value in (None, -1, 1, "0", False):
                f = copy.deepcopy(self.fixture["drain"])
                f["development"][key] = value
                self.assertFalse(c.drained(f))
        f = copy.deepcopy(self.fixture["drain"])
        del f["production"]["sandboxWriters"]
        self.assertFalse(c.drained(f))
        self.assertFalse(c.drained({"development": f["development"]}))

    def test_unknown_and_nonterminal_dbos_states_are_not_drained(self):
        for status in ("PENDING", "ENQUEUED", "UNKNOWN", None):
            f = copy.deepcopy(self.fixture["drain"])
            f["production"]["dbosStatuses"] = [{"status": status, "count": 1}]
            self.assertFalse(c.drained(f))
        self.assertTrue(c.drained(self.fixture["drain"]))

    def test_race_after_stop_blocks_snapshot_and_target(self):
        f = copy.deepcopy(self.fixture)
        f["confirm-frozen"]["development"]["pendingMessages"] = 1
        r = self.run_model(f)
        self.assertEqual(r["error"], "not-drained-confirm-frozen")
        self.assertIn("stop-writers", r["finished"])
        self.assertNotIn("final-snapshot", r["finished"])
        self.assertNotIn("prepare-target", r["finished"])

    def test_unverified_backup_target_cron_and_acceptance_block_progress(self):
        fields = {
            "coordinatedSnapshotVerified": "final-snapshot",
            "targetIndependentAndVerified": "prepare-target",
            "targetSchedulesPaused": "start-target",
            "acceptanceAuthorized": "accept-target",
            "acceptancePassed": "admit-production", "sourceStopped": "admit-production",
            "cronNoBackfill": "admit-production", "accessEffectsAccepted": "admit-production",
        }
        for field, step in fields.items():
            f = {**self.fixture, field: False}
            r = self.run_model(f)
            self.assertFalse(r["ok"])
            self.assertNotIn(step, r["finished"])
            self.assertFalse(r["automaticRollback"])

    def test_timeout_is_recorded_before_action_and_never_auto_retried(self):
        r = self.run_model({**self.fixture, "failAt": "start-target"})
        self.assertEqual(r["journal"][-1], {"step": "start-target", "state": "attempting"})
        self.assertTrue(r["outcomeUncertain"])
        self.assertNotIn("accept-target", r["finished"])
        self.assertFalse(r["automaticRollback"])
        self.assertFalse(r["automaticRetry"])

    def test_startup_already_crosses_possible_new_write_boundary(self):
        for step in ("start-target", "accept-target", "admit-production"):
            r = self.run_model({**self.fixture, "failAt": step})
            self.assertTrue(r["reconciliationRequired"])
            self.assertFalse(r["automaticRollback"])

    def test_commands_do_not_recreate_infrastructure_or_pull_build_prune(self):
        cmds = c.commands()
        stop = cmds["stopAfterDrain"]
        self.assertEqual(stop[-3:], ["agents-dev-web-1", "agents-dev-server-1", "agents-server-1"])
        for key, service in (("startPreparedServer", "server"), ("futureBackupSwitchPending", "backup")):
            argv = cmds[key]
            self.assertEqual(argv[:3], ["docker", "--context", "default"])
            self.assertEqual(argv[-1], service)
            self.assertIn("--no-deps", argv)
            self.assertIn("--no-build", argv)
            self.assertEqual(argv[argv.index("--pull") + 1], "never")
            self.assertNotIn("--remove-orphans", argv)
            self.assertNotIn("--wait", argv)
        self.assertEqual(self.public["target"]["volumes"], [f"agents-prod-beta1-agent-{i}" for i in range(10, 19)])

    def test_model_report_not_a_live_rehearsal_or_backup(self):
        r = c.rehearse(self.public)
        self.assertTrue(r["ok"])
        self.assertTrue(all(r["cases"].values()))
        self.assertEqual(r["remoteCalls"], 0)
        self.assertEqual(r["backupsCreated"], 0)
        self.assertEqual(r["s3Requests"], 0)
        self.assertFalse(r["readyForCutover"])
        self.assertFalse(r["liveExecutorImplemented"])
        self.assertEqual(self.public["backups"]["state"], "pending")

    def test_apply_cannot_be_enabled_by_merely_changing_flags(self):
        with patch.object(c, "plan", return_value=self.simulated), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(c.main(["apply"]), 2)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(c.main(["rehearse", "--apply"]), 2)


if __name__ == "__main__":
    unittest.main()
