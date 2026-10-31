"""Scoped local state operations. All actors are cooperative labels, not authentication."""

import copy
import hashlib
import os
from pathlib import Path
import tempfile
import uuid

from .storage import Error, Store, atomic_bytes, file_digest, now, require, slug, sync_directory, text


READS = {"list", "record.read", "record.history", "resume", "shared.resolve", "run.summary", "lock.inspect"}
EXECUTION = {"resource.acquire", "operation.prepare", "operation.dispatch", "case.record"}
STAGES = {"analysis", "page_evidence", "cases", "review", "execution", "defects", "retest", "knowledge", "closeout"}
STATES = {"not_started", "in_progress", "ready_for_review", "completed", "blocked", "skipped"}


def project_ref(project):
    return f"projects/{slug(project)}/project.json"


def base(project, requirement):
    return f"projects/{slug(project)}/requirements/{slug(requirement)}"


def receipt(ref, record, **extra):
    return {"path": ref, "revision": record["revision"], "sha256": record["sha256"], **extra}


class Runtime:
    def __init__(self, root):
        self.store = Store(root)

    def dispatch(self, request):
        require(isinstance(request, dict), "INVALID_INPUT", "请求必须是 JSON 对象。")
        q = copy.deepcopy(request)
        action = text(q.get("action"), "action", 80)
        method = getattr(self, "do_" + action.replace(".", "_"), None)
        require(method is not None and not action.startswith("_"), "UNKNOWN_ACTION", "未实现此操作。", action=action)
        if action in READS:
            if action != "lock.inspect":
                self.store.ready()
            return method(q)
        with self.store.locked():
            if action != "workspace.init":
                self.store.ready(execution=action in EXECUTION)
            result = method(q)
            # Catalog is a rebuildable view; a derived write failure does not undo a committed record.
            if action in {"project.create", "requirement.create", "requirement.archive", "state.update"}:
                try:
                    self.store.catalog(persist=True)
                except (OSError, Error) as exc:
                    result["warning"] = "主记录已保存，索引待重建：" + str(exc)
            return result

    def req(self, q):
        prefix = base(q["project"], q["requirement"])
        ref = prefix + "/state.json"
        return prefix, ref, self.store.read(ref)

    def task(self, q, active=True):
        prefix, _, req = self.req(q)
        ref = prefix + f"/tasks/{slug(q['task'])}.json"
        record = self.store.read(ref)
        require(record["data"]["owner"] == q.get("actor"), "NOT_OWNER", "当前任务由其他执行者负责。")
        if active:
            require(record["data"]["status"] == "active" and not req["data"]["archived"],
                    "INACTIVE_TASK", "任务或需求已暂停、关闭或归档。")
        return prefix, ref, record

    def coordinator(self, q, record):
        require(q.get("actor") == record["data"]["coordinator"], "NOT_COORDINATOR", "此记录须由指定负责人维护。")

    def maintainer(self, q):
        require(q.get("actor") == self.store.read("workspace.json")["data"]["maintainer"],
                "NOT_MAINTAINER", "共享配置须由工作空间维护者维护。")

    def task_key(self, q):
        return {"project": q["project"], "requirement": q["requirement"], "task": q["task"]}

    def blockers(self, q, resource=None):
        prefix = base(q["project"], q["requirement"])
        pending = []
        for ref in self.store.refs(prefix + "/operations/*.json"):
            d = self.store.read(ref)["data"]
            if d["status"] == "dispatched" and (resource is None or d["resource"] == resource):
                if "task" not in q or d["task"] == q["task"]:
                    pending.append(ref)
        leases = []
        for ref in self.store.refs(".qa/resources/*.json"):
            d = self.store.read(ref)["data"]
            holder = d.get("holder")
            if holder and holder["project"] == q["project"] and holder["requirement"] == q["requirement"]:
                if "task" not in q or holder["task"] == q["task"]:
                    leases.append(ref)
        return pending, leases

    def systems(self, refs):
        require(isinstance(refs, list), "INVALID_INPUT", "systems 须为项目和系统引用的列表。")
        for item in refs:
            p = self.store.read(project_ref(item["project"]))["data"]
            require(item["system"] in p["systems"], "UNKNOWN_SYSTEM", "系统不属于所选被测项目。")
        return refs

    def do_workspace_init(self, q):
        data = {"kind": "workspace", "id": uuid.uuid4().hex, "title": text(q.get("title"), "title"),
                "maintainer": text(q.get("actor"), "actor", 120), "runtime_schema": 1}
        return receipt("workspace.json", self.store.write("workspace.json", data, 0))

    def do_project_create(self, q):
        self.maintainer(q)
        systems = q.get("systems", {})
        require(isinstance(systems, dict), "INVALID_INPUT", "systems 须为系统标识到名称的映射。")
        for key, value in systems.items():
            slug(key)
            text(value, "system name", 200)
        data = {"kind": "project", "project": slug(q["project"]), "title": text(q.get("title"), "title"),
                "systems": systems, "coordinator": text(q.get("coordinator", q.get("actor")), "coordinator", 120),
                "shared": {}}
        ref = project_ref(q["project"])
        return receipt(ref, self.store.write(ref, data, 0))

    def do_requirement_create(self, q):
        p = self.store.read(project_ref(q["project"]))
        self.coordinator(q, p)
        data = {"kind": "requirement", "project": q["project"], "requirement": slug(q["requirement"]),
                "title": text(q.get("title"), "title"), "systems": self.systems(q.get("systems", [])),
                "coordinator": text(q.get("coordinator", q.get("actor")), "coordinator", 120),
                "stages": {}, "next": q.get("next", ""), "archived": False}
        ref = base(q["project"], q["requirement"]) + "/state.json"
        return receipt(ref, self.store.write(ref, data, 0))

    def do_state_update(self, q):
        _, ref, r = self.req(q)
        self.coordinator(q, r)
        require(not r["data"]["archived"], "ARCHIVED", "需求已归档，请先明确重新开启。")
        d = r["data"]
        require(isinstance(q.get("stages", {}), dict), "INVALID_INPUT", "stages 须为阶段到状态的映射。")
        for stage, value in q.get("stages", {}).items():
            require(stage in STAGES and isinstance(value, dict) and value.get("status") in STATES,
                    "INVALID_STATE", "阶段或状态不支持。")
            if value["status"] in {"completed", "blocked", "skipped"}:
                text(value.get("basis"), "basis")
            d["stages"][stage] = value
        if "next" in q:
            require(isinstance(q["next"], str), "INVALID_INPUT", "next 须为文本。")
            d["next"] = q["next"]
        if "systems" in q:
            d["systems"] = self.systems(q["systems"])
        return receipt(ref, self.store.write(ref, d, q["expected_revision"]))

    def do_requirement_archive(self, q):
        prefix, ref, r = self.req(q)
        self.coordinator(q, r)
        require(isinstance(q.get("archived"), bool), "INVALID_INPUT", "archived 须为布尔值。")
        if q["archived"]:
            pending, leases = self.blockers(q)
            active = [x for x in self.store.refs(prefix + "/tasks/*.json")
                      if self.store.read(x)["data"]["status"] == "active"]
            require(not pending and not leases and not active, "TASKS_ACTIVE", "先处理活跃任务、资源和未知操作。")
        r["data"].update(archived=q["archived"], archive_reason=text(q.get("reason"), "reason"))
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def do_shared_publish(self, q):
        self.maintainer(q)
        kind = q.get("kind")
        require(kind in {"guidance", "template", "rule", "capability", "config"}, "INVALID_INPUT", "共享内容类型不支持。")
        projects = q.get("projects", [])
        require(isinstance(projects, list) and projects, "INVALID_INPUT", "请明确适用项目。")
        for project in projects:
            self.store.read(project_ref(project))
        allowed = q.get("overridable_keys", [])
        require(isinstance(allowed, list) and all(isinstance(x, str) for x in allowed), "INVALID_INPUT", "覆盖字段须为字符串列表。")
        require(not allowed or kind == "config", "RULE_OVERRIDE", "只允许配置默认值声明可覆盖字段，业务规则须另行确认。")
        content = q["content"]
        require(not allowed or (isinstance(content, dict) and all(k in content for k in allowed)),
                "INVALID_INPUT", "可覆盖字段必须存在于配置正文。")
        ref = f"shared/{slug(q['shared'])}.json"
        data = {"kind": kind, "title": text(q.get("title"), "title"), "projects": sorted(set(projects)),
                "source": text(q.get("source"), "source"), "content": content, "overridable_keys": allowed}
        return receipt(ref, self.store.write(ref, data, q.get("expected_revision", 0)))

    def do_shared_attach(self, q):
        ref = project_ref(q["project"])
        p = self.store.read(ref)
        self.coordinator(q, p)
        shared_id = slug(q["shared"])
        s = self.store.version(f"shared/{shared_id}.json", q["revision"])
        require(q["project"] in s["data"]["projects"], "SHARED_SCOPE", "此版本不适用于当前项目。")
        overrides = q.get("overrides", {})
        require(isinstance(overrides, dict) and set(overrides).issubset(s["data"]["overridable_keys"]),
                "RULE_OVERRIDE", "存在未声明可覆盖的字段。")
        p["data"]["shared"][shared_id] = {"revision": s["revision"], "sha256": s["sha256"], "overrides": overrides}
        return receipt(ref, self.store.write(ref, p["data"], q["expected_revision"]))

    def do_shared_resolve(self, q):
        p = self.store.read(project_ref(q["project"]))["data"]
        require(not q.get("include_content") or q.get("shared"), "INVALID_INPUT", "读取正文时请指定单个 shared 标识，避免加载整个共享库。")
        require(not q.get("shared") or q["shared"] in p["shared"], "NOT_FOUND", "当前项目没有此共享引用。")
        items = []
        for key, pin in p["shared"].items():
            if q.get("shared") and key != q["shared"]:
                continue
            ref = f"shared/{key}.json"
            s = self.store.version(ref, pin["revision"])
            require(s["sha256"] == pin["sha256"] and q["project"] in s["data"]["projects"],
                    "SHARED_SCOPE", "共享引用的摘要或适用范围不符。")
            content = copy.deepcopy(s["data"]["content"])
            if pin["overrides"]:
                content.update(pin["overrides"])
            item = {"shared": key, "revision": pin["revision"], "latest_revision": self.store.read(ref)["revision"],
                    "source": s["data"]["source"], "overrides": pin["overrides"]}
            if q.get("include_content"):
                item["content"] = content
            items.append(item)
        return {"project": q["project"], "items": items}

    def do_task_create(self, q):
        prefix, _, req = self.req(q)
        self.coordinator(q, req)
        require(not req["data"]["archived"], "ARCHIVED", "先明确重新开启需求。")
        cases = q.get("cases", [])
        require(isinstance(cases, list) and len(cases) == len(set(cases)), "INVALID_INPUT", "cases 须为不重复的场景标识列表。")
        for case in cases:
            slug(case)
        run = slug(q["run"]) if q.get("run") else None
        require(not cases or run, "INVALID_INPUT", "执行任务须指定运行批次 run。")
        inputs = q.get("inputs", [])
        require(isinstance(inputs, list), "INVALID_INPUT", "inputs 须为来源快照标识列表。")
        pinned_inputs = []
        for artifact_id in inputs:
            artifact = self.artifact(prefix, artifact_id)
            pinned_inputs.append({"artifact": artifact_id, "record_revision": artifact["revision"], "sha256": artifact["data"]["sha256"]})
        context = q.get("context", {})
        require(isinstance(context, dict) and set(context).issubset({"environment", "build", "roles", "data_refs", "systems"}),
                "INVALID_INPUT", "context 仅保存环境、构建、角色引用、数据引用和系统；不放凭据。")
        if "systems" in context:
            self.systems(context["systems"])
        for other_ref in self.store.refs(prefix + "/tasks/*.json"):
            other = self.store.read(other_ref)["data"]
            require(not (other["status"] == "active" and other["run"] == run and set(cases) & set(other["cases"])),
                    "TASK_OVERLAP", "该批次的部分场景已有活跃负责人。", task=other_ref)
        ref = prefix + f"/tasks/{slug(q['task'])}.json"
        data = {"kind": "task", **self.task_key(q), "owner": text(q.get("owner"), "owner", 120),
                "scope": text(q.get("scope"), "scope"), "run": run, "cases": cases, "status": "active",
                "inputs": pinned_inputs, "context": context,
                "session_ref": q.get("session_ref"), "shared": self.store.read(project_ref(q["project"]))["data"]["shared"]}
        return receipt(ref, self.store.write(ref, data, 0))

    def do_task_finish(self, q):
        _, ref, r = self.task(q)
        pending, leases = self.blockers(q)
        require(not pending and not leases, "PENDING_WORK", "先核实未知操作并释放本任务的资源。", operations=pending, resources=leases)
        require(q.get("status") in {"closed", "blocked", "paused"}, "INVALID_STATE", "任务结束状态须为 closed、blocked 或 paused。")
        r["data"].update(status=q["status"], note=text(q.get("note"), "note"))
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def do_task_transfer(self, q):
        prefix, _, req = self.req(q)
        self.coordinator(q, req)
        ref = prefix + f"/tasks/{slug(q['task'])}.json"
        r = self.store.read(ref)
        require(q.get("previous_owner_stopped") is True, "HANDOFF_REQUIRED", "先核对原执行者已停止，不以超时作为交接依据。")
        pending, leases = self.blockers(q)
        require(not pending and not leases, "PENDING_WORK", "存在未知操作或资源占用，暂不能转移任务。",
                operations=pending, resources=leases)
        r["data"].update(owner=text(q.get("new_owner"), "new_owner", 120), status="active",
                         handoff_note=text(q.get("note"), "note"), session_ref=q.get("session_ref"))
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def resource_ref(self, name):
        text(name, "resource", 500)
        return f".qa/resources/{hashlib.sha256(name.encode()).hexdigest()}.json"

    def do_resource_acquire(self, q):
        self.task(q)
        ref = self.resource_ref(q["resource"])
        old = self.store.read(ref, missing=True)
        holder = {**self.task_key(q), "owner": q["actor"]}
        if old and old["data"].get("holder"):
            require(old["data"]["holder"] == holder, "RESOURCE_BUSY", "此资源已有操作者；可先继续独立工作。", holder=old["data"]["holder"])
            return receipt(ref, old, already_held=True)
        data = {"kind": "resource", "resource": q["resource"], "holder": holder}
        return receipt(ref, self.store.write(ref, data, old["revision"] if old else 0))

    def do_resource_release(self, q):
        self.task(q, active=False)
        ref = self.resource_ref(q["resource"])
        r = self.store.read(ref)
        require(r["data"].get("holder") == {**self.task_key(q), "owner": q["actor"]}, "NOT_OWNER", "资源不由本任务持有。")
        pending, _ = self.blockers(q, resource=q["resource"])
        require(not pending, "PENDING_WORK", "资源仍关联结果不明的操作，先回查。", operations=pending)
        r["data"]["holder"] = None
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def artifact(self, prefix, artifact_id):
        ref = prefix + f"/artifacts/{slug(artifact_id)}.json"
        r = self.store.read(ref)
        path = self.store.path(r["data"]["path"])
        require(path.is_file(), "MISSING_ARTIFACT", "已登记的快照文件缺失。", artifact=ref)
        require(file_digest(path) == r["data"]["sha256"],
                "ARTIFACT_DRIFT", "快照文件已变化；保留证据并核对原始来源。", artifact=ref)
        return r

    def do_artifact_import(self, q):
        prefix, _, req = self.req(q)
        if q.get("task"):
            self.task(q)
        else:
            self.coordinator(q, req)
        ref = prefix + f"/artifacts/{slug(q['artifact'])}.json"
        require(not self.store.path(ref).exists(), "ALREADY_EXISTS", "该快照标识已存在，请读取原记录或使用新的版本标识。")
        purpose = text(q.get("purpose"), "purpose")
        require(isinstance(q.get("sensitive", False), bool), "INVALID_INPUT", "sensitive 须为布尔值。")
        source = Path(q["source_path"]).expanduser().resolve()
        require(source.is_file(), "NOT_FOUND", "待保存的来源文件不存在。")
        before = source.stat()
        fd, temporary = tempfile.mkstemp(prefix="capture-", dir=self.store.path(".qa"))
        try:
            sha, size = hashlib.sha256(), 0
            with os.fdopen(fd, "wb") as out, source.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    sha.update(chunk)
                    size += len(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            after = source.stat()
            require((before.st_ino, before.st_mtime_ns, before.st_size) == (after.st_ino, after.st_mtime_ns, after.st_size),
                    "SOURCE_CHANGED", "来源正在变化；先保存原文件，再重新核对。")
            sha = sha.hexdigest()
            asset = f"artifacts/{sha}/{source.name}"
            target = self.store.path(asset)
            if target.exists():
                require(file_digest(target) == sha, "ARTIFACT_DRIFT", "已有同摘要快照损坏。")
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.link(temporary, target)
                sync_directory(target.parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        data = {"kind": "artifact", "artifact": q["artifact"], "path": asset, "sha256": sha,
                "bytes": size, "source": str(source), "captured_at": now(),
                "purpose": purpose, "sensitive": q.get("sensitive", False)}
        return receipt(ref, self.store.write(ref, data, 0), snapshot=asset)

    def do_operation_prepare(self, q):
        prefix, _, _ = self.task(q)
        pending, _ = self.blockers(q, resource=q["resource"])
        require(not pending, "PENDING_WORK", "同一资源还有待核实操作，先回查。", operations=pending)
        resource = self.store.read(self.resource_ref(q["resource"]))
        require(resource["data"].get("holder") == {**self.task_key(q), "owner": q["actor"]},
                "NOT_OWNER", "写操作须先由本任务取得目标资源。")
        require(resource["revision"] == q["resource_revision"], "REVISION_CONFLICT", "资源已交接，请重新核对。")
        ref = prefix + f"/operations/{slug(q['operation'])}.json"
        d = {"kind": "operation", **self.task_key(q), "operation": q["operation"], "status": "prepared",
             "resource": q["resource"], "resource_revision": resource["revision"],
             "intent": text(q.get("intent"), "intent"), "correlation": text(q.get("correlation"), "correlation"),
             "target": text(q.get("target"), "target")}
        return receipt(ref, self.store.write(ref, d, 0), external_action_executed=False)

    def do_operation_dispatch(self, q):
        prefix, _, _ = self.task(q)
        ref = prefix + f"/operations/{slug(q['operation'])}.json"
        r = self.store.read(ref)
        d = r["data"]
        require(d["task"] == q["task"] and d["status"] == "prepared", "OPERATION_STATE", "此操作不可再次派发，先读取或回查原结果。")
        pending, _ = self.blockers(q, resource=d["resource"])
        require(not pending, "PENDING_WORK", "同一资源还有待核实操作，先回查。", operations=pending)
        resource = self.store.read(self.resource_ref(d["resource"]))
        require(resource["revision"] == d["resource_revision"] and resource["data"].get("holder") ==
                {**self.task_key(q), "owner": q["actor"]}, "RESOURCE_CHANGED", "资源归属已变化，不能使用旧准备记录。")
        d.update(status="dispatched", dispatched_at=now())
        return receipt(ref, self.store.write(ref, d, q["expected_revision"]), external_action_executed=False,
                       next="标记已持久化。仅按已授权动作调用实际工具，然后回读结果；超时保留待核实。")

    def do_operation_resolve(self, q):
        prefix, _, _ = self.task(q, active=False)
        ref = prefix + f"/operations/{slug(q['operation'])}.json"
        r = self.store.read(ref)
        require(r["data"]["task"] == q["task"] and r["data"]["status"] in {"prepared", "dispatched"},
                "OPERATION_STATE", "操作归属不符或已经核实。")
        require(q.get("result") in {"confirmed", "not_applied"}, "INVALID_STATE", "结果须为 confirmed 或 not_applied。")
        evidence = q.get("evidence", [])
        require(isinstance(evidence, list) and evidence, "EVIDENCE_REQUIRED", "确认结果须关联已保存的回查证据。")
        for item in evidence:
            self.artifact(prefix, item)
        r["data"].update(status=q["result"], evidence=evidence, result_note=text(q.get("note"), "note"))
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def do_case_record(self, q):
        prefix, _, task = self.task(q)
        case = slug(q["case"])
        d = task["data"]
        require(case in d["cases"] and d["run"], "CASE_SCOPE", "场景不属于本任务的执行范围。")
        status = q.get("status")
        require(status in {"passed", "failed", "blocked", "not_run"}, "INVALID_STATE", "用例结果不支持。")
        evidence = q.get("evidence", [])
        require(isinstance(evidence, list), "INVALID_INPUT", "evidence 须为快照标识列表。")
        if status in {"passed", "failed"}:
            require(evidence, "EVIDENCE_REQUIRED", "通过或失败须有已保存的操作结果证据。")
        for item in evidence:
            self.artifact(prefix, item)
        for item in d.get("inputs", []):
            artifact = self.artifact(prefix, item["artifact"])
            require(artifact["data"]["sha256"] == item["sha256"], "ARTIFACT_DRIFT", "任务来源快照与固定版本不符。")
        bugs = q.get("bugs", [])
        require(isinstance(bugs, list) and all(isinstance(x, str) and x for x in bugs), "INVALID_INPUT", "bugs 须为引用列表。")
        ref = prefix + f"/runs/{d['run']}/{case}.json"
        data = {"kind": "case_result", **self.task_key(q), "run": d["run"], "case": case,
                "status": status, "evidence": evidence, "bugs": sorted(set(bugs)), "sync": "pending",
                "inputs": d.get("inputs", []), "context": d.get("context", {}),
                "basis": text(q.get("basis"), "basis"), "recorded_at": now()}
        return receipt(ref, self.store.write(ref, data, q["expected_revision"]))

    def do_case_sync(self, q):
        prefix, _, req = self.req(q)
        task = self.store.read(prefix + f"/tasks/{slug(q['task'])}.json")
        require(q.get("actor") in {req["data"]["coordinator"], task["data"]["owner"]}, "NOT_OWNER", "同步回执须由任务负责人或协调者核对。")
        case = slug(q["case"])
        require(case in task["data"]["cases"] and task["data"]["run"], "CASE_SCOPE", "场景不属于此任务。")
        ref = prefix + f"/runs/{task['data']['run']}/{case}.json"
        r = self.store.read(ref)
        require(r["data"]["task"] == q["task"], "NOT_OWNER", "结果现由其他任务维护。")
        self.artifact(prefix, q["receipt"])
        r["data"].update(sync="confirmed", sync_receipt=q["receipt"])
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))

    def do_run_summary(self, q):
        prefix, _, _ = self.req(q)
        run = slug(q["run"])
        cases = set()
        for ref in self.store.refs(prefix + "/tasks/*.json"):
            task = self.store.read(ref)["data"]
            if task["run"] == run:
                cases.update(task["cases"])
        counts = dict.fromkeys(["passed", "failed", "blocked", "not_run"], 0)
        bugs, unsynced = set(), 0
        for case in sorted(cases):
            r = self.store.read(prefix + f"/runs/{run}/{case}.json", missing=True)
            counts[r["data"]["status"] if r else "not_run"] += 1
            if r:
                bugs.update(r["data"]["bugs"])
                unsynced += r["data"]["sync"] != "confirmed"
        return {"run": run, "total": len(cases), "recorded_results": counts,
                "distinct_bug_count": len(bugs), "bugs": sorted(bugs), "pending_sync": unsynced,
                "scope": "本轮已分配的场景；不代表需求全部用例已覆盖"}

    def do_resume(self, q):
        prefix, ref, r = self.req(q)
        pending, leases = self.blockers(q)
        tasks, warnings = [], []
        for task_ref in self.store.refs(prefix + "/tasks/*.json"):
            if q.get("task") and Path(task_ref).stem != slug(q["task"]):
                continue
            t = self.store.read(task_ref)
            d = t["data"]
            if d["cases"] and not d.get("inputs"):
                warnings.append({"code": "INPUT_VERSION_UNPINNED", "task": d["task"], "note": "真实执行前固定用例或来源快照，当前只登记了场景范围。"})
            changes = []
            for key, pin in d["shared"].items():
                shared = self.store.version(f"shared/{key}.json", pin["revision"])
                require(shared["sha256"] == pin["sha256"], "INTEGRITY", "任务引用的共享版本不符。")
                latest = self.store.read(f"shared/{key}.json")["revision"]
                if latest != pin["revision"]:
                    changes.append({"shared": key, "used": pin["revision"], "latest": latest})
            tasks.append({"task": d["task"], "owner": d["owner"], "status": d["status"], "scope": d["scope"],
                          "revision": t["revision"], "run": d["run"], "shared_changes": changes,
                          "inputs": d.get("inputs", []), "context": d.get("context", {})})
        for artifact_ref in self.store.refs(prefix + "/artifacts/*.json"):
            try:
                self.artifact(prefix, Path(artifact_ref).stem)
            except Error as exc:
                warnings.append({"code": exc.code, "artifact": artifact_ref})
        recovery = self.store.read(".qa/recovery.json", missing=True)
        offset, limit = q.get("offset", 0), q.get("limit", 20)
        require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 100,
                "INVALID_INPUT", "offset 必须非负，limit 须为 1—100。")
        selected = tasks[offset:offset + limit]
        runs = sorted({t["run"] for t in selected if t["run"]})
        return {"path": ref, "revision": r["revision"], "requirement": r["data"], "tasks": selected,
                "task_count": len(tasks), "next_task_offset": offset + limit if offset + limit < len(tasks) else None,
                "runs": [self.do_run_summary({**q, "run": run}) for run in runs],
                "unconfirmed_operations": pending[:limit], "unconfirmed_operation_count": len(pending),
                "held_resources": leases[:limit], "held_resource_count": len(leases), "warnings": warnings[:limit],
                "warning_count": len(warnings), "details_truncated": max(len(pending), len(leases), len(warnings)) > limit,
                "restored_review_required": bool(recovery and not recovery["data"]["reviewed"]),
                "note": "仅恢复本地记录。继续业务前核对环境、版本、身份及实际单据；本工具没有执行页面或远端调用。"}

    def do_list(self, q):
        items = self.store.catalog()
        if q.get("project"):
            items = [x for x in items if x["project"] == slug(q["project"])]
        if q.get("requirement"):
            items = [x for x in items if x["requirement"] == slug(q["requirement"])]
        if not q.get("include_archived", False):
            items = [x for x in items if not x["archived"]]
        if q.get("query"):
            items = [x for x in items if q["query"].casefold() in (x["title"] + " " + (x["requirement"] or "")).casefold()]
        offset, limit = q.get("offset", 0), q.get("limit", 20)
        require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 100,
                "INVALID_INPUT", "offset 必须非负，limit 须为 1—100。")
        return {"total": len(items), "items": items[offset:offset + limit],
                "next_offset": offset + limit if offset + limit < len(items) else None}

    def do_index_rebuild(self, q):
        return {"items": len(self.store.catalog(persist=True)), "source": "canonical records"}

    def do_summary_write(self, q):
        prefix, _, req = self.req(q)
        self.coordinator(q, req)
        data = self.do_resume({**q, "offset": 0, "limit": 100})
        path = self.store.path(prefix + "/README.md")
        marker = "<!-- qa-workflow generated summary -->"
        require(not path.exists() or path.read_text(encoding="utf-8").startswith(marker),
                "USER_FILE_EXISTS", "已有人工维护的 README，保留原文，不覆盖。")
        lines = [marker, "# " + req["data"]["title"], "", f"生成时间：{now()}；需求状态修订：{req['revision']}。",
                 "这是可重建摘要；后续变更请通过 resume 核对。", "", "## 阶段", ""]
        for stage, value in req["data"]["stages"].items():
            lines.append(f"- {stage}：{value['status']}；依据：{value.get('basis', '尚未记录')}")
        lines.extend(["", "## 任务与运行", ""])
        for task in data["tasks"]:
            lines.append(f"- {task['task']}：{task['status']}，负责人 {task['owner']}，批次 {task['run'] or '无'}。")
        for run in data["runs"]:
            lines.append(f"- 批次 {run['run']}：{run['recorded_results']}；独立 BUG {run['distinct_bug_count']}；待同步 {run['pending_sync']}。")
        lines.extend(["", "## 待核实与下一步", "", f"- 未知操作：{data['unconfirmed_operation_count']}。",
                      f"- 占用资源：{data['held_resource_count']}。", f"- 产物核对警告：{data['warning_count']}。",
                      f"- 本页列出 {len(data['tasks'])}/{data['task_count']} 项任务；其余通过 resume 分页读取。",
                      f"- 下一步：{req['data']['next'] or '尚未记录'}。", ""])
        atomic_bytes(path, "\n".join(lines).encode("utf-8"))
        return {"path": path.relative_to(self.store.root).as_posix(), "source_revision": req["revision"], "derived": True}

    def do_record_read(self, q):
        ref = q["path"]
        require(ref in self.store.records(), "NOT_FOUND", "仅可读取已登记类型的状态记录。")
        return self.store.version(ref, q["revision"]) if "revision" in q else self.store.read(ref)

    def do_record_history(self, q):
        ref = q["path"]
        require(ref in self.store.records(), "NOT_FOUND", "未找到记录。")
        head = self.store.read(ref)
        limit = q.get("limit", 20)
        require(type(limit) is int and 1 <= limit <= 100, "INVALID_INPUT", "limit 须为 1—100。")
        items = []
        for revision in range(head["revision"], max(0, head["revision"] - limit), -1):
            r = self.store.version(ref, revision)
            items.append({"revision": revision, "updated_at": r["updated_at"], "sha256": r["sha256"]})
        return {"path": ref, "items": items, "earlier_revisions": max(0, head["revision"] - limit)}

    def do_lock_inspect(self, q):
        path = self.store.path(".qa/write.lock/owner.json")
        return {"locked": path.parent.exists(), "owner_file": str(path) if path.exists() else None,
                "note": "不会自动删除锁；中断恢复须先确认原进程与操作状态。"}

    def do_restore_activate(self, q):
        self.maintainer(q)
        ref = ".qa/recovery.json"
        r = self.store.read(ref)
        require(q.get("source_execution_stopped") is True, "HANDOFF_REQUIRED", "先确认源工作空间的执行已停止。")
        unknown = [ref for ref in self.store.records() if "/operations/" in ref and self.store.read(ref)["data"]["status"] == "dispatched"]
        held = [ref for ref in self.store.refs(".qa/resources/*.json") if self.store.read(ref)["data"].get("holder")]
        require(not unknown and not held, "PENDING_WORK", "恢复副本中仍有未知操作或占用资源，先回查和交接。", operations=unknown, resources=held)
        r["data"].update(reviewed=True, note=text(q.get("note"), "note"))
        return receipt(ref, self.store.write(ref, r["data"], q["expected_revision"]))
