"""Local workflow facts, pinned deliverables and follow-ups. No external calls."""

from .storage import now, receipt, require, slug, text


FACT_STATES = {
    "business": {"pending", "ready", "blocked"},
    "page_steps": {"pending", "partial", "verified", "blocked", "not_applicable"},
    "execution": {"pending", "ready", "blocked", "not_applicable"},
    "review": {"not_requested", "pending", "completed", "not_applicable"},
    "release": {"unknown", "not_released", "released", "rolled_back"},
    "stability": {"unknown", "confirmed", "changing"},
    "knowledge": {"not_requested", "draft", "final_local", "pending_confirmation", "submitted_unverified", "synced", "cancelled"},
    "restoration": {"not_required", "pending", "completed", "blocked"},
}
PROVEN_FACTS = {("business", "ready"), ("page_steps", "verified"), ("execution", "ready"),
                ("review", "completed"), ("release", "released"), ("stability", "confirmed"),
                ("knowledge", "synced"), ("restoration", "completed")}
DELIVERABLE_ROLES = {"requirement", "case_set", "page_evidence", "bug", "knowledge", "run_evidence", "handoff", "user_requested"}
FOLLOWUP_STATES = {"open", "waiting", "done", "cancelled"}


def pagination(q):
    offset, limit = q.get("offset", 0), q.get("limit", 20)
    require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 100,
            "INVALID_INPUT", "offset 必须非负，limit 须为 1—100。")
    return offset, limit


def workflow_warnings(facts):
    final_knowledge = facts.get("knowledge", {}).get("status") in {
        "final_local", "pending_confirmation", "submitted_unverified", "synced"}
    stable = (facts.get("release", {}).get("status") == "released"
              and facts.get("stability", {}).get("status") == "confirmed")
    return ([{"code": "KNOWLEDGE_BEFORE_STABILITY", "note": "知识记录与上线／稳定状态不一致；核对事实和用户特定指令，不据此触发写入。"}]
            if final_knowledge and not stable else [])


class WorkflowRecords:
    def scoped_write(self, q):
        self.store.require_v2()
        prefix, _, req = self.req(q)
        self.coordinator(q, req)
        require(not req["data"]["archived"], "ARCHIVED", "先明确重新开启需求。")
        return prefix

    def pin_artifacts(self, prefix, identifiers):
        require(isinstance(identifiers, list) and len(identifiers) <= 200
                and all(isinstance(x, str) for x in identifiers) and len(set(identifiers)) == len(identifiers),
                "INVALID_INPUT", "evidence 须为不重复的快照标识列表，最多 200 项。")
        pins = []
        for identifier in identifiers:
            record = self.artifact(prefix, identifier)
            pins.append({"artifact": identifier, "record_revision": record["revision"],
                         "sha256": record["data"]["sha256"]})
        return pins

    def do_workflow_record(self, q):
        prefix = self.scoped_write(q)
        ref = prefix + "/workflow.json"
        current = self.store.read(ref, missing=True)
        data = current["data"] if current else {"kind": "workflow", "project": q["project"],
                                                "requirement": q["requirement"], "facts": {}}
        facts = q.get("facts")
        require(isinstance(facts, dict) and facts and set(facts).issubset(FACT_STATES),
                "INVALID_INPUT", "facts 须包含支持的业务准备、页面、执行、评审、上线、稳定、知识或恢复事实。")
        for name, value in facts.items():
            require(isinstance(value, dict) and set(value).issubset({"status", "basis", "evidence"})
                    and value.get("status") in FACT_STATES[name], "INVALID_STATE", "事实状态不支持。", fact=name)
            basis = text(value.get("basis"), "basis")
            pins = self.pin_artifacts(prefix, value.get("evidence", []))
            require((name, value["status"]) not in PROVEN_FACTS or pins,
                    "EVIDENCE_REQUIRED", "该事实须关联已保存的依据；不凭一句状态认定完成。", fact=name)
            data["facts"][name] = {"status": value["status"], "basis": basis, "evidence": pins, "recorded_at": now()}
        return receipt(ref, self.store.write(ref, data, q["expected_revision"], schema=2),
                       warnings=workflow_warnings(data["facts"]), external_action_executed=False)

    def do_workflow_read(self, q):
        prefix, _, _ = self.req(q)
        ref = prefix + "/workflow.json"
        record = self.store.read(ref, missing=True)
        facts = record["data"]["facts"] if record else {}
        require(isinstance(q.get("include_details", False), bool), "INVALID_INPUT", "include_details 须为布尔值。")
        visible = facts if q.get("include_details") else {
            name: {"status": value["status"], "basis": value["basis"][:240],
                   "basis_truncated": len(value["basis"]) > 240, "evidence_count": len(value["evidence"]),
                   "recorded_at": value["recorded_at"]} for name, value in facts.items()}
        return {"path": ref, "revision": record["revision"] if record else 0, "exists": bool(record),
                "facts": visible, "warnings": workflow_warnings(facts), "details_included": q.get("include_details", False),
                "scope": "已登记事实，不自动推断阶段完成或远端状态；完整依据可用 record.read 或 include_details"}

    def do_deliverable_set(self, q):
        prefix = self.scoped_write(q)
        ref = prefix + f"/deliverables/{slug(q['deliverable'])}.json"
        role = q.get("role")
        require(role in DELIVERABLE_ROLES, "INVALID_INPUT", "交付物角色不支持。")
        status = q.get("status", "draft")
        require(status in {"draft", "ready", "superseded"}, "INVALID_STATE", "交付物状态不支持。")
        pin = self.pin_artifacts(prefix, [q["artifact"]])[0]
        data = {"kind": "deliverable", "project": q["project"], "requirement": q["requirement"],
                "deliverable": q["deliverable"], "role": role, "status": status,
                "title": text(q.get("title"), "title", 300), "basis": text(q.get("basis"), "basis"),
                "artifact": pin, "external_ref": text(q["external_ref"], "external_ref", 2048) if q.get("external_ref") else None}
        return receipt(ref, self.store.write(ref, data, q["expected_revision"], schema=2),
                       remote_verified=False, external_action_executed=False)

    def do_deliverable_list(self, q):
        prefix, _, _ = self.req(q)
        offset, limit = pagination(q)
        items = []
        for ref in self.store.refs(prefix + "/deliverables/*.json"):
            r = self.store.read(ref)
            if q.get("role") and r["data"]["role"] != q["role"]:
                continue
            items.append({"path": ref, "revision": r["revision"],
                          **{k: v for k, v in r["data"].items() if k != "basis"}})
        return {"total": len(items), "items": items[offset:offset + limit],
                "next_offset": offset + limit if offset + limit < len(items) else None}

    def do_followup_record(self, q):
        prefix = self.scoped_write(q)
        ref = prefix + f"/followups/{slug(q['followup'])}.json"
        status = q.get("status")
        require(status in FOLLOWUP_STATES, "INVALID_STATE", "遗留事项状态不支持。")
        pins = self.pin_artifacts(prefix, q.get("evidence", []))
        require(status not in {"done", "cancelled"} or pins, "EVIDENCE_REQUIRED", "结束事项需保留完成或取消依据。")
        next_step = text(q.get("next"), "next") if status in {"open", "waiting"} else q.get("next", "")
        require(isinstance(next_step, str) and len(next_step) <= 4000, "INVALID_INPUT", "next 须为文本。")
        data = {"kind": "followup", "project": q["project"], "requirement": q["requirement"],
                "followup": q["followup"], "title": text(q.get("title"), "title", 300), "status": status,
                "basis": text(q.get("basis"), "basis"), "next": next_step, "evidence": pins,
                "owner_ref": text(q["owner_ref"], "owner_ref", 120) if q.get("owner_ref") else None}
        return receipt(ref, self.store.write(ref, data, q["expected_revision"], schema=2),
                       external_action_executed=False)

    def do_followup_list(self, q):
        prefix, _, _ = self.req(q)
        offset, limit = pagination(q)
        require(isinstance(q.get("include_completed", False), bool), "INVALID_INPUT", "include_completed 须为布尔值。")
        counts = dict.fromkeys(sorted(FOLLOWUP_STATES), 0)
        items = []
        for ref in self.store.refs(prefix + "/followups/*.json"):
            r = self.store.read(ref)
            counts[r["data"]["status"]] += 1
            if q.get("include_completed", False) or r["data"]["status"] in {"open", "waiting"}:
                data = r["data"]
                items.append({"path": ref, "revision": r["revision"],
                              **{k: v for k, v in data.items() if k not in {"basis", "evidence", "next"}},
                              "next": data["next"][:240], "next_truncated": len(data["next"]) > 240,
                              "evidence_count": len(data["evidence"])})
        return {"total": len(items), "counts": counts, "items": items[offset:offset + limit],
                "next_offset": offset + limit if offset + limit < len(items) else None}
