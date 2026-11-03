import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fixture, error } from "./helpers.mjs";
import { annotate } from "../skills/qa-workflow/scripts/lib/annotate.mjs";
import { sha } from "../skills/qa-workflow/scripts/lib/store.mjs";
const definition = {
  scope: {
    project: "demo",
    system: "web",
    environment: "fixture",
    role: "tester",
  },
  status: "verified",
  headless: true,
  steps: [
    {
      tool: "take_snapshot",
      arguments: { pageId: "${page}" },
      effect: "read",
      check: "The expected fixture page heading is visible.",
    },
  ],
};
test("annotation preserves original, renders valid PNG and records provenance", async (t) => {
  const f = await fixture(t),
    input = path.join(f.dir, "original.png"),
    output = path.join(f.dir, "marked.png");
  await sharp({
    create: { width: 640, height: 400, channels: 4, background: "#ffffff" },
  })
    .png()
    .toFile(input);
  const before = sha(fs.readFileSync(input));
  const result = await annotate({
    input,
    output,
    annotations: [
      { box: [100, 100, 200, 50], label: "1. 示例问题区域 / Example" },
    ],
    redactions: [[500, 20, 80, 30]],
    synthetic: true,
  });
  assert.equal(sha(fs.readFileSync(input)), before);
  assert.equal((await sharp(output).metadata()).width, 640);
  assert.equal(JSON.parse(fs.readFileSync(result.evidence)).synthetic, true);
  await assert.rejects(
    annotate({ input, output, annotations: [] }),
    error("INVALID_DESTINATION"),
  );
});
test("annotation rejects out-of-bounds regions and overwrite", async (t) => {
  const f = await fixture(t),
    input = path.join(f.dir, "source.png");
  await sharp({
    create: { width: 200, height: 200, channels: 3, background: "white" },
  })
    .png()
    .toFile(input);
  await assert.rejects(
    annotate({
      input,
      output: path.join(f.dir, "out.png"),
      annotations: [{ box: [199, 10, 20, 20], label: "bad" }],
    }),
    error("INVALID_ANNOTATION"),
  );
});
test("UI module reusable only after evidence with matching environment and role", async (t) => {
  const f = await fixture(t);
  await f.evidence();
  await f.task();
  await f.call({
    action: "ui.module.register",
    module: "detail",
    definition,
    evidence: ["proof"],
    basis: "Observed fixture",
    expected_revision: 0,
  });
  const q = {
    action: "ui.plan",
    task: "task1",
    operation: "ui1",
    module: "detail",
    page_verified: true,
    page_evidence: "proof",
    parameters: { page: 7 },
    authorization_basis: "Read fixture",
  };
  const p = await f.call(q);
  assert.equal(p.external_action_executed, false);
  const result = await f.call({ action: "action.read", operation: "ui1" });
  assert.equal(result.data.payload.steps[0].arguments.pageId, 7);
  assert.equal(result.data.payload.headless, true);
  await f.task({
    task: "other",
    cases: ["case3"],
    context: {
      environment: "production",
      roles: ["tester"],
      systems: [{ project: "demo", system: "web" }],
    },
  });
  await assert.rejects(
    f.call({ ...q, task: "other", operation: "ui2" }),
    error("MODULE_SCOPE"),
  );
});
test("UI write classification follows module effects, not caller label", async (t) => {
  const f = await fixture(t);
  await f.evidence();
  await f.task();
  await f.call({
    action: "ui.module.register",
    module: "save",
    definition: {
      ...definition,
      steps: [{ ...definition.steps[0], effect: "write" }],
    },
    evidence: ["proof"],
    basis: "Fixture",
    expected_revision: 0,
  });
  await f.call({
    action: "ui.plan",
    task: "task1",
    operation: "ui1",
    module: "save",
    page_verified: true,
    page_evidence: "proof",
    parameters: { page: 1 },
    effect: "read",
    authorization_basis: "Fixture write authorized",
  });
  assert.equal(
    (await f.call({ action: "action.read", operation: "ui1" })).data.effect,
    "write",
  );
});
test("UI defect requires annotated real screenshot; synthetic input requires explicit fixture mode", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.evidence();
  const q = {
    action: "bug.draft",
    task: "task1",
    bug_id: "bug-001",
    bug: {
      kind: "ui",
      title: "[Fixture-Form] Missing label",
      actual: "Label is absent",
      expected: "Label is visible",
      steps: ["Open the fixture form"],
      evidence: ["proof"],
    },
  };
  await assert.rejects(f.call(q), error("SCREENSHOT_REQUIRED"));
  const input = path.join(f.dir, "original.png"),
    output = path.join(f.dir, "marked.png");
  await sharp({
    create: { width: 640, height: 400, channels: 3, background: "white" },
  })
    .png()
    .toFile(input);
  await annotate({
    input,
    output,
    annotations: [{ box: [100, 100, 200, 50], label: "Missing label" }],
    synthetic: true,
  });
  for (const [id, p] of [
    ["image", output],
    ["manifest", output + ".evidence.json"],
  ])
    await f.call({
      action: "artifact.import",
      artifact: id,
      source_path: p,
      purpose: "Synthetic screenshot",
    });
  q.bug.screenshots = [{ image: "image", manifest: "manifest" }];
  await assert.rejects(f.call(q), error("SYNTHETIC_EVIDENCE"));
  const r = await f.call({ ...q, fixture_only: true });
  const md = fs.readFileSync(f.store.path(r.markdown), "utf8");
  assert.ok(md.indexOf("[结果]") < md.indexOf("![已标注"));
  assert.ok(md.indexOf("![已标注") < md.indexOf("[期望]"));
  assert.ok(md.includes("优先级：3"));
  assert.equal(r.submitted, false);
});

test("BUG drafts and snapshots survive workspace backup restore", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.evidence();
  const result = await f.call({
    action: "bug.draft",
    task: "task1",
    bug_id: "api-bug",
    bug: {
      kind: "api",
      title: "[Fixture-API] Missing field",
      actual: "Field absent",
      expected: "Field present",
      steps: ["GET the synthetic resource"],
      evidence: ["proof"],
    },
  });
  const backup = await f.call({
    action: "backup.create",
    destination: path.join(f.dir, "with-bug.zip"),
  });
  const destination = path.join(f.dir, "restored-bug");
  await f.call({ action: "backup.restore", archive: backup.path, destination });
  assert.equal(
    fs.readFileSync(path.join(destination, result.markdown), "utf8"),
    fs.readFileSync(f.store.path(result.markdown), "utf8"),
  );
});
