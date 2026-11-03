import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, error } from "./helpers.mjs";
import {
  Store,
  checkedBytes,
  encoded,
  sha,
  relative,
} from "../skills/qa-workflow/scripts/lib/store.mjs";
import { execute } from "../skills/qa-workflow/scripts/qa.mjs";
import {
  unzipChecked,
  zipFiles,
} from "../skills/qa-workflow/scripts/lib/archive.mjs";

test("separate projects may share requirement ID without overwriting", async (t) => {
  const f = await fixture(t);
  await f.call({ action: "project.create", project: "other", title: "Other" });
  await f.call({
    action: "requirement.create",
    project: "other",
    title: "Other change",
  });
  assert.equal(
    (await f.call({ action: "list", project: undefined, requirement: "r1" }))
      .total,
    2,
  );
});
test("stale revision and non-owner changes fail", async (t) => {
  const f = await fixture(t);
  await f.call({
    action: "state.update",
    expected_revision: 1,
    next: "Continue",
  });
  await assert.rejects(
    f.call({ action: "state.update", expected_revision: 1, next: "stale" }),
    error("REVISION_CONFLICT"),
  );
  await assert.rejects(
    f.call({ action: "state.update", actor: "other", expected_revision: 2 }),
    error("NOT_COORDINATOR"),
  );
});
test("internal helpers cannot be invoked as CLI actions", async (t) => {
  const f = await fixture(t);
  for (const action of ["constructor", "artifact", "store", "scoped"])
    await assert.rejects(f.call({ action }), error("UNKNOWN_ACTION"));
});
test("path traversal and symlinks rejected", async (t) => {
  const f = await fixture(t);
  for (const x of ["../a", "/a", "a\\b", "C:/x"])
    assert.throws(() => relative(x), error("INVALID_PATH"));
  fs.symlinkSync(f.dir, path.join(f.root, "escape"));
  assert.throws(() => f.store.path("escape/test"), error("SYMLINK"));
});
test("lock prevents concurrent writes without auto-steal", async (t) => {
  const f = await fixture(t);
  await f.store.locked(async () =>
    assert.rejects(
      f.call({ action: "state.update", expected_revision: 1, next: "x" }),
      error("WORKSPACE_BUSY"),
    ),
  );
  assert.equal((await f.call({ action: "lock.inspect" })).locked, false);
});
test("tampered record digest is rejected", async (t) => {
  const f = await fixture(t);
  const p = f.store.path("workspace.json"),
    r = JSON.parse(fs.readFileSync(p));
  r.data.title = "tampered";
  fs.writeFileSync(p, JSON.stringify(r));
  assert.throws(() => f.store.read("workspace.json"), error("INTEGRITY"));
});
test("actual legacy records preserve numeric and Unicode hashes", async (t) => {
  const f = await fixture(t),
    data = JSON.parse(
      fs.readFileSync(
        new URL("./fixtures/legacy-records.json", import.meta.url),
      ),
    );
  for (const [ref, raw] of Object.entries(data.records)) {
    checkedBytes(Buffer.from(raw), ref);
    const p = path.join(f.dir, "legacy", ref);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, raw);
  }
  const root = path.join(f.dir, "legacy"),
    s = new Store(root);
  const before = fs.readFileSync(s.path("workspace.json"));
  const result = await execute(root, {
    action: "resume",
    project: "demo",
    requirement: "123",
  });
  assert.equal(result.workspace_runtime_schema, 2);
  assert.deepEqual(before, fs.readFileSync(s.path("workspace.json")));
  await execute(root, {
    action: "workspace.upgrade",
    actor: "lead",
    expected_revision: 1,
    source_execution_stopped: true,
    note: "Upgrade fixture",
  });
  assert.equal(s.read("workspace.json").schema, 3);
  assert.equal(s.version("workspace.json", 1).schema, 2);
});
test("history retains previous states across writes", async (t) => {
  const f = await fixture(t);
  await f.call({ action: "state.update", expected_revision: 1, next: "A" });
  await f.call({ action: "state.update", expected_revision: 2, next: "B" });
  assert.equal(
    f.store.version("projects/demo/requirements/r1/state.json", 2).data.next,
    "A",
  );
  assert.equal(
    (
      await f.call({
        action: "record.history",
        path: "projects/demo/requirements/r1/state.json",
      })
    ).items.length,
    3,
  );
});
test("shared rules pin versions and constrain overrides", async (t) => {
  const f = await fixture(t);
  await f.call({
    action: "shared.publish",
    shared: "rules",
    kind: "config",
    title: "Defaults",
    projects: ["demo"],
    source: "Fixture",
    content: { size: 10 },
    overridable_keys: ["size"],
  });
  await f.call({
    action: "shared.attach",
    shared: "rules",
    revision: 1,
    expected_revision: 1,
    overrides: { size: 20 },
  });
  await f.call({
    action: "shared.publish",
    shared: "rules",
    kind: "config",
    title: "Defaults",
    projects: ["demo"],
    source: "Fixture",
    content: { size: 30 },
    overridable_keys: ["size"],
    expected_revision: 1,
  });
  const x = (
    await f.call({
      action: "shared.resolve",
      shared: "rules",
      include_content: true,
    })
  ).items[0];
  assert.equal(x.content.size, 20);
  assert.equal(x.revision, 1);
  assert.equal(x.latest_revision, 2);
});
test("overlapping tasks and resource ownership enforced", async (t) => {
  const f = await fixture(t);
  await f.task();
  await assert.rejects(f.task({ task: "task2" }), error("TASK_OVERLAP"));
  await f.task({ task: "task2", cases: ["case3"] });
  await f.call({
    action: "resource.acquire",
    task: "task1",
    resource: "browser:fixture",
  });
  await assert.rejects(
    f.call({
      action: "resource.acquire",
      task: "task2",
      resource: "browser:fixture",
    }),
    error("RESOURCE_BUSY"),
  );
});
test("case verdict requires evidence and remains separate from synchronization", async (t) => {
  const f = await fixture(t);
  await f.task();
  await assert.rejects(
    f.call({
      action: "case.record",
      task: "task1",
      case: "case1",
      status: "passed",
      basis: "test",
      expected_revision: 0,
    }),
    error("EVIDENCE_REQUIRED"),
  );
  await f.evidence();
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case1",
    status: "failed",
    basis: "Fixture mismatch",
    evidence: ["proof"],
    bugs: ["issue-1"],
    expected_revision: 0,
  });
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case2",
    status: "failed",
    basis: "Same fixture mismatch",
    evidence: ["proof"],
    bugs: ["issue-1"],
    expected_revision: 0,
  });
  const r = await f.call({ action: "run.summary", run: "run1" });
  assert.equal(r.recorded_results.failed, 2);
  assert.equal(r.distinct_bug_count, 1);
  assert.equal(r.pending_sync, 2);
});
test("extended states remain distinct, missing scenarios are not_run", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case1",
    status: "needs_verification",
    basis: "Version not available",
    expected_revision: 0,
  });
  const r = await f.call({ action: "run.summary", run: "run1" });
  assert.equal(r.recorded_results.needs_verification, 1);
  assert.equal(r.recorded_results.not_run, 1);
});
test("pause does not assert external stop, transfer rejects unresolved work", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.call({ action: "resource.acquire", task: "task1", resource: "demo" });
  const p = await f.call({
    action: "task.pause",
    task: "task1",
    expected_revision: 1,
    note: "Pause",
  });
  assert.equal(p.external_stop_verified, false);
  await assert.rejects(
    f.call({
      action: "task.transfer",
      task: "task1",
      expected_revision: 2,
      new_owner: "other",
      previous_owner_stopped: true,
      note: "Transfer",
    }),
    error("PENDING_WORK"),
  );
});
test("workflow completion needs evidence, followups survive closeout", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.call({
      action: "workflow.record",
      expected_revision: 0,
      facts: { business: { status: "ready", basis: "Known" } },
    }),
    error("EVIDENCE_REQUIRED"),
  );
  await f.evidence();
  await f.call({
    action: "workflow.record",
    expected_revision: 0,
    facts: {
      business: {
        status: "ready",
        basis: "Source reviewed",
        evidence: ["proof"],
      },
    },
  });
  await f.call({
    action: "followup.record",
    followup: "later",
    title: "Release later",
    status: "waiting",
    basis: "Not released",
    next: "Check deployment",
    expected_revision: 0,
  });
  await f.call({
    action: "requirement.archive",
    archived: true,
    reason: "Review complete",
    expected_revision: 1,
  });
  assert.equal(
    (await f.call({ action: "resume" })).followups.counts.waiting,
    1,
  );
});
test("backup restores registered evidence, history and recovery guard", async (t) => {
  const f = await fixture(t);
  await f.evidence();
  await f.task();
  const b = await f.call({
    action: "backup.create",
    destination: path.join(f.dir, "backup.zip"),
  });
  await f.call({ action: "backup.verify", archive: b.path });
  const dest = path.join(f.dir, "restored");
  await f.call({
    action: "backup.restore",
    archive: b.path,
    destination: dest,
  });
  const r = await execute(dest, {
    action: "resume",
    project: "demo",
    requirement: "r1",
  });
  assert.equal(r.restored_review_required, true);
  await assert.rejects(
    execute(dest, {
      action: "resource.acquire",
      actor: "lead",
      project: "demo",
      requirement: "r1",
      task: "task1",
      resource: "page",
    }),
    error("RECOVERY_REVIEW"),
  );
});
test("sensitive snapshot excluded with explicit partial coverage", async (t) => {
  const f = await fixture(t),
    p = path.join(f.dir, "sensitive.txt");
  fs.writeFileSync(p, "synthetic private evidence");
  await f.call({
    action: "artifact.import",
    artifact: "private",
    source_path: p,
    purpose: "Sensitive fixture",
    sensitive: true,
  });
  await assert.rejects(
    f.call({ action: "backup.create", destination: path.join(f.dir, "a.zip") }),
    error("BACKUP_INCOMPLETE"),
  );
  const b = await f.call({
    action: "backup.create",
    destination: path.join(f.dir, "b.zip"),
    allow_partial: true,
  });
  assert.equal(b.complete_for_registered_snapshots, false);
  const files = unzipChecked(fs.readFileSync(b.path));
  assert.equal(
    Object.keys(files).some((x) => x.startsWith("data/artifacts/")),
    false,
  );
});
test("archive integrity and expansion limits enforced", () => {
  const b = zipFiles({ "demo.txt": Buffer.from("fixture") });
  assert.equal(unzipChecked(b)["demo.txt"].toString(), "fixture");
  assert.throws(
    () => unzipChecked(b, { maxBytes: 4 }),
    error("UNSAFE_ARCHIVE"),
  );
  assert.throws(
    () => unzipChecked(Buffer.from("bad")),
    error("UNSAFE_ARCHIVE"),
  );
});
test("manual README is preserved", async (t) => {
  const f = await fixture(t),
    p = f.store.path("projects/demo/requirements/r1/README.md");
  fs.writeFileSync(p, "Manual notes");
  await assert.rejects(
    f.call({ action: "summary.write" }),
    error("USER_FILE_EXISTS"),
  );
  assert.equal(fs.readFileSync(p, "utf8"), "Manual notes");
});
