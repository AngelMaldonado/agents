"""Regresiones focalizadas del executor; sin SSH, Docker ni bases reales."""
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

engine=load('transfer_remote');client=load('transfer');snapshot=load('remote')

class TransferTests(unittest.TestCase):
    def test_komodo_terminal_lf_only_does_not_weaken_other_guards(self):
        base={'file_contents':'{"services":{}}','environment':'private-placeholder','auto_pull':False}
        self.assertTrue(engine.same_stack_config({**base,'file_contents':base['file_contents']+'\n'},base))
        self.assertFalse(engine.same_stack_config({**base,'auto_pull':True},base))
        self.assertFalse(engine.same_stack_config({**base,'file_contents':'{"services":{"unexpected":{}}}\n'},base))
        self.assertFalse(engine.same_stack_config({**base,'environment':'different'},base))

    def test_resume_refuses_any_boot_attempt_or_original_recovery(self):
        t=engine.Transfer.__new__(engine.Transfer);t.login=Mock()
        base={'phase':'failed','bootAttempted':False,'failedPhase':'managed-stack-update-attempt','profilesCopied':9,'tablesIdenticalBeforeBoot':True}
        for change in ({'bootAttempted':True},{'recoveredOriginal':True},{'phase':'complete'},{'failedPhase':'stage-target-attempt'}):
            t.state={**base,**change}
            with self.assertRaises(ValueError):t.resume_preboot()
        t.login.assert_not_called()

    def test_specific_authorization(self):
        p={'transferAuthorization':json.loads((HERE.parents[1]/'deploy/transfer-authorization.json').read_text()),'deploymentEnabled':True}
        self.assertTrue(engine.approved(p))
        for key,value in [('cutoverAuthorized',False),('localCoordinatedBackupAuthorized',False),('enableS3',True),('realInferenceAcceptanceAuthorized',True)]:
            q=json.loads(json.dumps(p));q['transferAuthorization'][key]=value;self.assertFalse(engine.approved(q))
        p['deploymentEnabled']=False;self.assertFalse(engine.approved(p))

    def test_exact_ci_rejects_wrong_head_and_pending(self):
        p={'headRefOid':'a','statusCheckRollup':[{'name':n,'conclusion':'SUCCESS'} for n in ('Quality','Sandbox E2E','Required checks')]}
        self.assertTrue(client.exact_ci('a',p));self.assertFalse(client.exact_ci('b',p))
        p['statusCheckRollup'][1]['conclusion']=None;self.assertFalse(client.exact_ci('a',p))

    def test_recover_visible_preserves_original_run(self):
        run='20261031T000000Z-12345678'
        with patch.object(client.sys,'argv',['transfer.py','recover',run,'--visible']), patch.object(client,'visible',return_value=0) as visible, patch.object(client.os,'umask'):
            self.assertEqual(client.main(),0)
            visible.assert_called_once_with('recover',run)

    def test_final_snapshot_requires_stopped_writers_and_terminal_work(self):
        original_docker,original_sql=snapshot.docker,snapshot.sql
        try:
            snapshot.docker=Mock(side_effect=lambda *a,**kw:b'false' if a[0]=='inspect' else b'')
            snapshot.sql=Mock(return_value='0');snapshot.assert_frozen()
            snapshot.docker=Mock(return_value=b'true')
            with self.assertRaises(ValueError):snapshot.assert_frozen()
            snapshot.docker=Mock(side_effect=lambda *a,**kw:b'false' if a[0]=='inspect' else b'')
            snapshot.sql=Mock(return_value='1')
            with self.assertRaises(ValueError):snapshot.assert_frozen()
        finally:snapshot.docker, snapshot.sql=original_docker,original_sql

    def test_actual_control_order(self):
        t=engine.Transfer.__new__(engine.Transfer);t.p={'action':'apply'};t.state={'phase':'created'}
        calls=[]
        for name in ('audit','maintenance','snapshot','stage','activate'):
            setattr(t,name,lambda name=name:calls.append(name))
        t.execute();self.assertEqual(calls,['audit','maintenance','snapshot','stage','activate'])

    def test_staging_failure_never_starts_target(self):
        t=engine.Transfer.__new__(engine.Transfer);t.p={'action':'apply'};t.state={'phase':'created'}
        for name in ('audit','maintenance','snapshot','activate'):setattr(t,name,Mock())
        t.stage=Mock(side_effect=RuntimeError('stage-failed'))
        with self.assertRaises(RuntimeError):t.execute()
        t.activate.assert_not_called()

    def test_boot_attempt_is_durable_before_compose_and_blocks_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            t=engine.Transfer.__new__(engine.Transfer);t.start=time.monotonic();t.directory=Path(d);t.run='synthetic'
            t.state={'run':'synthetic','ok':False,'bootAttempted':False};t.core=types.SimpleNamespace(assert_frozen=Mock())
            t.stack={'_id':{'$oid':'fixture'},'config':{'file_contents':'old'}};t.effective_candidate='candidate';t.p={}
            t.old_text='disk';t.backup=Path(d);t.private_file=Mock(side_effect=[b'disk',b'env',b'env'])
            t.env={k:'fixture' for k in ('AGENTS_MASTER_KEY','AGENTS_ADMIN_PIN','AGENTS_PROXY_KEY')}
            t.inspect=Mock(return_value={'Config':{'Env':[k+'=fixture' for k in t.env]}})
            t.api=Mock(side_effect=[t.stack,{}, {'config':{'file_contents':'candidate'}}]);t.helper=Mock()
            def uncertain(*args):
                self.assertTrue(json.loads((Path(d)/'status.json').read_text())['bootAttempted'])
                raise RuntimeError('timeout-unknown')
            t.compose=Mock(side_effect=uncertain)
            with self.assertRaises(RuntimeError):t.activate()
            with self.assertRaises(ValueError):t.recover()
            self.assertEqual(t.compose.call_count,1)

    def test_foreign_target_volume_is_never_mounted_or_removed(self):
        t=engine.Transfer.__new__(engine.Transfer);t.run='fixture'
        t.docker=Mock(side_effect=[b'name',b'foreign'])
        with self.assertRaises(ValueError):t.new_volume('reserved-target')
        self.assertEqual([c.args[0:2] for c in t.docker.call_args_list],[('volume','create'),('volume','inspect')])
        t.docker=Mock(side_effect=[b'name',b'fixture']);t.new_volume('reserved-target')
        self.assertEqual(t.docker.call_count,2)

    def writer_fixture(self,result):
        t=engine.Transfer.__new__(engine.Transfer);t.p={'tools':'pinned','writerWorker':'public-worker'};t.run='fixture'
        t.core=types.SimpleNamespace(mounts=lambda n:[{'Destination':'/data'}],approved_data_mount=Mock(),mount_arg=lambda *a:'type=bind,src=/fixture,dst=/sources/data,readonly')
        result={**result,'minimumFreeBytes':20*1024**3,'sourceBytes':1024}
        t.docker=Mock(return_value=json.dumps(result).encode());return t

    def test_unknown_external_writers_fail_closed(self):
        t=self.writer_fixture({'inaccessible':1,'writers':0,'regularFiles':2})
        with self.assertRaises(ValueError):t.external_writers(enforce=False)
        t=self.writer_fixture({'inaccessible':0,'writers':1,'regularFiles':2})
        with self.assertRaises(ValueError):t.external_writers()
        self.assertEqual(t.external_writers(enforce=False)['writers'],1)

    def test_census_sources_readonly_without_network_or_docker_socket(self):
        t=self.writer_fixture({'inaccessible':0,'writers':0,'regularFiles':2});self.assertEqual(t.external_writers()['writers'],0)
        args=t.docker.call_args.args
        self.assertIn('none',args);self.assertIn('--read-only',args);self.assertNotIn('/var/run/docker.sock',' '.join(args))
        self.assertTrue(all('readonly' in args[i+1] for i,a in enumerate(args) if a=='--mount'))

if __name__=='__main__':unittest.main()
