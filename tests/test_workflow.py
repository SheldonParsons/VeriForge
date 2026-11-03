"""Workflow behavior, archived-runtime compatibility and local recovery only."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/qa-workflow/scripts"))
from qa import execute
from qaw.runtime import Runtime, base
from qaw.storage import Error, atomic_bytes


class Workflow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.workspace = self.home / "workspace"
        self.rt = Runtime(self.workspace)
        self.call("workspace.init", title="合成工作空间")
        for project in ["orders", "catalog"]:
            self.call("project.create", project=project, title=project)
            self.call("requirement.create", project=project, requirement="123", title="合成需求")
        self.source = self.home / "basis.md"
        self.source.write_text("Synthetic user statement and evidence; not a real result.")
        self.req("artifact.import", artifact="basis", source_path=str(self.source), purpose="合成依据")

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, action, **q):
        return execute(self.workspace, {"action": action, "actor": "lead", **q})

    def req(self, action, **q):
        return self.call(action, **{"project": "orders", "requirement": "123", **q})

    def err(self, code, action, **q):
        with self.assertRaises(Error) as caught:
            self.req(action, **q)
        self.assertEqual(caught.exception.code, code)

    def fact(self, status, evidence=None):
        return {"status": status, "basis": "合成依据，不是实际验收", "evidence": evidence or []}

    def test_independent_facts_do_not_complete_stages_or_silently_write_knowledge(self):
        self.req("state.update", expected_revision=1, stages={"execution": {"status": "completed", "basis": "本轮已结束但有遗留"}})
        result = self.req("workflow.record", expected_revision=0, facts={
            "business": self.fact("ready", ["basis"]), "page_steps": self.fact("partial"),
            "execution": self.fact("blocked"), "release": self.fact("not_released"),
            "knowledge": self.fact("draft"), "restoration": self.fact("pending")})
        self.assertFalse(result["external_action_executed"])
        self.assertEqual(result["warnings"], [])
        state = self.req("resume")
        self.assertEqual(state["revision"], 2)
        self.assertEqual(state["workflow"]["facts"]["release"]["status"], "not_released")
        self.assertEqual(state["workflow"]["facts"]["execution"]["status"], "blocked")
        self.assertEqual(self.call("workflow.read", project="catalog", requirement="123")["facts"], {})
        self.err("EVIDENCE_REQUIRED", "workflow.record", expected_revision=1, facts={"release": self.fact("released")})
        self.assertEqual(self.req("workflow.read")["revision"], 1)

    def test_knowledge_observation_warning_preserves_fact_and_user_basis(self):
        written = self.req("workflow.record", expected_revision=0, facts={"knowledge": self.fact("synced", ["basis"])})
        self.assertEqual(written["warnings"][0]["code"], "KNOWLEDGE_BEFORE_STABILITY")
        self.assertEqual(self.req("workflow.read")["facts"]["knowledge"]["status"], "synced")
        self.req("workflow.record", expected_revision=1, facts={"release": self.fact("released", ["basis"]), "stability": self.fact("confirmed", ["basis"])})
        self.assertEqual(self.req("workflow.read")["warnings"], [])
        self.req("workflow.record", expected_revision=2, facts={"release": self.fact("rolled_back")})
        self.assertEqual(len(self.req("workflow.read")["warnings"]), 1)

    def test_resume_summaries_keep_full_long_basis_available_on_demand(self):
        basis = '已确认的合成说明。' * 120
        self.req('workflow.record', expected_revision=0, facts={'release': {'status': 'not_released', 'basis': basis}})
        self.req('followup.record', followup='long', title='长待办', status='waiting', basis=basis, next=basis, expected_revision=0)
        resumed = self.req('resume')
        self.assertTrue(resumed['workflow']['facts']['release']['basis_truncated'])
        self.assertTrue(resumed['followups']['items'][0]['next_truncated'])
        self.assertEqual(self.req('workflow.read', include_details=True)['facts']['release']['basis'], basis)
        self.assertEqual(self.call('record.read', path=resumed['followups']['items'][0]['path'])['data']['next'], basis)
        self.req('summary.write')
        summary = (self.workspace / base('orders', '123') / 'README.md').read_text()
        self.assertNotIn(basis, summary)
        self.assertIn('完整依据', summary)
        self.assertIn('完整内容', summary)

    def test_invalid_fact_batch_and_stale_writer_do_not_partially_apply(self):
        self.err("INVALID_STATE", "workflow.record", expected_revision=0,
                 facts={"release": self.fact("not_released"), "stability": self.fact("invented")})
        self.assertFalse(self.req("workflow.read")["exists"])
        self.req("workflow.record", expected_revision=0, facts={"release": self.fact("not_released")})
        self.err("REVISION_CONFLICT", "workflow.record", expected_revision=0, facts={"release": self.fact("unknown")})
        self.err("NOT_COORDINATOR", "workflow.record", actor="other", expected_revision=1, facts={"release": self.fact("unknown")})
        self.assertEqual(self.req("workflow.read")["facts"]["release"]["status"], "not_released")

    def test_deliverable_pins_snapshot_and_preserves_replaced_version(self):
        first = self.req("deliverable.set", deliverable="cases", artifact="basis", role="case_set", title="用例", status="ready", basis="合成可评审稿", expected_revision=0)
        self.assertFalse(first["remote_verified"])
        self.source.write_text("Changed source, not the immutable snapshot")
        self.req("artifact.import", artifact="basis-v2", source_path=str(self.source), purpose="合成修订")
        self.req("deliverable.set", deliverable="cases", artifact="basis-v2", role="case_set", title="用例修订", basis="合成变更", expected_revision=1)
        self.assertEqual(self.call("record.read", path=first["path"], revision=1)["data"]["artifact"]["artifact"], "basis")
        self.assertEqual(self.req("deliverable.list")["items"][0]["artifact"]["artifact"], "basis-v2")
        self.assertEqual(self.call("deliverable.list", project="catalog", requirement="123")["total"], 0)
        self.err("NOT_FOUND", "deliverable.set", project="catalog", deliverable="cases", artifact="basis-v2", role="case_set", title="不能串项目", basis="测试", expected_revision=0)

    def test_followup_pagination_archive_and_reopen_keep_outstanding_work(self):
        for i in range(23):
            self.req("followup.record", followup=f"issue-{i:02d}", title=f"遗留 {i}", status="waiting", basis="待部署", next="部署后复验", expected_revision=0)
        resumed = self.req("resume")
        self.assertEqual(resumed["followups"]["total"], 23)
        self.assertEqual(len(resumed["followups"]["items"]), 20)
        self.assertEqual(len(self.req("resume", followup_offset=20)["followups"]["items"]), 3)
        self.err("EVIDENCE_REQUIRED", "followup.record", followup="issue-00", title="遗留", status="done", basis="没有证据", expected_revision=1)
        self.req("followup.record", followup="issue-00", title="遗留", status="done", basis="合成复验", evidence=["basis"], expected_revision=1)
        self.req("requirement.archive", archived=True, reason="阶段资料归档，保留待办", expected_revision=1)
        self.assertEqual(self.req("followup.list")["total"], 22)
        self.err("ARCHIVED", "followup.record", followup="issue-01", title="遗留", status="done", basis="合成", evidence=["basis"], expected_revision=1)
        self.req("requirement.archive", archived=False, reason="继续遗留工作", expected_revision=2)
        self.req("followup.record", followup="issue-00", title="问题复发", status="open", basis="合成新证据", next="再次核对", expected_revision=2)
        self.assertEqual(self.req("followup.list")["total"], 23)
        history = self.call("record.read", path=base("orders", "123") + "/followups/issue-00.json", revision=2)
        self.assertEqual(history["data"]["status"], "done")

    def test_new_result_states_count_without_false_pass_and_preserve_sync(self):
        statuses = ["passed", "failed", "blocked", "not_run", "running", "needs_verification", "skipped", "not_applicable"]
        self.req("task.create", task="worker", owner="worker", scope="合成范围", run="round", cases=statuses, inputs=["basis"])
        for status in statuses:
            self.req("case.record", actor="worker", task="worker", case=status, status=status, basis="合成执行或用户范围决定", evidence=["basis"], expected_revision=0)
        summary = self.req("run.summary", run="round")
        self.assertEqual(summary["total"], 8)
        self.assertEqual(summary["recorded_results"], dict.fromkeys(statuses, 1))
        self.req("case.sync", task="worker", case="passed", receipt="basis", expected_revision=1)
        self.req("case.record", actor="worker", task="worker", case="passed", status="needs_verification", basis="新口径待复核", expected_revision=2)
        result = self.call("record.read", path=base("orders", "123") + "/runs/round/passed.json")
        self.assertEqual(result["data"]["sync"], "pending")
        self.assertNotIn("sync_receipt", result["data"])
        self.assertEqual(self.call("record.read", path=base("orders", "123") + "/runs/round/passed.json", revision=2)["data"]["status"], "passed")

    def test_backup_covers_new_records_and_summary_has_handoff_information(self):
        self.req("workflow.record", expected_revision=0, facts={"release": self.fact("not_released"), "knowledge": self.fact("draft")})
        self.req("deliverable.set", deliverable="cases", artifact="basis", role="case_set", title="合成用例", basis="已保存", expected_revision=0)
        self.req("followup.record", followup="retest", title="待复验", status="waiting", basis="开发处理中", next="QA 部署后继续", expected_revision=0)
        self.req("summary.write")
        summary = (self.workspace / base("orders", "123") / "README.md").read_text()
        self.assertIn("QA 部署后继续", summary)
        self.assertIn("not_released", summary)
        archive, dest = self.home / "backup.zip", self.home / "restored"
        self.call("backup.create", destination=str(archive))
        self.call("backup.restore", archive=str(archive), destination=str(dest))
        value = execute(dest, {"action": "resume", "project": "orders", "requirement": "123"})
        self.assertTrue(value["restored_review_required"])
        self.assertEqual(value["workflow"]["facts"]["release"]["status"], "not_released")
        self.assertEqual(value["deliverables"]["items"][0]["artifact"]["artifact"], "basis")
        self.assertEqual(value["followups"]["items"][0]["next"], "QA 部署后继续")

    def legacy_workspace(self):
        # Run the actual archived package, not a fixture that mirrors new code.
        package = self.home / "legacy-package"
        with zipfile.ZipFile(ROOT / "releases/archives/qa-workflow-0.2.1.zip") as archive:
            archive.extractall(package)
        old = package / "qa-workflow/scripts/qa.py"
        workspace = self.home / "legacy-workspace"
        def old_call(action, **kwargs):
            proc = subprocess.run([sys.executable, str(old), "--workspace", str(workspace)],
                input=json.dumps({"action": action, "actor": "lead", **kwargs}), text=True, capture_output=True)
            value = json.loads(proc.stdout)
            self.assertTrue(value["ok"], value)
            return value["result"]
        old_call("workspace.init", title="旧格式夹具")
        old_call("project.create", project="orders", title="旧项目")
        old_call("requirement.create", project="orders", requirement="123", title="旧需求")
        old_call("state.update", project="orders", requirement="123", expected_revision=1,
                 stages={"review": {"status": "completed", "basis": "旧版评审事实"}})
        old_call("artifact.import", project="orders", requirement="123", artifact="basis", source_path=str(self.source), purpose="旧快照")
        old_call("task.create", project="orders", requirement="123", task="worker", owner="lead", scope="旧任务", run="old", cases=["one"])
        old_call("case.record", project="orders", requirement="123", task="worker", case="one", status="failed", basis="旧失败", evidence=["basis"], expected_revision=0)
        return old, workspace, old_call

    def test_real_legacy_records_upgrade_without_rewriting_results_and_old_writer_refuses(self):
        old, workspace, old_call = self.legacy_workspace()
        args = {"actor": "lead", "project": "orders", "requirement": "123"}
        before = {p.relative_to(workspace): p.read_bytes() for p in workspace.rglob('*') if p.is_file()}
        read = execute(workspace, {"action": "resume", **args})
        self.assertEqual(read["workspace_runtime_schema"], 1)
        self.assertEqual(read["requirement"]["stages"]["review"]["status"], "completed")
        self.assertFalse(read["workflow"]["exists"])
        self.assertEqual(before, {p.relative_to(workspace): p.read_bytes() for p in workspace.rglob('*') if p.is_file()})
        with self.assertRaises(Error) as err:
            execute(workspace, {"action": "workflow.record", **args, "expected_revision": 0, "facts": {"release": self.fact("not_released")}})
        self.assertEqual(err.exception.code, "UPGRADE_REQUIRED")
        with self.assertRaises(Error) as err:
            execute(workspace, {"action": "workspace.upgrade", "actor": "lead", "expected_revision": 1, "source_execution_stopped": True, "note": "模拟旧执行停止"})
        self.assertEqual(err.exception.code, "UPGRADE_BUSY")
        old_call("task.pause", project="orders", requirement="123", task="worker", note="旧执行已停止", expected_revision=1)
        backup_path = self.home / "old-backup.zip"
        old_call("backup.create", destination=str(backup_path))
        execute(workspace, {"action": "workspace.upgrade", "actor": "lead", "expected_revision": 1, "source_execution_stopped": True, "note": "备份后升级"})
        self.assertEqual(Runtime(workspace).store.version("workspace.json", 1)["schema"], 1)
        for name, content in before.items():
            if str(name).endswith('/runs/old/one.json') or str(name).endswith('/state.json'):
                self.assertEqual((workspace / name).read_bytes(), content)
        proc = subprocess.run([sys.executable, str(old), "--workspace", str(workspace)],
            input=json.dumps({"action": "resume", **args}), text=True, capture_output=True)
        self.assertEqual(json.loads(proc.stdout)["error"]["code"], "UNSUPPORTED_SCHEMA")
        execute(workspace, {"action": "workflow.record", **args, "expected_revision": 0, "facts": {"release": self.fact("not_released")}})
        restored = self.home / "old-backup-restored"
        execute(workspace, {"action": "backup.restore", "archive": str(backup_path), "destination": str(restored)})
        original = execute(restored, {"action": "resume", **args})
        self.assertEqual(original["workspace_runtime_schema"], 1)
        self.assertEqual(original["runs"][0]["recorded_results"]["failed"], 1)

    def test_interrupted_upgrade_keeps_original_workspace_marker(self):
        _, workspace, old_call = self.legacy_workspace()
        old_call("task.pause", project="orders", requirement="123", task="worker", note="停止", expected_revision=1)
        marker = Runtime(workspace).store.path("workspace.json")
        before = marker.read_bytes()
        def fail_marker(path, content, replace=True):
            if path == marker:
                raise OSError("simulated crash before workspace marker replacement")
            return atomic_bytes(path, content, replace)
        with patch("qaw.storage.atomic_bytes", side_effect=fail_marker):
            with self.assertRaises(OSError):
                execute(workspace, {"action": "workspace.upgrade", "actor": "lead", "expected_revision": 1, "source_execution_stopped": True, "note": "合成升级"})
        self.assertEqual(marker.read_bytes(), before)
        self.assertEqual(execute(workspace, {"action": "resume", "project": "orders", "requirement": "123"})["workspace_runtime_schema"], 1)
        # An unreachable format-2 revision must not break the old backup scanner.
        saved = old_call("backup.create", destination=str(self.home / "after-interruption.zip"))
        self.assertTrue(saved["complete_for_registered_snapshots"])

    def test_upgrade_cannot_bypass_a_paused_unknown_operation_or_held_resource(self):
        _, workspace, old_call = self.legacy_workspace()
        scope = {"project": "orders", "requirement": "123", "task": "worker"}
        held = old_call("resource.acquire", **scope, resource="synthetic:target")
        old_call("operation.prepare", **scope, operation="write", resource="synthetic:target", resource_revision=held['revision'],
                 intent="合成写入", correlation="synthetic-1", target="synthetic-object")
        old_call("operation.dispatch", **scope, operation="write", expected_revision=1)
        old_call("task.pause", **scope, note="已暂停新操作", expected_revision=1)
        request = {"action": "workspace.upgrade", "actor": "lead", "expected_revision": 1, "source_execution_stopped": True, "note": "合成核对"}
        with self.assertRaises(Error) as err:
            execute(workspace, request)
        self.assertEqual(err.exception.code, "UPGRADE_BUSY")
        self.assertEqual(len(err.exception.details['unconfirmed_operations']), 1)
        old_call("operation.resolve", **scope, operation="write", result="not_applied", note="合成回查未应用", evidence=['basis'], expected_revision=2)
        with self.assertRaises(Error) as err:
            execute(workspace, request)
        self.assertEqual(len(err.exception.details['held_resources']), 1)
        old_call("resource.release", **scope, resource="synthetic:target", expected_revision=held['revision'])
        result = execute(workspace, request)
        self.assertFalse(result['external_action_executed'])


if __name__ == "__main__":
    unittest.main()
