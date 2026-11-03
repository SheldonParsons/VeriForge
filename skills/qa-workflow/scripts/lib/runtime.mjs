import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  Store,
  Fault,
  need,
  text,
  slug,
  object,
  sha,
  encoded,
  receipt,
  atomicBytes,
  now,
  canonical,
  inside,
} from "./store.mjs";

export const base = (q) =>
  `projects/${slug(q.project)}/requirements/${slug(q.requirement)}`;
const projectRef = (q) => `projects/${slug(q.project)}/project.json`;
export const CASE_STATES = [
  "passed",
  "failed",
  "blocked",
  "not_run",
  "running",
  "needs_verification",
  "skipped",
  "not_applicable",
];
const FACTS = {
  business: ["pending", "ready", "blocked"],
  page_steps: ["pending", "partial", "verified", "blocked", "not_applicable"],
  execution: ["pending", "ready", "blocked", "not_applicable"],
  review: ["not_requested", "pending", "completed", "not_applicable"],
  release: ["unknown", "not_released", "released", "rolled_back"],
  stability: ["unknown", "confirmed", "changing"],
  knowledge: [
    "not_requested",
    "draft",
    "final_local",
    "pending_confirmation",
    "submitted_unverified",
    "synced",
    "cancelled",
  ],
  restoration: ["not_required", "pending", "completed", "blocked"],
};
const PROVEN = new Set([
  "business:ready",
  "page_steps:verified",
  "execution:ready",
  "review:completed",
  "release:released",
  "stability:confirmed",
  "knowledge:synced",
  "restoration:completed",
]);
const READS = new Set([
  "list",
  "record.read",
  "record.history",
  "resume",
  "shared.resolve",
  "run.summary",
  "lock.inspect",
  "workflow.read",
  "deliverable.list",
  "followup.list",
  "context.read",
  "context.plan",
  "binding.list",
  "action.read",
]);
const EXECUTION = new Set([
  "resource.acquire",
  "operation.prepare",
  "operation.dispatch",
  "case.record",
  "task.resume",
  "task.transfer",
  "action.prepare",
  "action.dispatch",
]);
export function page(items, q = {}) {
  const offset = q.offset ?? 0,
    limit = q.limit ?? 20;
  need(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 100,
    "INVALID_INPUT",
    "Invalid pagination.",
  );
  return {
    total: items.length,
    items: items.slice(offset, offset + limit),
    next_offset: offset + limit < items.length ? offset + limit : null,
  };
}
export const workflowWarnings = (f) =>
  [
    "final_local",
    "pending_confirmation",
    "submitted_unverified",
    "synced",
  ].includes(f.knowledge?.status) &&
  !(f.release?.status === "released" && f.stability?.status === "confirmed")
    ? [
        {
          code: "KNOWLEDGE_BEFORE_STABILITY",
          note: "Check release, stability and the specific user instruction; no external write was performed.",
        },
      ]
    : [];
export class Runtime {
  constructor(root) {
    this.store = new Store(root);
  }
  async dispatch(request) {
    need(object(request), "INVALID_INPUT", "A JSON object is required.");
    const q = structuredClone(request),
      action = text(q.action, "action", 80),
      name = action.replaceAll(".", "_");
    need(
      new Set([
        "workspace.init",
        "workspace.upgrade",
        "project.create",
        "requirement.create",
        "state.update",
        "requirement.archive",
        "shared.publish",
        "shared.attach",
        "shared.resolve",
        "task.create",
        "task.pause",
        "task.resume",
        "task.finish",
        "task.transfer",
        "resource.acquire",
        "resource.release",
        "artifact.import",
        "operation.prepare",
        "operation.dispatch",
        "operation.resolve",
        "case.record",
        "case.sync",
        "run.summary",
        "workflow.record",
        "workflow.read",
        "deliverable.set",
        "deliverable.list",
        "followup.record",
        "followup.list",
        "resume",
        "list",
        "index.rebuild",
        "summary.write",
        "record.read",
        "record.history",
        "lock.inspect",
        "restore.activate",
      ]).has(action),
      "UNKNOWN_ACTION",
      "Unknown local action.",
    );
    if (READS.has(action)) {
      if (action !== "lock.inspect") this.store.ready();
      return this[name](q);
    }
    return this.store.locked(() => {
      if (action !== "workspace.init") this.store.ready(EXECUTION.has(action));
      return this[name](q);
    });
  }
  req(q) {
    const prefix = base(q),
      ref = `${prefix}/state.json`;
    return { prefix, ref, r: this.store.read(ref) };
  }
  key(q) {
    return { project: q.project, requirement: q.requirement, task: q.task };
  }
  coordinator(q, r) {
    need(
      q.actor === r.data.coordinator,
      "NOT_COORDINATOR",
      "The requirement coordinator must maintain this record.",
    );
  }
  maintainer(q) {
    need(
      q.actor === this.store.read("workspace.json").data.maintainer,
      "NOT_MAINTAINER",
      "Workspace maintainer required.",
    );
  }
  task(q, active = true) {
    const req = this.req(q),
      ref = `${req.prefix}/tasks/${slug(q.task)}.json`,
      r = this.store.read(ref);
    need(
      r.data.owner === q.actor,
      "NOT_OWNER",
      "Task belongs to another actor.",
    );
    if (active)
      need(
        r.data.status === "active" && !req.r.data.archived,
        "INACTIVE_TASK",
        "Task is inactive.",
      );
    return { ...req, ref, r };
  }
  managedTask(q) {
    const req = this.req(q),
      ref = `${req.prefix}/tasks/${slug(q.task)}.json`,
      r = this.store.read(ref);
    need(
      [req.r.data.coordinator, r.data.owner].includes(q.actor),
      "NOT_OWNER",
      "Task owner or coordinator required.",
    );
    need(
      !req.r.data.archived,
      "ARCHIVED",
      "Reopen the requirement explicitly.",
    );
    return { ...req, ref, r };
  }
  scoped(q) {
    this.store.requireV3();
    const v = this.req(q);
    this.coordinator(q, v.r);
    need(!v.r.data.archived, "ARCHIVED", "Reopen the requirement first.");
    return v;
  }
  blockers(q, resource) {
    const prefix = base(q),
      operations = this.store
        .refs(`${prefix}/operations/*.json`)
        .filter((ref) => {
          const d = this.store.read(ref).data;
          return (
            d.status === "dispatched" &&
            (!q.task || d.task === q.task) &&
            (!resource || d.resource === resource)
          );
        });
    const actions = this.store
      .refs(`${prefix}/actions/*.json`)
      .filter((ref) => {
        const d = this.store.read(ref).data;
        return (
          ["dispatched", "unknown", "waiting_user"].includes(d.status) &&
          (!q.task || d.task === q.task) &&
          (!resource || d.resource === resource)
        );
      });
    const resources = this.store.refs(".qa/resources/*.json").filter((ref) => {
      const h = this.store.read(ref).data.holder;
      return (
        h &&
        h.project === q.project &&
        h.requirement === q.requirement &&
        (!q.task || h.task === q.task)
      );
    });
    return { operations: [...operations, ...actions], resources };
  }
  systems(items) {
    need(Array.isArray(items), "INVALID_INPUT", "systems must be an array.");
    for (const item of items) {
      const p = this.store.read(projectRef(item));
      need(
        Object.hasOwn(p.data.systems, item.system),
        "UNKNOWN_SYSTEM",
        "System not in project.",
      );
    }
    return items;
  }
  artifact(prefix, id) {
    const ref = `${prefix}/artifacts/${slug(id)}.json`,
      r = this.store.read(ref),
      p = this.store.path(r.data.path);
    need(fs.existsSync(p), "MISSING_ARTIFACT", "Snapshot is missing.", {
      artifact: ref,
    });
    need(
      sha(fs.readFileSync(p)) === r.data.sha256,
      "ARTIFACT_DRIFT",
      "Snapshot changed.",
      { artifact: ref },
    );
    return r;
  }
  pins(prefix, ids = []) {
    need(
      Array.isArray(ids) &&
        ids.length <= 200 &&
        ids.every((x) => typeof x === "string") &&
        new Set(ids).size === ids.length,
      "INVALID_INPUT",
      "Use unique artifact identifiers.",
    );
    return ids.map((id) => {
      const r = this.artifact(prefix, id);
      return {
        artifact: id,
        record_revision: r.revision,
        sha256: r.data.sha256,
      };
    });
  }
  resourceRef(value) {
    return `.qa/resources/${sha(text(value, "resource", 500))}.json`;
  }
  overlap(prefix, id, run, cases) {
    for (const ref of this.store.refs(`${prefix}/tasks/*.json`)) {
      const d = this.store.read(ref).data;
      if (
        d.task === id ||
        d.run !== run ||
        !d.cases.some((c) => cases.includes(c))
      )
        continue;
      const b = this.blockers(this.key(d));
      need(
        d.status !== "active" && !b.operations.length && !b.resources.length,
        "TASK_OVERLAP",
        "An overlapping task is active or unresolved.",
      );
    }
  }
  workspace_init(q) {
    const data = {
      kind: "workspace",
      id: crypto.randomUUID().replaceAll("-", ""),
      title: text(q.title, "title"),
      maintainer: text(q.actor, "actor", 120),
      runtime_schema: 3,
    };
    return receipt(
      "workspace.json",
      this.store.write("workspace.json", data, 0, 3),
    );
  }
  workspace_upgrade(q) {
    this.maintainer(q);
    const r = this.store.read("workspace.json");
    need(
      q.expected_revision === r.revision &&
        Number.isSafeInteger(q.expected_revision),
      "REVISION_CONFLICT",
      "Workspace changed.",
    );
    if (r.schema === 3 && r.data.runtime_schema === 3)
      return receipt("workspace.json", r, {
        already_current: true,
        external_action_executed: false,
      });
    need(
      q.source_execution_stopped === true,
      "HANDOFF_REQUIRED",
      "Confirm the previous executor has stopped.",
    );
    const active = this.store
        .refs("projects/*/requirements/*/tasks/*.json")
        .filter((p) => this.store.read(p).data.status === "active"),
      unknown = this.store
        .records()
        .filter(
          (p) =>
            /\/(operations|actions)\//.test(p) &&
            ["dispatched", "unknown", "waiting_user"].includes(
              this.store.read(p).data.status,
            ),
        ),
      held = this.store
        .refs(".qa/resources/*.json")
        .filter((p) => this.store.read(p).data.holder);
    need(
      !active.length && !unknown.length && !held.length,
      "UPGRADE_BUSY",
      "Reconcile tasks, operations and resources before upgrade.",
      {
        active_tasks: active,
        unconfirmed_operations: unknown,
        held_resources: held,
      },
    );
    r.data = {
      ...r.data,
      runtime_schema: 3,
      upgrade_basis: text(q.note, "note"),
      upgraded_at: now(),
    };
    return receipt(
      "workspace.json",
      this.store.write("workspace.json", r.data, r.revision, 3),
      {
        external_action_executed: false,
        legacy_runtime_write_supported: false,
      },
    );
  }
  project_create(q) {
    this.maintainer(q);
    const systems = q.systems ?? {};
    need(object(systems), "INVALID_INPUT", "systems must be an object.");
    for (const [k, v] of Object.entries(systems)) {
      slug(k);
      text(v, "system", 200);
    }
    const ref = projectRef(q),
      data = {
        kind: "project",
        project: q.project,
        title: text(q.title, "title"),
        systems,
        coordinator: text(q.coordinator ?? q.actor, "coordinator", 120),
        shared: {},
      };
    return receipt(ref, this.store.write(ref, data, 0));
  }
  requirement_create(q) {
    const p = this.store.read(projectRef(q));
    this.coordinator(q, p);
    const ref = `${base(q)}/state.json`,
      data = {
        kind: "requirement",
        project: q.project,
        requirement: q.requirement,
        title: text(q.title, "title"),
        systems: this.systems(q.systems ?? []),
        coordinator: text(q.coordinator ?? q.actor, "coordinator", 120),
        stages: {},
        next: q.next ?? "",
        archived: false,
      };
    return receipt(ref, this.store.write(ref, data, 0));
  }
  state_update(q) {
    const { ref, r } = this.req(q);
    this.coordinator(q, r);
    need(!r.data.archived, "ARCHIVED", "Reopen first.");
    need(object(q.stages ?? {}), "INVALID_INPUT", "Invalid stages.");
    for (const [k, v] of Object.entries(q.stages ?? {})) {
      need(
        [
          "analysis",
          "page_evidence",
          "cases",
          "review",
          "execution",
          "defects",
          "retest",
          "knowledge",
          "closeout",
        ].includes(k) &&
          object(v) &&
          [
            "not_started",
            "in_progress",
            "ready_for_review",
            "completed",
            "blocked",
            "skipped",
          ].includes(v.status),
        "INVALID_STATE",
        "Invalid stage state.",
      );
      if (["completed", "blocked", "skipped"].includes(v.status))
        text(v.basis, "basis");
      r.data.stages[k] = v;
    }
    if (q.next !== undefined) {
      need(typeof q.next === "string", "INVALID_INPUT", "next must be text.");
      r.data.next = q.next;
    }
    if (q.systems) r.data.systems = this.systems(q.systems);
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  requirement_archive(q) {
    const { prefix, ref, r } = this.req(q);
    this.coordinator(q, r);
    need(
      typeof q.archived === "boolean",
      "INVALID_INPUT",
      "archived must be boolean.",
    );
    if (q.archived) {
      const b = this.blockers(q),
        active = this.store
          .refs(`${prefix}/tasks/*.json`)
          .filter((p) => this.store.read(p).data.status === "active");
      need(
        !active.length && !b.operations.length && !b.resources.length,
        "TASKS_ACTIVE",
        "Reconcile active work before archiving.",
      );
    }
    r.data = {
      ...r.data,
      archived: q.archived,
      archive_reason: text(q.reason, "reason"),
    };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  shared_publish(q) {
    this.maintainer(q);
    need(
      ["guidance", "template", "rule", "capability", "config"].includes(q.kind),
      "INVALID_INPUT",
      "Invalid shared kind.",
    );
    need(
      Array.isArray(q.projects) && q.projects.length,
      "INVALID_INPUT",
      "Explicit project scope required.",
    );
    q.projects.forEach((p) => this.store.read(projectRef({ project: p })));
    const keys = q.overridable_keys ?? [];
    need(
      Array.isArray(keys) &&
        keys.every((k) => typeof k === "string") &&
        (!keys.length || q.kind === "config"),
      "RULE_OVERRIDE",
      "Only configuration defaults can declare overrides.",
    );
    need(
      !keys.length ||
        (object(q.content) && keys.every((k) => Object.hasOwn(q.content, k))),
      "INVALID_INPUT",
      "Missing configurable default.",
    );
    const ref = `shared/${slug(q.shared)}.json`;
    return receipt(
      ref,
      this.store.write(
        ref,
        {
          kind: q.kind,
          title: text(q.title, "title"),
          projects: [...new Set(q.projects)].sort(),
          source: text(q.source, "source"),
          content: q.content,
          overridable_keys: keys,
        },
        q.expected_revision ?? 0,
      ),
    );
  }
  shared_attach(q) {
    const ref = projectRef(q),
      p = this.store.read(ref);
    this.coordinator(q, p);
    const s = this.store.version(`shared/${slug(q.shared)}.json`, q.revision),
      overrides = q.overrides ?? {};
    need(
      s.data.projects.includes(q.project),
      "SHARED_SCOPE",
      "Shared revision does not cover this project.",
    );
    need(
      object(overrides) &&
        Object.keys(overrides).every((k) =>
          s.data.overridable_keys.includes(k),
        ),
      "RULE_OVERRIDE",
      "Unsupported override.",
    );
    p.data.shared[q.shared] = {
      revision: s.revision,
      sha256: s.sha256,
      overrides,
    };
    return receipt(ref, this.store.write(ref, p.data, q.expected_revision));
  }
  shared_resolve(q) {
    const p = this.store.read(projectRef(q)).data;
    need(
      !q.include_content || q.shared,
      "INVALID_INPUT",
      "Select one shared entry to expand.",
    );
    if (q.shared)
      need(
        Object.hasOwn(p.shared, q.shared),
        "NOT_FOUND",
        "Shared reference missing.",
      );
    return {
      project: q.project,
      items: Object.entries(p.shared)
        .filter(([id]) => !q.shared || id === q.shared)
        .map(([id, pin]) => {
          const ref = `shared/${id}.json`,
            s = this.store.version(ref, pin.revision);
          need(
            s.sha256 === pin.sha256 && s.data.projects.includes(q.project),
            "SHARED_SCOPE",
            "Shared reference changed.",
          );
          return {
            shared: id,
            revision: pin.revision,
            latest_revision: this.store.read(ref).revision,
            source: s.data.source,
            overrides: pin.overrides,
            ...(q.include_content
              ? {
                  content: Object.keys(pin.overrides).length
                    ? { ...s.data.content, ...pin.overrides }
                    : s.data.content,
                }
              : {}),
          };
        }),
    };
  }
  task_create(q) {
    const { prefix, r } = this.req(q);
    this.coordinator(q, r);
    need(!r.data.archived, "ARCHIVED", "Reopen first.");
    const cases = q.cases ?? [];
    need(
      Array.isArray(cases) && new Set(cases).size === cases.length,
      "INVALID_INPUT",
      "Cases must be unique.",
    );
    cases.forEach(slug);
    const run = q.run ? slug(q.run) : null;
    need(!cases.length || run, "INVALID_INPUT", "Run required.");
    const context = q.context ?? {};
    need(
      object(context) &&
        Object.keys(context).every((k) =>
          ["environment", "build", "roles", "data_refs", "systems"].includes(k),
        ),
      "INVALID_INPUT",
      "Context contains unsupported fields.",
    );
    if (context.systems) this.systems(context.systems);
    this.overlap(prefix, slug(q.task), run, cases);
    const ref = `${prefix}/tasks/${q.task}.json`,
      data = {
        kind: "task",
        ...this.key(q),
        owner: text(q.owner, "owner", 120),
        scope: text(q.scope, "scope"),
        run,
        cases,
        status: "active",
        inputs: this.pins(prefix, q.inputs ?? []),
        context,
        session_ref: q.session_ref ?? null,
        shared: this.store.read(projectRef(q)).data.shared,
      };
    return receipt(ref, this.store.write(ref, data, 0));
  }
  task_pause(q) {
    const { ref, r } = this.managedTask(q);
    need(r.data.status !== "closed", "INACTIVE_TASK", "Task is closed.");
    const b = this.blockers(q);
    r.data = {
      ...r.data,
      status: "paused",
      note: text(q.note, "note"),
      paused_at: now(),
    };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision), {
      external_stop_verified: false,
      unconfirmed_operation_count: b.operations.length,
      held_resource_count: b.resources.length,
    });
  }
  task_resume(q) {
    const { prefix, ref, r } = this.managedTask(q);
    need(
      ["paused", "blocked"].includes(r.data.status),
      "INACTIVE_TASK",
      "Only paused/blocked tasks can resume.",
    );
    need(
      !this.blockers(q).operations.some(
        (p) => this.store.read(p).data.status !== "waiting_user",
      ),
      "PENDING_WORK",
      "Reconcile unknown actions first.",
    );
    this.overlap(prefix, q.task, r.data.run, r.data.cases);
    r.data = {
      ...r.data,
      status: "active",
      note: text(q.note, "note"),
      resumed_at: now(),
    };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision), {
      external_action_executed: false,
    });
  }
  task_finish(q) {
    if (q.status === "paused") return this.task_pause(q);
    const { ref, r } = this.task(q, false);
    need(!this.req(q).r.data.archived, "ARCHIVED", "Reopen first.");
    const b = this.blockers(q);
    need(
      !b.operations.length && !b.resources.length,
      "PENDING_WORK",
      "Reconcile operations and release resources.",
    );
    need(
      ["closed", "blocked"].includes(q.status),
      "INVALID_STATE",
      "Invalid task terminal state.",
    );
    r.data = { ...r.data, status: q.status, note: text(q.note, "note") };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  task_transfer(q) {
    const req = this.req(q);
    this.coordinator(q, req.r);
    need(!req.r.data.archived, "ARCHIVED", "Reopen first.");
    const ref = `${req.prefix}/tasks/${slug(q.task)}.json`,
      r = this.store.read(ref),
      b = this.blockers(q);
    need(
      q.previous_owner_stopped === true,
      "HANDOFF_REQUIRED",
      "Verify the old executor stopped.",
    );
    need(
      !b.operations.length && !b.resources.length,
      "PENDING_WORK",
      "Unresolved work remains.",
    );
    this.overlap(req.prefix, q.task, r.data.run, r.data.cases);
    r.data = {
      ...r.data,
      owner: text(q.new_owner, "new_owner", 120),
      status: "active",
      handoff_note: text(q.note, "note"),
      session_ref: q.session_ref ?? null,
    };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  resource_acquire(q) {
    this.task(q);
    const ref = this.resourceRef(q.resource),
      old = this.store.read(ref, true),
      holder = { ...this.key(q), owner: q.actor };
    if (old?.data.holder) {
      need(
        JSON.stringify(old.data.holder) === JSON.stringify(holder) ||
          encoded(old.data.holder).equals(encoded(holder)),
        "RESOURCE_BUSY",
        "Resource belongs to another task.",
      );
      return receipt(ref, old, { already_held: true });
    }
    return receipt(
      ref,
      this.store.write(
        ref,
        { kind: "resource", resource: q.resource, holder },
        old?.revision ?? 0,
      ),
    );
  }
  resource_release(q) {
    this.task(q, false);
    const ref = this.resourceRef(q.resource),
      r = this.store.read(ref);
    need(
      encoded(r.data.holder).equals(
        encoded({ ...this.key(q), owner: q.actor }),
      ),
      "NOT_OWNER",
      "Resource is not owned by task.",
    );
    need(
      !this.blockers(q, q.resource).operations.length,
      "PENDING_WORK",
      "Resource has unknown actions.",
    );
    r.data.holder = null;
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  artifact_import(q) {
    const req = this.req(q);
    if (q.task) this.task(q, false);
    else this.coordinator(q, req.r);
    const ref = `${req.prefix}/artifacts/${slug(q.artifact)}.json`;
    need(
      !fs.existsSync(this.store.path(ref)),
      "ALREADY_EXISTS",
      "Use a new snapshot identifier.",
    );
    const source = canonical(text(q.source_path, "source_path", 4096));
    const priv = canonical(
      process.env.VERIFORGE_PRIVATE_DIR ||
        path.join(os.homedir(), ".veriforge", "private"),
    );
    need(
      !inside(priv, source),
      "PRIVATE_SOURCE",
      "Credential storage is not a workspace artifact.",
    );
    need(
      typeof (q.sensitive ?? false) === "boolean",
      "INVALID_INPUT",
      "sensitive must be boolean.",
    );
    const before = fs.statSync(source);
    need(
      before.isFile() && before.size <= 256 * 1024 * 1024,
      "INVALID_INPUT",
      "Artifact must be a regular file within the 256 MiB limit.",
    );
    const bytes = fs.readFileSync(source),
      after = fs.statSync(source);
    need(
      before.ino === after.ino &&
        before.mtimeMs === after.mtimeMs &&
        before.size === after.size,
      "SOURCE_CHANGED",
      "Source changed while reading.",
    );
    const digest = sha(bytes),
      asset = `artifacts/${digest}/${path.basename(source)}`,
      target = this.store.path(asset);
    if (fs.existsSync(target))
      need(
        sha(fs.readFileSync(target)) === digest,
        "ARTIFACT_DRIFT",
        "Existing snapshot differs.",
      );
    else atomicBytes(target, bytes, false);
    const data = {
      kind: "artifact",
      artifact: q.artifact,
      path: asset,
      sha256: digest,
      bytes: bytes.length,
      source,
      captured_at: now(),
      purpose: text(q.purpose, "purpose"),
      sensitive: q.sensitive ?? false,
    };
    return receipt(ref, this.store.write(ref, data, 0), { snapshot: asset });
  }
  operation_prepare(q) {
    this.task(q);
    need(
      !this.blockers(q, q.resource).operations.length,
      "PENDING_WORK",
      "Reconcile the previous operation.",
    );
    const resource = this.store.read(this.resourceRef(q.resource));
    need(
      encoded(resource.data.holder).equals(
        encoded({ ...this.key(q), owner: q.actor }),
      ),
      "NOT_OWNER",
      "Acquire the resource first.",
    );
    need(
      resource.revision === q.resource_revision,
      "REVISION_CONFLICT",
      "Resource changed.",
    );
    const ref = `${base(q)}/operations/${slug(q.operation)}.json`,
      data = {
        kind: "operation",
        ...this.key(q),
        operation: q.operation,
        status: "prepared",
        resource: q.resource,
        resource_revision: q.resource_revision,
        intent: text(q.intent, "intent"),
        correlation: text(q.correlation, "correlation"),
        target: text(q.target, "target"),
      };
    return receipt(ref, this.store.write(ref, data, 0), {
      external_action_executed: false,
    });
  }
  operation_dispatch(q) {
    this.task(q);
    const ref = `${base(q)}/operations/${slug(q.operation)}.json`,
      r = this.store.read(ref),
      resource = this.store.read(this.resourceRef(r.data.resource));
    need(
      r.data.task === q.task && r.data.status === "prepared",
      "OPERATION_STATE",
      "Do not replay this operation.",
    );
    need(
      !this.blockers(q, r.data.resource).operations.length,
      "PENDING_WORK",
      "Unknown operation remains.",
    );
    need(
      resource.revision === r.data.resource_revision &&
        encoded(resource.data.holder).equals(
          encoded({ ...this.key(q), owner: q.actor }),
        ),
      "RESOURCE_CHANGED",
      "Resource ownership changed.",
    );
    r.data = { ...r.data, status: "dispatched", dispatched_at: now() };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision), {
      external_action_executed: false,
    });
  }
  operation_resolve(q) {
    this.task(q, false);
    const ref = `${base(q)}/operations/${slug(q.operation)}.json`,
      r = this.store.read(ref);
    need(
      r.data.task === q.task &&
        ["prepared", "dispatched"].includes(r.data.status),
      "OPERATION_STATE",
      "Wrong or resolved operation.",
    );
    need(
      ["confirmed", "not_applied"].includes(q.result),
      "INVALID_STATE",
      "Invalid reconciliation result.",
    );
    need(
      q.evidence?.length,
      "EVIDENCE_REQUIRED",
      "Readback evidence required.",
    );
    this.pins(base(q), q.evidence);
    r.data = {
      ...r.data,
      status: q.result,
      evidence: q.evidence,
      result_note: text(q.note, "note"),
    };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  case_record(q) {
    const { prefix, r } = this.task(q),
      d = r.data;
    need(
      d.run && d.cases.includes(q.case),
      "CASE_SCOPE",
      "Scenario is outside task scope.",
    );
    need(CASE_STATES.includes(q.status), "INVALID_STATE", "Invalid result.");
    if (!CASE_STATES.slice(0, 4).includes(q.status))
      need(
        this.store.ready().data.runtime_schema >= 2,
        "UPGRADE_REQUIRED",
        "Upgrade before using extended states.",
      );
    if (["passed", "failed", "skipped", "not_applicable"].includes(q.status))
      need(
        q.evidence?.length,
        "EVIDENCE_REQUIRED",
        "Result or scope evidence required.",
      );
    this.pins(prefix, q.evidence ?? []);
    for (const pin of d.inputs ?? [])
      need(
        this.artifact(prefix, pin.artifact).data.sha256 === pin.sha256,
        "ARTIFACT_DRIFT",
        "Pinned input changed.",
      );
    need(
      Array.isArray(q.bugs ?? []) &&
        (q.bugs ?? []).every((x) => typeof x === "string" && x),
      "INVALID_INPUT",
      "Invalid issue references.",
    );
    const ref = `${prefix}/runs/${d.run}/${slug(q.case)}.json`,
      data = {
        kind: "case_result",
        ...this.key(q),
        run: d.run,
        case: q.case,
        status: q.status,
        evidence: q.evidence ?? [],
        bugs: [...new Set(q.bugs ?? [])].sort(),
        sync: "pending",
        inputs: d.inputs ?? [],
        context: d.context ?? {},
        basis: text(q.basis, "basis"),
        recorded_at: now(),
      };
    return receipt(ref, this.store.write(ref, data, q.expected_revision));
  }
  case_sync(q) {
    const req = this.req(q),
      task = this.store.read(`${req.prefix}/tasks/${slug(q.task)}.json`).data;
    need(
      [req.r.data.coordinator, task.owner].includes(q.actor),
      "NOT_OWNER",
      "Coordinator or owner required.",
    );
    need(
      task.cases.includes(q.case) && task.run,
      "CASE_SCOPE",
      "Outside scope.",
    );
    const ref = `${req.prefix}/runs/${task.run}/${slug(q.case)}.json`,
      r = this.store.read(ref);
    need(
      r.data.task === q.task,
      "NOT_OWNER",
      "Result belongs to another task.",
    );
    this.artifact(req.prefix, q.receipt);
    r.data = { ...r.data, sync: "confirmed", sync_receipt: q.receipt };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
  run_summary(q) {
    const { prefix } = this.req(q),
      cases = new Set();
    slug(q.run);
    for (const ref of this.store.refs(`${prefix}/tasks/*.json`)) {
      const d = this.store.read(ref).data;
      if (d.run === q.run) d.cases.forEach((c) => cases.add(c));
    }
    const counts = { passed: 0, failed: 0, blocked: 0, not_run: 0 },
      bugs = new Set();
    let pending = 0;
    for (const c of [...cases].sort()) {
      const r = this.store.read(`${prefix}/runs/${q.run}/${c}.json`, true),
        status = r?.data.status ?? "not_run";
      need(
        CASE_STATES.includes(status),
        "INVALID_STATE",
        "Unknown stored result.",
      );
      counts[status] = (counts[status] ?? 0) + 1;
      if (r) {
        r.data.bugs.forEach((x) => bugs.add(x));
        if (r.data.sync !== "confirmed") pending++;
      }
    }
    return {
      run: q.run,
      total: cases.size,
      recorded_results: counts,
      distinct_bug_count: bugs.size,
      bugs: [...bugs].sort(),
      pending_sync: pending,
      scope: "Assigned scenarios in this run only.",
    };
  }
  workflow_record(q) {
    const { prefix } = this.scoped(q),
      ref = `${prefix}/workflow.json`,
      old = this.store.read(ref, true),
      d = old?.data ?? {
        kind: "workflow",
        project: q.project,
        requirement: q.requirement,
        facts: {},
      };
    need(
      object(q.facts) && Object.keys(q.facts).length,
      "INVALID_INPUT",
      "Facts required.",
    );
    for (const [k, v] of Object.entries(q.facts)) {
      need(
        Object.hasOwn(FACTS, k) &&
          object(v) &&
          Object.keys(v).every((x) =>
            ["status", "basis", "evidence"].includes(x),
          ) &&
          FACTS[k].includes(v.status),
        "INVALID_STATE",
        "Invalid fact.",
      );
      const pins = this.pins(prefix, v.evidence ?? []);
      need(
        !PROVEN.has(`${k}:${v.status}`) || pins.length,
        "EVIDENCE_REQUIRED",
        "Saved evidence required.",
      );
      d.facts[k] = {
        status: v.status,
        basis: text(v.basis, "basis"),
        evidence: pins,
        recorded_at: now(),
      };
    }
    return receipt(ref, this.store.write(ref, d, q.expected_revision), {
      warnings: workflowWarnings(d.facts),
      external_action_executed: false,
    });
  }
  workflow_read(q) {
    const { prefix } = this.req(q),
      ref = `${prefix}/workflow.json`,
      r = this.store.read(ref, true),
      facts = r?.data.facts ?? {};
    need(
      typeof (q.include_details ?? false) === "boolean",
      "INVALID_INPUT",
      "include_details must be boolean.",
    );
    return {
      path: ref,
      revision: r?.revision ?? 0,
      exists: !!r,
      facts: q.include_details
        ? facts
        : Object.fromEntries(
            Object.entries(facts).map(([k, v]) => [
              k,
              {
                status: v.status,
                basis: v.basis.slice(0, 240),
                basis_truncated: v.basis.length > 240,
                evidence_count: v.evidence.length,
                recorded_at: v.recorded_at,
              },
            ]),
          ),
      warnings: workflowWarnings(facts),
      details_included: q.include_details ?? false,
    };
  }
  deliverable_set(q) {
    const { prefix } = this.scoped(q),
      ref = `${prefix}/deliverables/${slug(q.deliverable)}.json`;
    need(
      [
        "requirement",
        "case_set",
        "page_evidence",
        "bug",
        "knowledge",
        "run_evidence",
        "handoff",
        "user_requested",
      ].includes(q.role),
      "INVALID_INPUT",
      "Invalid deliverable role.",
    );
    need(
      ["draft", "ready", "superseded"].includes(q.status ?? "draft"),
      "INVALID_STATE",
      "Invalid deliverable state.",
    );
    const d = {
      kind: "deliverable",
      project: q.project,
      requirement: q.requirement,
      deliverable: q.deliverable,
      role: q.role,
      status: q.status ?? "draft",
      title: text(q.title, "title", 300),
      basis: text(q.basis, "basis"),
      artifact: this.pins(prefix, [q.artifact])[0],
      external_ref: q.external_ref
        ? text(q.external_ref, "external_ref", 2048)
        : null,
    };
    return receipt(ref, this.store.write(ref, d, q.expected_revision), {
      remote_verified: false,
      external_action_executed: false,
    });
  }
  deliverable_list(q) {
    const { prefix } = this.req(q);
    return page(
      this.store
        .refs(`${prefix}/deliverables/*.json`)
        .map((ref) => {
          const r = this.store.read(ref),
            { basis, ...d } = r.data;
          return { path: ref, revision: r.revision, ...d };
        })
        .filter((d) => !q.role || q.role === d.role),
      q,
    );
  }
  followup_record(q) {
    const { prefix } = this.scoped(q),
      ref = `${prefix}/followups/${slug(q.followup)}.json`;
    need(
      ["open", "waiting", "done", "cancelled"].includes(q.status),
      "INVALID_STATE",
      "Invalid follow-up state.",
    );
    const evidence = this.pins(prefix, q.evidence ?? []);
    need(
      !["done", "cancelled"].includes(q.status) || evidence.length,
      "EVIDENCE_REQUIRED",
      "Evidence required to finish this follow-up.",
    );
    const next = ["open", "waiting"].includes(q.status)
      ? text(q.next, "next")
      : (q.next ?? "");
    need(
      typeof next === "string" && next.length <= 4000,
      "INVALID_INPUT",
      "Invalid next action.",
    );
    const d = {
      kind: "followup",
      project: q.project,
      requirement: q.requirement,
      followup: q.followup,
      title: text(q.title, "title", 300),
      status: q.status,
      basis: text(q.basis, "basis"),
      next,
      evidence,
      owner_ref: q.owner_ref ? text(q.owner_ref, "owner_ref", 120) : null,
    };
    return receipt(ref, this.store.write(ref, d, q.expected_revision), {
      external_action_executed: false,
    });
  }
  followup_list(q) {
    const { prefix } = this.req(q),
      counts = { open: 0, waiting: 0, done: 0, cancelled: 0 };
    need(
      typeof (q.include_completed ?? false) === "boolean",
      "INVALID_INPUT",
      "include_completed must be boolean.",
    );
    const all = this.store.refs(`${prefix}/followups/*.json`).map((ref) => {
      const r = this.store.read(ref);
      counts[r.data.status]++;
      const { basis, evidence, next, ...d } = r.data;
      return {
        path: ref,
        revision: r.revision,
        ...d,
        next: next.slice(0, 240),
        next_truncated: next.length > 240,
        evidence_count: evidence.length,
      };
    });
    return {
      ...page(
        all.filter(
          (d) => q.include_completed || ["open", "waiting"].includes(d.status),
        ),
        q,
      ),
      counts,
    };
  }
  resume(q) {
    const { prefix, ref, r } = this.req(q),
      b = this.blockers(q),
      warnings = [];
    const tasks = this.store
      .refs(`${prefix}/tasks/*.json`)
      .map((p) => this.store.read(p))
      .filter((t) => !q.task || t.data.task === q.task)
      .map((t) => {
        const d = t.data;
        if (d.cases.length && !d.inputs?.length)
          warnings.push({ code: "INPUT_VERSION_UNPINNED", task: d.task });
        const changes = [];
        for (const [id, pin] of Object.entries(d.shared)) {
          const shared = this.store.version(`shared/${id}.json`, pin.revision);
          need(
            shared.sha256 === pin.sha256,
            "INTEGRITY",
            "Shared pin changed.",
          );
          const latest = this.store.read(`shared/${id}.json`).revision;
          if (latest !== pin.revision)
            changes.push({ shared: id, used: pin.revision, latest });
        }
        return {
          task: d.task,
          owner: d.owner,
          status: d.status,
          scope: d.scope,
          revision: t.revision,
          run: d.run,
          shared_changes: changes,
          inputs: d.inputs ?? [],
          context: d.context ?? {},
          note: d.note ?? "",
        };
      });
    for (const p of this.store.refs(`${prefix}/artifacts/*.json`)) {
      try {
        this.artifact(prefix, path.posix.basename(p, ".json"));
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
        warnings.push({ code: e.code, artifact: p });
      }
    }
    const selected = page(tasks, q),
      limit = q.limit ?? 20,
      recovery = this.store.read(".qa/recovery.json", true);
    return {
      path: ref,
      revision: r.revision,
      requirement: r.data,
      tasks: selected.items,
      task_count: selected.total,
      next_task_offset: selected.next_offset,
      runs: [...new Set(selected.items.map((t) => t.run).filter(Boolean))]
        .sort()
        .map((run) => this.run_summary({ ...q, run })),
      unconfirmed_operations: b.operations.slice(0, limit),
      unconfirmed_operation_count: b.operations.length,
      held_resources: b.resources.slice(0, limit),
      held_resource_count: b.resources.length,
      warnings: warnings.slice(0, limit),
      warning_count: warnings.length,
      details_truncated:
        Math.max(b.operations.length, b.resources.length, warnings.length) >
        limit,
      restored_review_required: !!recovery && !recovery.data.reviewed,
      workspace_runtime_schema:
        this.store.read("workspace.json").data.runtime_schema ?? 1,
      workflow: this.workflow_read(q),
      deliverables: this.deliverable_list({
        ...q,
        offset: q.deliverable_offset ?? 0,
      }),
      followups: this.followup_list({ ...q, offset: q.followup_offset ?? 0 }),
      external_action_executed: false,
    };
  }
  list(q) {
    return page(
      this.store
        .catalog()
        .filter(
          (x) =>
            (!q.project || x.project === slug(q.project)) &&
            (!q.requirement || x.requirement === slug(q.requirement)) &&
            (q.include_archived || !x.archived) &&
            (!q.query ||
              `${x.title} ${x.requirement ?? ""}`
                .toLocaleLowerCase()
                .includes(String(q.query).toLocaleLowerCase())),
        ),
      q,
    );
  }
  index_rebuild() {
    return { items: this.store.catalog().length, source: "canonical records" };
  }
  summary_write(q) {
    const req = this.req(q);
    this.coordinator(q, req.r);
    const d = this.resume({ ...q, offset: 0, limit: 100 }),
      p = this.store.path(`${req.prefix}/README.md`),
      marker = "<!-- qa-workflow generated summary -->";
    need(
      !fs.existsSync(p) || fs.readFileSync(p, "utf8").startsWith(marker),
      "USER_FILE_EXISTS",
      "Existing user README is not overwritten.",
    );
    const lines = [
      marker,
      `# ${req.r.data.title}`,
      "",
      `Revision ${req.r.revision} · ${now()}`,
      "",
      "## Stages",
      ...Object.entries(req.r.data.stages).map(
        ([k, v]) => `- ${k}: ${v.status} — ${v.basis ?? ""}`,
      ),
      "",
      "## Runs",
      ...d.runs.map(
        (r) =>
          `- ${r.run}: ${JSON.stringify(r.recorded_results)}; distinct issues ${r.distinct_bug_count}; pending sync ${r.pending_sync}`,
      ),
      "",
      "## Independent facts",
      ...Object.entries(d.workflow.facts).map(
        ([k, v]) =>
          `- ${k}: ${v.status} — ${v.basis}${v.basis_truncated ? "… (expand workflow.read)" : ""}`,
      ),
      "",
      "## Deliverables",
      ...d.deliverables.items.map(
        (x) => `- ${x.title}: ${x.artifact.artifact} (${x.status})`,
      ),
      "",
      "## Follow-ups",
      ...d.followups.items.map(
        (x) =>
          `- ${x.title}: ${x.status}; ${x.next}${x.next_truncated ? "… (read full record)" : ""}`,
      ),
      "",
      `Listed tasks ${d.tasks.length}/${d.task_count}; deliverables ${d.deliverables.items.length}/${d.deliverables.total}; follow-ups ${d.followups.items.length}/${d.followups.total}.`,
      `Unknown actions: ${d.unconfirmed_operation_count}; held resources: ${d.held_resource_count}.`,
      `Next: ${req.r.data.next || "Not recorded"}`,
      "",
    ];
    atomicBytes(p, Buffer.from(lines.join("\n")));
    return {
      path: `${req.prefix}/README.md`,
      source_revision: req.r.revision,
      derived: true,
    };
  }
  record_read(q) {
    need(
      this.store.records().includes(q.path),
      "NOT_FOUND",
      "Only managed record types can be read.",
    );
    return q.revision !== undefined
      ? this.store.version(q.path, q.revision)
      : this.store.read(q.path);
  }
  record_history(q) {
    need(
      this.store.records().includes(q.path),
      "NOT_FOUND",
      "Record not registered.",
    );
    const h = this.store.read(q.path),
      limit = q.limit ?? 20;
    need(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_INPUT",
      "Invalid limit.",
    );
    const items = [];
    for (let n = h.revision; n > Math.max(0, h.revision - limit); n--) {
      const r = this.store.version(q.path, n);
      items.push({ revision: n, updated_at: r.updated_at, sha256: r.sha256 });
    }
    return {
      path: q.path,
      items,
      earlier_revisions: Math.max(0, h.revision - limit),
    };
  }
  lock_inspect() {
    const p = this.store.path(".qa/write.lock/owner.json");
    return {
      locked: fs.existsSync(path.dirname(p)),
      owner_file: fs.existsSync(p) ? p : null,
      automatic_unlock: false,
    };
  }
  restore_activate(q) {
    this.maintainer(q);
    const ref = ".qa/recovery.json",
      r = this.store.read(ref);
    need(
      q.source_execution_stopped === true,
      "HANDOFF_REQUIRED",
      "Reconcile source executor.",
    );
    const unknown = this.store
        .records()
        .filter(
          (p) =>
            /\/(operations|actions)\//.test(p) &&
            ["dispatched", "unknown", "waiting_user"].includes(
              this.store.read(p).data.status,
            ),
        ),
      held = this.store
        .refs(".qa/resources/*.json")
        .filter((p) => this.store.read(p).data.holder);
    need(
      !unknown.length && !held.length,
      "PENDING_WORK",
      "Restored actions or resources remain unresolved.",
    );
    r.data = { ...r.data, reviewed: true, note: text(q.note, "note") };
    return receipt(ref, this.store.write(ref, r.data, q.expected_revision));
  }
}
