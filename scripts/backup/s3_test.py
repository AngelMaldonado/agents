#!/usr/bin/env python3
"""Regresiones locales sin Docker, credenciales, S3 ni PostgreSQL."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import s3_remote as s3


def configured(**changes):
    values = {'ENABLED': 'true', 'REPOSITORY': 's3:https://s3.example.invalid/bucket/agents/prod',
              'ACCESS_KEY_ID': 'synthetic-access', 'SECRET_ACCESS_KEY': 'synthetic-secret',
              'PASSWORD': 'synthetic-repository-password-only-tests'}
    values.update(changes)
    return '\n'.join(s3.PREFIX + k + '=' + v for k, v in values.items())


class FakeRunner:
    def __init__(self, config='', fail_backup=False):
        self.env = s3.configuration(config)
        self.operations = []
        self.fail_backup = fail_backup
        self.run = 'unit-test'

    def docker(self, *args):
        if args[0] == 'info':
            return b'reko-3|13ec1fd9-550a-447e-9d33-6a834d309d3f'
        return b'linux|amd64'

    def load_config(self):
        return self.env

    def restic(self, env, args, **kwargs):
        self.operations.append(args)
        if args[0] == 'backup':
            if self.fail_backup:
                raise s3.BackupError('restic-failed-no-auto-init-no-auto-unlock')
            return (json.dumps({'message_type': 'status', 'current_files': ['private-must-not-leak']}) + '\n' + json.dumps({'message_type': 'summary', 'snapshot_id': 'a' * 64})).encode()
        return b'{}'

    def validate_source(self, source, run_id):
        return {'kind': 'migration', 'checksumsVerified': True}

    def verify(self, env, snapshot):
        self.operations.append(['verify', snapshot])
        return {'restoredAndVerified': True, 'snapshot': snapshot}

    def cleanup(self):
        return []


class BackupTests(unittest.TestCase):
    def test_disabled_needs_no_credentials_and_makes_no_s3_calls(self):
        for text in ('', configured(ENABLED='false', PASSWORD='')):
            runner = FakeRunner(text)
            report = s3.main({'action': 'push', 'target': 'daily'}, runner)
            self.assertFalse(report['enabled'])
            self.assertEqual(report['state'], 'disabled-no-s3-requests')
            self.assertEqual(runner.operations, [])

    def test_literal_configuration_only_and_secret_environment_allowlist(self):
        env = s3.configuration(configured(REGION='eu-west-1', SESSION_TOKEN='synthetic-session', PASSWORD="'a literal $(no-execution) password'"))
        self.assertEqual(env['RESTIC_PASSWORD'], 'a literal $(no-execution) password')
        self.assertEqual(env['AWS_DEFAULT_REGION'], 'eu-west-1')
        self.assertEqual(env['AWS_SESSION_TOKEN'], 'synthetic-session')
        self.assertNotIn('AGENTS_MASTER_KEY', env)
        self.assertNotIn('AWS_PROFILE', env)
        self.assertEqual(env['AWS_EC2_METADATA_DISABLED'], 'true')

    def test_activation_requires_safe_repository_and_all_secrets(self):
        changes = [dict(ENABLED='yes'), dict(REPOSITORY='s3:http://plain/bucket/agents'),
                   dict(REPOSITORY='s3:https://user:secret@host/bucket/agents'),
                   dict(REPOSITORY='s3:https://host/bucket'), dict(REPOSITORY='s3:https://host/bucket/../outside'),
                   dict(REPOSITORY='s3:https://host/bucket/prefix?token=private'),
                   dict(ACCESS_KEY_ID=''), dict(PASSWORD='short'), dict(SECRET_ACCESS_KEY=''),
                   dict(PASSWORD='${SOME_SECRET}'), dict(REGION='bad region')]
        for change in changes:
            with self.subTest(change=list(change)):
                with self.assertRaises(s3.BackupError):
                    s3.configuration(configured(**change))
        with self.assertRaises(s3.BackupError):
            s3.configuration(configured() + '\nAGENTS_BACKUP_S3_ENABLED=true')

    def test_only_existing_known_backup_sources(self):
        for target in ('../private', '/etc', '', 'latest', '20261031T155740Z-03c3066b/..'):
            with self.assertRaises(s3.BackupError):
                s3.source_for(target)
        with patch.object(s3, 'private_directory', side_effect=lambda p: p):
            source, tags, run = s3.source_for('20261031T155740Z-03c3066b')
            self.assertEqual(source.name, run)
            self.assertIn('run:' + run, tags)

    def test_success_requires_snapshot_and_complete_restore(self):
        runner = FakeRunner(configured())
        with patch.object(s3, 'source_for', return_value=(Path('/synthetic'), ['agents-backup'], 'unit')):
            report = s3.main({'action': 'push', 'target': 'unused'}, runner)
        self.assertTrue(report['ok'])
        self.assertTrue(report['snapshotCreated'])
        self.assertTrue(report['restoredAndVerified'])
        self.assertEqual(report['snapshot'], 'a' * 64)
        self.assertEqual(runner.operations[-1], ['verify', 'a' * 64])
        self.assertNotIn('private-must-not-leak', json.dumps(report))
        self.assertFalse(report['sourceChanged'])
        self.assertFalse(report['deploymentExecuted'])

    def test_partial_backup_fails_without_init_or_verify(self):
        runner = FakeRunner(configured(), fail_backup=True)
        with patch.object(s3, 'source_for', return_value=(Path('/synthetic'), [], None)):
            report = s3.main({'action': 'push', 'target': 'daily'}, runner)
        self.assertFalse(report['ok'])
        self.assertNotIn('snapshotCreated', report)
        self.assertEqual(len(runner.operations), 1)
        self.assertEqual(runner.operations[0][0], 'backup')
        self.assertNotIn('init', json.dumps(runner.operations))

    def test_restore_failure_preserves_uploaded_snapshot_id(self):
        runner = FakeRunner(configured())
        runner.verify = lambda *_: (_ for _ in ()).throw(s3.BackupError('restore-failed'))
        with patch.object(s3, 'source_for', return_value=(Path('/synthetic'), [], None)):
            report = s3.main({'action': 'push', 'target': 'daily'}, runner)
        self.assertFalse(report['ok'])
        self.assertEqual(report['snapshot'], 'a' * 64)
        self.assertTrue(report['snapshotCreated'])
        self.assertNotIn('restoredAndVerified', report)

    def test_unconfirmed_cleanup_is_never_a_success(self):
        runner = FakeRunner(configured())
        runner.cleanup = lambda: ['cannot-confirm-temporary-container-state']
        report = s3.main({'action': 'check'}, runner)
        self.assertFalse(report['ok'])
        self.assertEqual(report['cleanupFailures'], ['cannot-confirm-temporary-container-state'])
        real = s3.Runner()
        real.docker = lambda *_: (_ for _ in ()).throw(s3.BackupError('disconnected'))
        self.assertEqual(real.cleanup(), ['cannot-confirm-temporary-container-state'])

    def test_restic_errors_never_trigger_implicit_init_or_expose_stderr(self):
        env = s3.configuration(configured())
        for code, message in [(3, 'incomplete-snapshot-not-a-success'), (10, 'repository-missing-use-explicit-init'),
                              (11, 'repository-locked-no-auto-unlock'), (12, 'wrong-repository-password-no-auto-init')]:
            runner = s3.Runner()
            runner.container = lambda *_args, **_kwargs: (_ for _ in ()).throw(s3.CommandError(code))
            with self.assertRaisesRegex(s3.BackupError, message):
                runner.restic(env, ['check'])

    def test_secrets_do_not_enter_argv_and_source_mount_is_readonly(self):
        runner = s3.Runner()
        calls = []
        runner.command = lambda args, **kwargs: calls.append((args, kwargs)) or b'{}'
        env = s3.configuration(configured())
        runner.restic(env, ['backup', '/source'], source=Path('/synthetic'))
        argv, kwargs = calls[0]
        self.assertNotIn(env['RESTIC_PASSWORD'], ' '.join(argv))
        self.assertNotIn(env['AWS_SECRET_ACCESS_KEY'], ' '.join(argv))
        self.assertIn('RESTIC_PASSWORD', argv)
        self.assertEqual(kwargs['env'], env)
        self.assertIn('type=bind,src=/synthetic,dst=/source,readonly', argv)
        self.assertIn('--log-driver', argv)
        self.assertNotIn('/var/run/docker.sock', ' '.join(argv))
        with self.assertRaises(s3.BackupError):
            s3.Runner().verify(env, 'latest')


if __name__ == '__main__':
    unittest.main()
