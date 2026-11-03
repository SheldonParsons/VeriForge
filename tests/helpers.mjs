import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execute } from "../skills/qa-workflow/scripts/qa.mjs";
import { Store } from "../skills/qa-workflow/scripts/lib/store.mjs";
export async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veriforge-test-")),
    root = path.join(dir, "workspace");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = (q) =>
    execute(root, { actor: "lead", project: "demo", requirement: "r1", ...q });
  await call({
    action: "workspace.init",
    title: "Synthetic testing workspace",
  });
  await call({
    action: "project.create",
    title: "Example application",
    systems: { web: "Web" },
  });
  await call({
    action: "requirement.create",
    title: "Example change",
    systems: [{ project: "demo", system: "web" }],
  });
  const evidence = async (
    id = "proof",
    content = { synthetic: true, observed: "fixture" },
  ) => {
    const file = path.join(dir, id + ".json");
    fs.writeFileSync(file, JSON.stringify(content));
    return call({
      action: "artifact.import",
      artifact: id,
      source_path: file,
      purpose: "Synthetic test evidence",
    });
  };
  const task = async (extra = {}) =>
    call({
      action: "task.create",
      task: "task1",
      owner: "lead",
      scope: "Synthetic cases",
      run: "run1",
      cases: ["case1", "case2"],
      context: {
        environment: "fixture",
        roles: ["tester"],
        systems: [{ project: "demo", system: "web" }],
      },
      ...extra,
    });
  return { dir, root, call, evidence, task, store: new Store(root) };
}
export const error = (code) => (e) => {
  assert.equal(e.code, code);
  return true;
};
