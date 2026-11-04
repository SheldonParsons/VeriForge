import fs from "node:fs";
import path from "node:path";
import { need, object, slug, sha, canonical } from "./store.mjs";

// Read-only local delivery validation. This does not validate business truth or remote state.
export function auditDelivery(rt, q) {
  rt.store.ready();
  const { prefix } = rt.req(q);
  const issues = [],
    warnings = [];
  const issue = (code, details = {}) => issues.push({ code, ...details });
  const readArtifact = (id) => {
    try {
      return rt.artifact(prefix, id);
    } catch (e) {
      issue(e.code ?? "EVIDENCE_ERROR", { artifact: id });
      return null;
    }
  };
  const mapRecord = readArtifact(q.case_map_artifact);
  need(
    mapRecord,
    "CASE_MAP_REQUIRED",
    "A registered case identity map is required.",
  );
  let map;
  try {
    map = JSON.parse(
      fs.readFileSync(rt.store.path(mapRecord.data.path), "utf8"),
    );
  } catch {
    need(false, "INVALID_CASE_MAP", "Case identity map must be JSON.");
  }
  need(
    object(map) &&
      Array.isArray(map.cases) &&
      map.cases.length &&
      map.cases.every(
        (c) =>
          object(c) &&
          typeof c.id === "string" &&
          typeof c.title === "string" &&
          c.title.trim(),
      ),
    "INVALID_CASE_MAP",
    "Map needs nonempty cases with stable id and title.",
  );
  const ids = map.cases.map((c) => slug(c.id));
  need(
    new Set(ids).size === ids.length,
    "INVALID_CASE_MAP",
    "Case IDs must be unique.",
  );
  need(
    map.source_artifact && map.identity_artifact,
    "INVALID_CASE_MAP",
    "Pin both displayed cases and their original identity source.",
  );
  const source = readArtifact(map.source_artifact),
    identity = readArtifact(map.identity_artifact);
  if (source && identity) {
    let rows, original;
    try {
      rows = JSON.parse(
        fs.readFileSync(rt.store.path(source.data.path), "utf8"),
      );
      original = JSON.parse(
        fs.readFileSync(rt.store.path(identity.data.path), "utf8"),
      );
    } catch {
      issue("SOURCE_MAP_UNVERIFIED");
    }
    if (
      Array.isArray(rows) &&
      Array.isArray(original?.case_ids_in_display_order)
    ) {
      if (
        rows.length !== map.cases.length ||
        original.case_ids_in_display_order.length !== rows.length
      )
        issue("CASE_MAP_SIZE_MISMATCH");
      else
        for (let i = 0; i < rows.length; i++)
          if (
            map.cases[i].id !== original.case_ids_in_display_order[i] ||
            map.cases[i].title !== (rows[i]["场景"] ?? rows[i].title)
          )
            issue("CASE_IDENTITY_MISMATCH", {
              position: i + 1,
              case: map.cases[i].id,
            });
    } else if (Array.isArray(original?.cases)) {
      if (
        original.cases.length !== map.cases.length ||
        map.cases.some(
          (c, i) =>
            c.id !== original.cases[i]?.id ||
            c.title !== original.cases[i]?.title,
        )
      )
        issue("CASE_IDENTITY_MISMATCH");
    } else issue("SOURCE_MAP_UNVERIFIED");
  }
  const selected = q.case_ids ?? ids;
  need(
    Array.isArray(selected) &&
      selected.length &&
      new Set(selected).size === selected.length &&
      selected.every((id) => ids.includes(id)),
    "CASE_SCOPE",
    "Select unique cases in the pinned map.",
  );
  need(
    Array.isArray(q.runs) &&
      q.runs.length &&
      new Set(q.runs).size === q.runs.length,
    "RUNS_REQUIRED",
    "Select explicit run IDs.",
  );
  q.runs.forEach(slug);
  const bindings = q.bugs ?? [];
  need(
    Array.isArray(bindings) &&
      bindings.every(
        (b) =>
          object(b) &&
          b.id &&
          b.artifact &&
          b.path &&
          ["ui", "api"].includes(b.kind),
      ),
    "INVALID_INPUT",
    "Bug bindings need id, artifact, path and kind.",
  );
  const bugIds = new Set(bindings.map((b) => b.id));
  need(
    bugIds.size === bindings.length,
    "INVALID_INPUT",
    "Duplicate bug bindings.",
  );
  const usedBugs = new Set();
  const results = [];
  for (const id of selected) {
    const candidates = q.runs
      .map((run) => ({
        run,
        record: rt.store.read(`${prefix}/runs/${run}/${id}.json`, true),
      }))
      .filter((x) => x.record);
    if (!candidates.length) {
      issue("CASE_RESULT_MISSING", { case: id });
      continue;
    }
    if (candidates.length > 1) {
      issue("AMBIGUOUS_RUN_RESULT", {
        case: id,
        runs: candidates.map((c) => c.run),
      });
      continue;
    }
    const { run, record: r } = candidates[0],
      expected = map.cases.find((c) => c.id === id);
    if (r.data.case_title !== expected.title)
      issue(
        r.data.case_title
          ? "RESULT_IDENTITY_MISMATCH"
          : "RESULT_IDENTITY_MISSING",
        { case: id, run },
      );
    const task = rt.store.read(
      `${prefix}/tasks/${slug(r.data.task)}.json`,
      true,
    );
    if (!task || task.data.run !== run || !task.data.cases.includes(id))
      issue("TASK_RESULT_MISMATCH", { case: id, run });
    if (
      ["passed", "failed"].includes(r.data.status) &&
      !r.data.evidence?.length
    )
      issue("EVIDENCE_REQUIRED", { case: id });
    for (const artifact of r.data.evidence ?? []) readArtifact(artifact);
    for (const bug of r.data.bugs ?? []) {
      usedBugs.add(bug);
      if (!bugIds.has(bug)) issue("BUG_BINDING_MISSING", { case: id, bug });
    }
    if (q.require_sync === true && r.data.sync !== "confirmed")
      issue("CARRIER_SYNC_PENDING", { case: id });
    if (r.data.sync === "confirmed") {
      if (!r.data.sync_receipt) issue("CARRIER_RECEIPT_MISSING", { case: id });
      else readArtifact(r.data.sync_receipt);
    }
    results.push({
      case: id,
      title: expected.title,
      run,
      status: r.data.status,
      sync: r.data.sync,
    });
  }
  for (const b of bindings) {
    if (!usedBugs.has(b.id))
      warnings.push({ code: "BUG_NOT_IN_SELECTED_CASES", bug: b.id });
    const artifact = readArtifact(b.artifact),
      file = path.isAbsolute(b.path)
        ? canonical(b.path)
        : rt.store.path(b.path);
    if (path.isAbsolute(b.path) && artifact?.data.source !== file) {
      issue("BUG_SOURCE_NOT_REGISTERED", { bug: b.id });
      continue;
    }
    if (
      !fs.existsSync(file) ||
      !artifact ||
      sha(fs.readFileSync(file)) !== artifact.data.sha256
    ) {
      issue("BUG_DRAFT_DRIFT", { bug: b.id });
      continue;
    }
    const body = fs.readFileSync(file, "utf8");
    if (q.custom_bug_format_basis) {
      warnings.push({ code: "CUSTOM_FORMAT_REQUIRES_REVIEW", bug: b.id });
      continue;
    }
    const steps = body.indexOf("[步骤]"),
      actual = body.indexOf("[结果]"),
      expected = body.indexOf("[期望]");
    if (!(steps >= 0 && actual > steps && expected > actual)) {
      issue("BUG_SECTION_ORDER", { bug: b.id });
      continue;
    }
    if (!/账号[:：]/.test(body.slice(0, steps)))
      issue("BUG_ACCOUNT_SECTION_MISSING", { bug: b.id });
    if (!/(?:^|\n)1[、.]/.test(body.slice(steps, actual)))
      issue("BUG_STEPS_NOT_NUMBERED", { bug: b.id });
    if (b.kind === "ui") {
      const images = [
        ...body.slice(actual, expected).matchAll(/!\[[^\]]*\]\(([^\n]+?)\)/g),
      ].map((m) => m[1]);
      if (!images.length) issue("BUG_RESULT_IMAGE_MISSING", { bug: b.id });
      for (let target of images) {
        target = target.replace(/^<|>$/g, "");
        if (/^https?:\/\//i.test(target)) {
          warnings.push({ code: "REMOTE_IMAGE_NOT_CHECKED", bug: b.id });
          continue;
        }
        const imagePath = canonical(path.resolve(path.dirname(file), target));
        const registered = rt.store
          .refs(`${prefix}/artifacts/*.json`)
          .map((p) => rt.store.read(p))
          .find(
            (a) =>
              a.data.source === imagePath ||
              rt.store.path(a.data.path) === imagePath,
          );
        if (!registered) {
          issue("BUG_IMAGE_NOT_REGISTERED", { bug: b.id });
          continue;
        }
        readArtifact(registered.data.artifact);
        if (!fs.existsSync(imagePath)) {
          issue("BUG_IMAGE_MISSING", { bug: b.id });
          continue;
        }
        if (sha(fs.readFileSync(imagePath)) !== registered.data.sha256)
          issue("BUG_IMAGE_DRIFT", { bug: b.id });
      }
    }
  }
  const pending = rt.blockers(q);
  if (pending.operations.length)
    issue("UNRESOLVED_ACTIONS", { count: pending.operations.length });
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    ready: issues.length === 0,
    scope:
      "Local identity, registered results, evidence and draft formatting only; not business acceptance or remote readback.",
    expected_cases: selected.length,
    recorded_cases: results.length,
    counts,
    results,
    issues,
    warnings,
    external_action_executed: false,
  };
}
