#!/usr/bin/env python3
"""Exercise the public CLI with synthetic data and measure bounded catalog reads."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time

DEV = Path(__file__).resolve().parents[1]
SCRIPTS = DEV / "skills/qa-workflow/scripts"
sys.path.insert(0, str(SCRIPTS))
from qaw.runtime import Runtime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="A new directory for synthetic fixtures and receipts")
    parser.add_argument("--scale", type=int, default=200)
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    root = out / "workspace"
    receipts = []

    def cli(action, workspace=root, **fields):
        request = {"action": action, "actor": "lead", **fields}
        start = time.perf_counter()
        process = subprocess.run([sys.executable, str(SCRIPTS / "qa.py"), "--workspace", str(workspace)],
                                 input=json.dumps(request), text=True, capture_output=True)
        result = json.loads(process.stdout)
        if process.returncode or not result["ok"]:
            raise RuntimeError(result)
        receipts.append({"action": action, "elapsed_ms": round((time.perf_counter() - start) * 1000, 3),
                         "result": result["result"]})
        return result["result"]

    example = json.loads((DEV / "skills/qa-workflow/assets/examples/requests.json").read_text())
    for request in example["requests"]:
        cli(**request)
    cli("shared.publish", shared="bug-format", kind="config", title="虚构默认字段", projects=["orders", "catalog"],
        source="演示约定", content={"severity": 3, "format": "steps-result-expected"}, overridable_keys=["severity"])
    for project, severity in [("orders", 3), ("catalog", 2)]:
        cli("shared.attach", project=project, shared="bug-format", revision=1, expected_revision=1, overrides={"severity": severity})
    ctx = {"project": "orders", "requirement": "12345"}
    worker = {**ctx, "task": "worker-1", "actor": "worker-a"}
    source = out / "synthetic-evidence.txt"
    source.write_text("SYNTHETIC FIXTURE. No browser, API or business acceptance occurred.\n")
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    snapshot = cli("artifact.import", **ctx, artifact="proof", source_path=str(source), purpose="虚构记录演示夹具")
    cli("task.create", **ctx, task="worker-1", owner="worker-a", scope="仅演示状态管理，未执行任何业务页面", run="demo-1", cases=["view", "approve", "empty"],
        inputs=["proof"], context={"environment": "synthetic", "build": "fixture-v1", "roles": ["demo-role"]})
    cli("case.record", **worker, case="view", status="passed", basis="虚构状态演示", evidence=["proof"], expected_revision=0)
    cli("case.record", **worker, case="approve", status="failed", basis="虚构状态演示", evidence=["proof"], bugs=["demo-bug-1"], expected_revision=0)
    held = cli("resource.acquire", **worker, resource="demo:page")
    cli("operation.prepare", **worker, operation="demo-submit", resource="demo:page", resource_revision=held["revision"],
        intent="模拟一个结果待核实的请求记录", correlation="fixture-request-1", target="fictional-service")
    cli("operation.dispatch", **worker, operation="demo-submit", expected_revision=1)
    before = cli("resume", **ctx)
    assert before["unconfirmed_operation_count"] == 1
    assert before["runs"][0]["recorded_results"] == {"passed": 1, "failed": 1, "blocked": 0, "not_run": 1}
    archive = out / "foundation-backup.zip"
    cli("backup.create", destination=str(archive))
    cli("backup.verify", archive=str(archive))
    restored = out / "restored"
    cli("backup.restore", archive=str(archive), destination=str(restored))
    source.write_text("Changed original; registered snapshot must remain intact.\n")
    restored_snapshot = restored / snapshot["snapshot"]
    assert hashlib.sha256(restored_snapshot.read_bytes()).hexdigest() == original_hash
    recovered = cli("resume", workspace=restored, **ctx)
    assert recovered["restored_review_required"] and recovered["unconfirmed_operation_count"] == 1
    cli("operation.resolve", workspace=restored, **worker, operation="demo-submit", result="not_applied",
        evidence=["proof"], note="演示中从未调用业务服务，已核对脚本执行范围", expected_revision=2)
    cli("resource.release", workspace=restored, **worker, resource="demo:page", expected_revision=1)
    cli("restore.activate", workspace=restored, source_execution_stopped=True, note="演示没有后台业务执行者，已核对快照和状态", expected_revision=1)
    cli("task.transfer", workspace=restored, **ctx, task="worker-1", new_owner="worker-b", previous_owner_stopped=True,
        note="虚构任务交接演示", expected_revision=1)
    cli("summary.write", workspace=restored, **ctx)
    after = cli("resume", workspace=restored, **ctx)
    assert after["tasks"][0]["owner"] == "worker-b" and not after["restored_review_required"]
    assert after["unconfirmed_operation_count"] == 0
    assert cli("resume", **ctx)["unconfirmed_operation_count"] == 1  # Source was not overwritten.

    samples = {}
    with tempfile.TemporaryDirectory(prefix="qaw-scale-") as temp:
        runtime = Runtime(temp)
        runtime.dispatch({"action": "workspace.init", "title": "Synthetic scale test", "actor": "lead"})
        runtime.dispatch({"action": "project.create", "project": "demo", "title": "demo", "actor": "lead"})
        for i in range(args.scale):
            runtime.dispatch({"action": "requirement.create", "project": "demo", "requirement": str(i), "title": f"虚构需求 {i}", "actor": "lead"})
            if i + 1 in {10, args.scale}:
                durations = []
                for _ in range(5):
                    start = time.perf_counter()
                    result = runtime.dispatch({"action": "list", "project": "demo", "limit": 10})
                    durations.append((time.perf_counter() - start) * 1000)
                assert len(result["items"]) == 10 and result["total"] == i + 2
                samples[str(i + 1)] = {"requirements": i + 1, "returned_items": len(result["items"]),
                    "response_bytes": len(json.dumps(result, ensure_ascii=False).encode()),
                    "median_local_ms": round(statistics.median(durations), 3), "samples": 5}
    report = {"synthetic_only": True, "business_requests": 0, "cli_calls": len(receipts),
              "python": platform.python_version(), "os": platform.system(), "architecture": platform.machine(),
              "workflow_passed": True, "snapshot_preserved": True, "source_workspace_preserved": True,
              "scale": samples, "billing_tokens_measured": False,
              "limits": ["只有本机 Python 与文件系统验证", "资源与身份是协作标识，不能强制约束外部工具", "备份为本地副本，未验证异地或加密存储", "未测试 Codex 自动触发、WorkBuddy 或公司 SkillHub"]}
    (out / "receipts.json").write_text(json.dumps(receipts, ensure_ascii=False, indent=2) + "\n")
    (out / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
