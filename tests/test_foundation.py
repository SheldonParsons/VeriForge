"""Behavioral tests using only synthetic local workspaces and artifacts."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPTS = Path(__file__).resolve().parents[1] / "skills/qa-workflow/scripts"
sys.path.insert(0, str(SCRIPTS))
from qa import execute
from qaw import backup
from qaw.runtime import Runtime, base
from qaw.storage import Error, Store, atomic_bytes, encoded


class Foundation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.root = self.home / "workspace"
        self.rt = Runtime(self.root)
        self.call("workspace.init", title="虚构测试工作台")
        for project in ["orders", "catalog"]:
            self.call("project.create", project=project, title=project, systems={"client": "客户端", "admin": "管理端"})
            self.call("requirement.create", project=project, requirement="12345", title=project + "示例需求",
                      systems=[{"project": project, "system": "client"}])

    def tearDown(self):
        self.temp.cleanup()

    def call(self, action, **q):
        return execute(self.root, {"action": action, "actor": "lead", **q})

    def req(self, action, **q):
        return self.call(action, **{"project": "orders", "requirement": "12345", **q})

    def task(self, task="worker", owner="alice", cases=None, project="orders"):
        return self.call("task.create", project=project, requirement="12345", task=task, owner=owner,
                         scope="虚构场景执行", run="round-1", cases=cases or ["view", "approve", "empty"])

    def evidence(self, key="screen", **q):
        source = self.home / (key + ".txt")
        source.write_text("Synthetic evidence only: " + key, encoding="utf-8")
        return self.req("artifact.import", artifact=key, source_path=str(source), purpose="测试夹具", **q)

    def err(self, code, function, *args, **kwargs):
        with self.assertRaises(Error) as cm:
            function(*args, **kwargs)
        self.assertEqual(cm.exception.code, code)

    def test_same_number_projects_and_cross_system_requirement(self):
        self.req("state.update", expected_revision=1, stages={"analysis": {"status": "completed", "basis": "用户确认"}}, next="写用例")
        other = self.call("resume", project="catalog", requirement="12345")
        self.assertEqual(other["revision"], 1)
        self.assertEqual(other["requirement"]["stages"], {})
        self.req("requirement.create", requirement="sso", title="虚构跨项目需求", systems=[
            {"project": "orders", "system": "client"}, {"project": "catalog", "system": "admin"}])
        self.assertEqual(len(self.req("resume", requirement="sso")["requirement"]["systems"]), 2)
        self.err("UNKNOWN_SYSTEM", self.req, "requirement.create", requirement="bad", title="错误系统", systems=[{"project": "orders", "system": "unknown"}])
        self.err("NOT_COORDINATOR", self.req, "state.update", actor="alice", expected_revision=2, next="不应写入")

    def test_shared_pins_overrides_scope_and_updates(self):
        self.call("shared.publish", shared="bug-defaults", kind="config", title="BUG 默认项", projects=["orders"],
                  source="团队确认", content={"severity": 3, "format": "steps-result-expected"}, overridable_keys=["severity"])
        self.call("shared.attach", project="orders", shared="bug-defaults", revision=1, expected_revision=1, overrides={"severity": 2})
        self.err("SHARED_SCOPE", self.call, "shared.attach", project="catalog", shared="bug-defaults", revision=1, expected_revision=1)
        self.err("RULE_OVERRIDE", self.call, "shared.attach", project="orders", shared="bug-defaults", revision=1, expected_revision=2, overrides={"format": "changed"})
        self.task()
        self.call("shared.publish", shared="bug-defaults", kind="config", title="BUG 默认项", projects=["orders"],
                  source="团队确认修订", content={"severity": 3, "format": "new-format"}, overridable_keys=["severity"], expected_revision=1)
        value = self.call("shared.resolve", project="orders", shared="bug-defaults", include_content=True)["items"][0]
        self.assertEqual(value["content"], {"severity": 2, "format": "steps-result-expected"})
        self.assertEqual(value["latest_revision"], 2)
        self.assertEqual(self.req("resume")["tasks"][0]["shared_changes"], [{"shared": "bug-defaults", "used": 1, "latest": 2}])

    def test_stale_revision_and_previous_valid_record_survives_interruption(self):
        ref = base("orders", "12345") + "/state.json"
        old = self.rt.store.read(ref)
        def fail_current(path, content, replace=True):
            if path == self.rt.store.path(ref):
                raise OSError("simulated interruption before current replacement")
            return atomic_bytes(path, content, replace)
        with patch("qaw.storage.atomic_bytes", side_effect=fail_current):
            with self.assertRaises(OSError):
                self.req("state.update", expected_revision=1, next="未提交的变化")
        self.assertEqual(self.rt.store.read(ref), old)
        self.req("state.update", expected_revision=1, next="已保存的新进度")
        self.err("REVISION_CONFLICT", self.req, "state.update", expected_revision=1, next="过期写入")
        history = self.call("record.history", path=ref)
        self.assertEqual([r["revision"] for r in history["items"]], [2, 1])
        self.assertEqual(self.rt.store.version(ref, 1), old)

    def test_two_cli_writers_do_not_lose_updates(self):
        def writer(next_value):
            request = {"action": "state.update", "actor": "lead", "project": "orders", "requirement": "12345", "expected_revision": 1, "next": next_value}
            p = subprocess.run([sys.executable, str(SCRIPTS / "qa.py"), "--workspace", str(self.root)],
                               input=json.dumps(request), text=True, capture_output=True)
            return json.loads(p.stdout)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(writer, ["第一位写入者", "第二位写入者"]))
        self.assertEqual(sum(r["ok"] for r in results), 1)
        failed = [r for r in results if not r["ok"]][0]
        self.assertIn(failed["error"]["code"], {"WORKSPACE_BUSY", "REVISION_CONFLICT"})
        self.assertEqual(self.req("resume")["revision"], 2)

    def test_task_overlap_resource_conflict_and_handoff(self):
        self.task()
        self.err("TASK_OVERLAP", self.task, task="duplicate", owner="bob", cases=["view"])
        self.task(task="other", owner="bob", project="catalog")
        held = self.req("resource.acquire", task="worker", actor="alice", resource="mind:shared-map")
        self.err("RESOURCE_BUSY", self.call, "resource.acquire", project="catalog", requirement="12345", task="other", actor="bob", resource="mind:shared-map")
        self.err("PENDING_WORK", self.req, "task.transfer", task="worker", new_owner="charlie", previous_owner_stopped=True, note="已核对", expected_revision=1)
        self.req("resource.release", task="worker", actor="alice", resource="mind:shared-map", expected_revision=held["revision"])
        self.req("task.transfer", task="worker", new_owner="charlie", previous_owner_stopped=True, note="原执行已停止", expected_revision=1)
        self.err("NOT_OWNER", self.req, "resource.acquire", task="worker", actor="alice", resource="mind:shared-map")
        self.req("resource.acquire", task="worker", actor="charlie", resource="mind:shared-map")

    def prepare_unknown(self):
        self.task()
        held = self.req("resource.acquire", task="worker", actor="alice", resource="tracker:demo")
        prepared = self.req("operation.prepare", task="worker", actor="alice", operation="submit-1", resource="tracker:demo",
                            resource_revision=held["revision"], intent="提交虚构 BUG", correlation="demo-request-1", target="demo-project")
        self.assertFalse(prepared["external_action_executed"])
        self.req("operation.dispatch", task="worker", actor="alice", operation="submit-1", expected_revision=1)
        return held

    def test_unknown_write_is_not_replayed_or_transferred(self):
        held = self.prepare_unknown()
        self.assertEqual(len(self.req("resume")["unconfirmed_operations"]), 1)
        self.err("OPERATION_STATE", self.req, "operation.dispatch", task="worker", actor="alice", operation="submit-1", expected_revision=2)
        self.err("PENDING_WORK", self.req, "operation.prepare", task="worker", actor="alice", operation="submit-2", resource="tracker:demo",
                 resource_revision=held["revision"], intent="不应再次提交", correlation="demo-request-2", target="demo-project")
        self.err("PENDING_WORK", self.req, "resource.release", task="worker", actor="alice", resource="tracker:demo", expected_revision=held["revision"])
        self.err("EVIDENCE_REQUIRED", self.req, "operation.resolve", task="worker", actor="alice", operation="submit-1", result="confirmed", note="缺证据", expected_revision=2)
        self.evidence("readback")
        self.req("operation.resolve", task="worker", actor="alice", operation="submit-1", result="confirmed", note="核对到 demo-bug-1", evidence=["readback"], expected_revision=2)
        self.req("resource.release", task="worker", actor="alice", resource="tracker:demo", expected_revision=held["revision"])
        self.assertEqual(self.req("resume")["unconfirmed_operations"], [])

    def test_resource_reacquisition_invalidates_old_preparation(self):
        self.task()
        first = self.req("resource.acquire", task="worker", actor="alice", resource="page:demo")
        self.req("operation.prepare", task="worker", actor="alice", operation="old", resource="page:demo", resource_revision=first["revision"],
                 intent="虚构提交", correlation="old-request", target="demo")
        self.req("resource.release", task="worker", actor="alice", resource="page:demo", expected_revision=1)
        self.req("resource.acquire", task="worker", actor="alice", resource="page:demo")
        self.err("RESOURCE_CHANGED", self.req, "operation.dispatch", task="worker", actor="alice", operation="old", expected_revision=1)

    def test_case_results_bug_dedup_and_sync_are_separate(self):
        self.task()
        self.evidence()
        self.err("EVIDENCE_REQUIRED", self.req, "case.record", task="worker", actor="alice", case="view", status="passed", basis="缺证据", expected_revision=0)
        for case in ["view", "approve"]:
            self.req("case.record", task="worker", actor="alice", case=case, status="failed", basis="虚构条件与观察", evidence=["screen"], bugs=["demo-bug-1"], expected_revision=0)
        summary = self.req("run.summary", run="round-1")
        self.assertEqual(summary["recorded_results"], {"passed": 0, "failed": 2, "blocked": 0, "not_run": 1})
        self.assertEqual(summary["distinct_bug_count"], 1)
        self.assertEqual(summary["pending_sync"], 2)
        self.evidence("mind-receipt")
        self.req("case.sync", task="worker", case="view", receipt="mind-receipt", expected_revision=1)
        self.assertEqual(self.req("run.summary", run="round-1")["pending_sync"], 1)
        self.req("summary.write")
        page = self.root / base("orders", "12345") / "README.md"
        self.assertIn("独立 BUG 1", page.read_text())
        page.write_text("用户自己的内容")
        self.err("USER_FILE_EXISTS", self.req, "summary.write")

    def test_snapshot_is_independent_and_corruption_is_reported(self):
        result = self.evidence()
        (self.home / "screen.txt").unlink()
        self.assertEqual(self.req("resume")["warnings"], [])
        (self.root / result["snapshot"]).write_text("changed")
        self.assertEqual(self.req("resume")["warnings"][0]["code"], "ARTIFACT_DRIFT")
        self.err("BACKUP_INCOMPLETE", self.call, "backup.create", destination=str(self.home / "failed.zip"))
        partial = self.call("backup.create", destination=str(self.home / "partial.zip"), allow_partial=True)
        self.assertFalse(partial["complete_for_registered_snapshots"])

    def test_backup_restore_preserves_history_assets_and_requires_review(self):
        self.evidence()
        self.req("state.update", expected_revision=1, next="等待评审")
        archive = self.home / "backup.zip"
        made = self.call("backup.create", destination=str(archive))
        self.assertTrue(made["complete_for_registered_snapshots"])
        self.assertFalse(made["off_device_copy_verified"])
        self.call("backup.verify", archive=str(archive))
        restored = self.home / "restored"
        self.call("backup.restore", archive=str(archive), destination=str(restored))
        self.assertEqual(len(backup.verify(archive)["entries"]), made["files"])
        rt = Runtime(restored)
        resumed = rt.dispatch({"action": "resume", "project": "orders", "requirement": "12345"})
        self.assertTrue(resumed["restored_review_required"])
        self.assertEqual(resumed["requirement"]["next"], "等待评审")
        self.assertEqual(resumed["warnings"], [])
        ref = base("orders", "12345") + "/state.json"
        self.assertEqual(rt.store.version(ref, 1)["data"]["next"], "")
        rt.dispatch({"action": "restore.activate", "actor": "lead", "source_execution_stopped": True,
                     "note": "虚构源任务已停止，资料已核对", "expected_revision": 1})
        self.assertFalse(rt.dispatch({"action": "resume", "project": "orders", "requirement": "12345"})["restored_review_required"])
        self.err("INVALID_DESTINATION", self.call, "backup.restore", archive=str(archive), destination=str(restored))

    def test_restored_unknown_action_blocks_activation(self):
        self.prepare_unknown()
        archive, dest = self.home / "active.zip", self.home / "review"
        self.call("backup.create", destination=str(archive))
        self.call("backup.restore", archive=str(archive), destination=str(dest))
        rt = Runtime(dest)
        self.err("RECOVERY_REVIEW", rt.dispatch, {"action": "resource.acquire", "actor": "alice", "project": "orders", "requirement": "12345", "task": "worker", "resource": "new-page"})
        self.err("PENDING_WORK", rt.dispatch, {"action": "restore.activate", "actor": "lead", "source_execution_stopped": True,
                                              "note": "仍有未知操作", "expected_revision": 1})

    def test_sensitive_backup_requires_explicit_inclusion(self):
        self.evidence(sensitive=True)
        self.err("BACKUP_INCOMPLETE", self.call, "backup.create", destination=str(self.home / "blocked.zip"))
        full = self.call("backup.create", destination=str(self.home / "private.zip"), include_sensitive=True)
        self.assertTrue(full["complete_for_registered_snapshots"])

    def test_archive_and_rebuild_do_not_remove_source_records(self):
        before = self.rt.store.read(base("orders", "12345") + "/state.json")
        self.req("requirement.archive", archived=True, reason="设计讨论暂结", expected_revision=1)
        self.assertEqual(self.call("list", project="orders", requirement="12345")["total"], 0)
        self.assertEqual(self.call("list", project="orders", requirement="12345", include_archived=True)["total"], 1)
        (self.root / ".qa/catalog.json").write_text("broken cache")
        self.call("index.rebuild")
        self.assertEqual(self.rt.store.version(base("orders", "12345") + "/state.json", 1), before)
        self.req("requirement.archive", archived=False, reason="重新开启", expected_revision=2)
        self.assertEqual(self.call("list", project="orders", requirement="12345")["total"], 1)

    def test_traversal_symlinks_corrupt_records_and_future_schema_are_rejected(self):
        self.err("INVALID_ID", self.call, "project.create", project="../escape", title="x")
        outside = self.home / "outside"
        outside.mkdir()
        os.symlink(outside, self.root / "projects/linked")
        self.err("SYMLINK", self.call, "project.create", project="linked", title="x")
        path = self.root / base("orders", "12345") / "state.json"
        original = path.read_bytes()
        d = json.loads(original)
        d["data"]["next"] = "edited outside runtime"
        path.write_bytes(encoded(d))
        self.err("INTEGRITY", self.req, "resume")
        d["schema"] = 99
        path.write_bytes(encoded(d))
        self.err("UNSUPPORTED_SCHEMA", self.req, "resume")
        self.assertEqual(json.loads(path.read_bytes())["schema"], 99)

    def test_unsafe_and_tampered_archives_never_restore_over_user_files(self):
        archive = self.home / "good.zip"
        self.call("backup.create", destination=str(archive))
        tampered = self.home / "tampered.zip"
        with zipfile.ZipFile(archive) as src, zipfile.ZipFile(tampered, "w") as dst:
            for name in src.namelist():
                dst.writestr(name, b"tampered" if name == "data/workspace.json" else src.read(name))
        self.err("INTEGRITY", self.call, "backup.restore", archive=str(tampered), destination=str(self.home / "not-created"))
        self.assertFalse((self.home / "not-created").exists())
        malicious = self.home / "malicious.zip"
        content = b"escape"
        manifest = {"format": "qa-workflow-backup", "schema": 1, "entries": [{"path": "../escape.txt", "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}]}
        with zipfile.ZipFile(malicious, "w") as z:
            z.writestr("manifest.json", json.dumps(manifest))
            z.writestr("data/../escape.txt", content)
        self.err("INVALID_PATH", self.call, "backup.restore", archive=str(malicious), destination=str(self.home / "bad-restore"))
        self.assertFalse((self.home / "escape.txt").exists())

    def test_stale_workspace_lock_is_not_automatically_stolen(self):
        lock = self.root / ".qa/write.lock"
        lock.mkdir()
        (lock / "owner.json").write_text('{"pid": 99999999, "token": "old"}')
        self.err("WORKSPACE_BUSY", self.req, "state.update", expected_revision=1, next="不应覆盖")
        self.assertTrue(lock.exists())
        self.assertTrue(self.call("lock.inspect")["locked"])

    def test_cli_invalid_json_has_compact_error_and_no_write(self):
        p = subprocess.run([sys.executable, str(SCRIPTS / "qa.py"), "--workspace", str(self.root)],
                           input="not JSON", text=True, capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(json.loads(p.stdout)["error"]["code"], "INVALID_INPUT")
        self.assertNotIn("Traceback", p.stderr)

    def test_skill_directory_cannot_be_used_as_workspace(self):
        self.err("INVALID_WORKSPACE", Runtime, SCRIPTS.parent / "user-data")
        self.assertFalse((SCRIPTS.parent / "user-data").exists())

    def test_task_pins_input_and_execution_context(self):
        self.evidence("cases-v1")
        self.req("task.create", task="pinned", owner="alice", scope="虚构执行", run="round-1", cases=["view"],
                 inputs=["cases-v1"], context={"environment": "synthetic", "build": "v1", "roles": ["tester"]})
        (self.home / "cases-v1.txt").write_text("Original changed after capture")
        data = self.req("resume")
        self.assertEqual(data["warnings"], [])
        self.assertEqual(data["tasks"][0]["context"]["build"], "v1")
        self.req("case.record", task="pinned", actor="alice", case="view", status="passed", evidence=["cases-v1"], basis="虚构断言", expected_revision=0)
        result = self.call("record.read", path=base("orders", "12345") + "/runs/round-1/view.json")
        self.assertEqual(result["data"]["inputs"][0]["sha256"], data["tasks"][0]["inputs"][0]["sha256"])

    def test_resume_pages_tasks_and_shared_content_requires_explicit_selection(self):
        for i in range(23):
            self.req("task.create", task=f"analysis-{i}", owner=f"owner-{i}", scope="独立资料整理")
        page = self.req("resume")
        self.assertEqual(len(page["tasks"]), 20)
        self.assertEqual(page["task_count"], 23)
        self.assertEqual(page["next_task_offset"], 20)
        self.assertEqual(len(self.req("resume", offset=20)["tasks"]), 3)
        self.call("shared.publish", shared="format", kind="template", title="模板", projects=["orders"], source="虚构来源", content="long content")
        self.call("shared.attach", project="orders", shared="format", revision=1, expected_revision=1)
        self.assertNotIn("content", self.call("shared.resolve", project="orders")["items"][0])
        self.err("INVALID_INPUT", self.call, "shared.resolve", project="orders", include_content=True)


if __name__ == "__main__":
    unittest.main()
