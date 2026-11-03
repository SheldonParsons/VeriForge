import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT } from "./files.mjs";
import { unzipChecked } from "../skills/qa-workflow/scripts/lib/archive.mjs";
import {
  VERSION,
  sha,
  atomicBytes,
  encoded,
} from "../skills/qa-workflow/scripts/lib/store.mjs";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "veriforge-bundle-"));
let calls = 0;
try {
  const archive = path.join(ROOT, "dist", `veriforge-${VERSION}.zip`),
    bytes = fs.readFileSync(archive),
    entries = unzipChecked(bytes);
  for (const [ref, b] of Object.entries(entries)) {
    const p = path.join(temp, ref);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b);
  }
  const skill = path.join(temp, "qa-workflow");
  const npm = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: skill, encoding: "utf8", timeout: 120000 },
  );
  if (npm.status !== 0)
    throw new Error("Independent npm ci failed: " + npm.stderr.slice(0, 1000));
  const run = (q, workspace = path.join(temp, "workspace")) => {
    const r = spawnSync(
      process.execPath,
      [path.join(skill, "scripts/qa.mjs"), "--workspace", workspace],
      {
        input: JSON.stringify({
          actor: "lead",
          project: "demo",
          requirement: "r1",
          ...q,
        }),
        cwd: temp,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    calls++;
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    return parsed.result;
  };
  run({ action: "capabilities" });
  run({ action: "workspace.init", title: "Clean install fixture" });
  run({ action: "project.create", title: "Example", systems: { web: "Web" } });
  run({
    action: "requirement.create",
    title: "Example requirement",
    systems: [{ project: "demo", system: "web" }],
  });
  run({
    action: "project.configure",
    expected_revision: 1,
    integrations: { "asynctest-kb": { project: "Example" } },
  });
  run({
    action: "context.plan",
    stage: "bootstrap",
    question: "Who approves requests?",
  });
  const proof = path.join(temp, "proof.json");
  fs.writeFileSync(proof, '{"synthetic":true}');
  run({
    action: "artifact.import",
    artifact: "proof",
    source_path: proof,
    purpose: "Fixture",
  });
  run({
    action: "workflow.record",
    expected_revision: 0,
    facts: {
      business: {
        status: "ready",
        basis: "Synthetic requirements reviewed",
        evidence: ["proof"],
      },
    },
  });
  run({
    action: "task.create",
    task: "t1",
    owner: "lead",
    scope: "Fixture",
    run: "run1",
    cases: ["case1"],
    inputs: ["proof"],
  });
  run({
    action: "case.record",
    task: "t1",
    case: "case1",
    status: "passed",
    basis: "Synthetic test result only",
    evidence: ["proof"],
    expected_revision: 0,
  });
  assert.equal(
    run({ action: "run.summary", run: "run1" }).recorded_results.passed,
    1,
  );
  run({
    action: "task.finish",
    task: "t1",
    status: "closed",
    note: "Fixture complete",
    expected_revision: 1,
  });
  run({
    action: "followup.record",
    followup: "real-tools",
    title: "Real host acceptance",
    status: "waiting",
    basis: "Not part of this fixture",
    next: "Run authorized real-agent checks",
    expected_revision: 0,
  });
  run({ action: "summary.write" });
  const b = run({
    action: "backup.create",
    destination: path.join(temp, "backup.zip"),
  });
  run({ action: "backup.verify", archive: b.path });
  const restored = path.join(temp, "restored");
  run({ action: "backup.restore", archive: b.path, destination: restored });
  assert.equal(
    run({ action: "resume" }, restored).restored_review_required,
    true,
  );
  run(
    {
      action: "restore.activate",
      source_execution_stopped: true,
      expected_revision: 1,
      note: "Fixture source stopped",
    },
    restored,
  );
  assert.equal(
    run({ action: "resume" }, restored).restored_review_required,
    false,
  );
  const installed = path.join(temp, "installed", "qa-workflow");
  const installer = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools/install.mjs"), "--target", installed],
    { encoding: "utf8" },
  );
  assert.equal(installer.status, 0, installer.stderr);
  assert.ok(fs.existsSync(path.join(installed, "SKILL.md")));
  const again = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools/install.mjs"), "--target", installed],
    { encoding: "utf8" },
  );
  assert.notEqual(again.status, 0);
  const result = {
    version: VERSION,
    archive: path.basename(archive),
    sha256: sha(bytes),
    files: Object.keys(entries).length,
    independent_npm_ci: true,
    cli_calls: calls,
    installer_preserves_existing_target: true,
    real_business_execution: false,
    global_installation: false,
    host_discovery_verified: false,
  };
  atomicBytes(
    path.join(ROOT, "dist", `veriforge-${VERSION}.verification.json`),
    encoded(result),
  );
  console.log(JSON.stringify(result));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
