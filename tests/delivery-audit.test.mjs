import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.mjs";
async function setup(t) {
  const f = await fixture(t);
  await f.evidence("cases", [{ 场景: "First" }, { 场景: "Second" }]);
  await f.evidence("identity", {
    case_ids_in_display_order: ["case2", "case1"],
  });
  await f.evidence("map", {
    source_artifact: "cases",
    identity_artifact: "identity",
    cases: [
      { id: "case2", title: "First" },
      { id: "case1", title: "Second" },
    ],
  });
  await f.evidence("proof");
  await f.task();
  const audit = (q) =>
    f.call({
      action: "delivery.audit",
      case_map_artifact: "map",
      runs: ["run1"],
      ...q,
    });
  return { ...f, audit };
}
test("delivery audit rejects missing records even if an informal log claims completion", async (t) => {
  const f = await setup(t);
  const r = await f.audit({});
  assert.equal(r.ready, false);
  assert.equal(
    r.issues.filter((x) => x.code === "CASE_RESULT_MISSING").length,
    2,
  );
});
test("delivery audit detects using display positions as stable case identities", async (t) => {
  const f = await setup(t);
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case1",
    case_title: "First",
    status: "passed",
    basis: "Observed",
    evidence: ["proof"],
    expected_revision: 0,
  });
  const r = await f.audit({ case_ids: ["case1"] });
  assert.ok(r.issues.some((x) => x.code === "RESULT_IDENTITY_MISMATCH"));
});
test("delivery audit accepts registered results with matching source identities", async (t) => {
  const f = await setup(t);
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case2",
    case_title: "First",
    status: "passed",
    basis: "Observed",
    evidence: ["proof"],
    expected_revision: 0,
  });
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case1",
    case_title: "Second",
    status: "blocked",
    basis: "Missing fixture data",
    expected_revision: 0,
  });
  const r = await f.audit({});
  assert.equal(r.ready, true);
  assert.deepEqual(r.counts, { passed: 1, blocked: 1 });
  assert.equal(r.external_action_executed, false);
});
test("delivery audit keeps carrier synchronization independent", async (t) => {
  const f = await setup(t);
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case2",
    case_title: "First",
    status: "passed",
    basis: "Observed",
    evidence: ["proof"],
    expected_revision: 0,
  });
  const r = await f.audit({ case_ids: ["case2"], require_sync: true });
  assert.ok(r.issues.some((x) => x.code === "CARRIER_SYNC_PENDING"));
});
test("delivery audit rejects a malformed bug and a bare screenshot path", async (t) => {
  const f = await setup(t);
  const rel = "projects/demo/requirements/r1/bugs/bug-1.md",
    p = f.store.path(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    "# Bug\n账号：tester\n[步骤]\n1、Observe\n[结果]\nPicture: /example.png\n[期望]\nExpected\n",
  );
  await f.call({
    action: "artifact.import",
    artifact: "bug",
    source_path: p,
    purpose: "Draft",
  });
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case2",
    case_title: "First",
    status: "failed",
    basis: "Observed mismatch",
    evidence: ["proof"],
    bugs: ["bug-1"],
    expected_revision: 0,
  });
  const r = await f.audit({
    case_ids: ["case2"],
    bugs: [{ id: "bug-1", artifact: "bug", path: rel, kind: "ui" }],
  });
  assert.ok(r.issues.some((x) => x.code === "BUG_RESULT_IMAGE_MISSING"));
});
test("delivery audit verifies inline images are registered for backup", async (t) => {
  const f = await setup(t);
  const image = path.join(f.dir, "image.png");
  fs.writeFileSync(image, "synthetic-image-fixture");
  const rel = "projects/demo/requirements/r1/bugs/bug-1.md",
    p = f.store.path(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `# Bug\n账号：tester\n[步骤]\n1、Observe\n[结果]\n![Observation](${image})\n[期望]\nExpected\n`,
  );
  await f.call({
    action: "artifact.import",
    artifact: "bug",
    source_path: p,
    purpose: "Draft",
  });
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case2",
    case_title: "First",
    status: "failed",
    basis: "Observed",
    evidence: ["proof"],
    bugs: ["bug-1"],
    expected_revision: 0,
  });
  const q = {
    case_ids: ["case2"],
    bugs: [{ id: "bug-1", artifact: "bug", path: rel, kind: "ui" }],
  };
  assert.ok(
    (await f.audit(q)).issues.some(
      (x) => x.code === "BUG_IMAGE_NOT_REGISTERED",
    ),
  );
  await f.call({
    action: "artifact.import",
    artifact: "image",
    source_path: image,
    purpose: "Fixture",
  });
  assert.equal((await f.audit(q)).ready, true);
});
