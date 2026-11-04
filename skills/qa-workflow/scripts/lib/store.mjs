import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseLossless, isLosslessNumber } from "lossless-json";

export const VERSION = "0.4.0-rc.2";
export class Fault extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function need(ok, code, message, details = {}) {
  if (!ok) throw new Fault(code, message, details);
}
export const sha = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export const now = () => new Date().toISOString();
export const object = (x) =>
  x !== null && typeof x === "object" && !Array.isArray(x);
export function text(v, field, max = 4000) {
  need(
    typeof v === "string" && v.trim() && v.length <= max,
    "INVALID_INPUT",
    `${field} must be nonempty text (max ${max}).`,
  );
  return v;
}
export function slug(v) {
  need(
    typeof v === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v),
    "INVALID_ID",
    "Invalid identifier.",
  );
  return v;
}
export function relative(v) {
  need(
    typeof v === "string" &&
      v &&
      !v.includes("\\") &&
      !v.includes("\0") &&
      !path.posix.isAbsolute(v) &&
      v
        .split("/")
        .every((x) => x && x !== "." && x !== ".." && !x.includes(":")),
    "INVALID_PATH",
    "Use a workspace-relative path.",
  );
  return v;
}
export function canonical(p) {
  let tail = [];
  p = path.resolve(p);
  while (!fs.existsSync(p)) {
    tail.unshift(path.basename(p));
    const parent = path.dirname(p);
    need(parent !== p, "INVALID_PATH", "Cannot resolve path.");
    p = parent;
  }
  return path.join(fs.realpathSync(p), ...tail);
}
export const inside = (root, p) => p === root || p.startsWith(root + path.sep);
function compareKeys(a, b) {
  const aa = [...a],
    bb = [...b];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const d = aa[i].codePointAt(0) - bb[i].codePointAt(0);
    if (d) return d;
  }
  return aa.length - bb.length;
}
function numberText(v) {
  need(
    Number.isFinite(v),
    "INVALID_NUMBER",
    "Non-finite numbers are not supported.",
  );
  if (Object.is(v, -0)) return "-0.0";
  if (Number.isInteger(v)) {
    need(
      Number.isSafeInteger(v),
      "UNSAFE_NUMBER",
      "Use a string for an integer outside the safe range.",
    );
    return String(v);
  }
  let s = Math.abs(v) < 1e-4 ? v.toExponential() : String(v);
  return s.replace(
    /e([+-]?)(\d+)$/,
    (_, sign, n) => `e${sign || "+"}${n.padStart(2, "0")}`,
  );
}
export function encoded(value) {
  const walk = (v, depth) => {
    if (isLosslessNumber(v)) return v.value;
    if (typeof v === "number") return numberText(v);
    if (v === null || typeof v === "boolean" || typeof v === "string")
      return JSON.stringify(v);
    const pad = "  ".repeat(depth),
      child = "  ".repeat(depth + 1);
    if (Array.isArray(v))
      return v.length
        ? "[\n" +
            v.map((x) => child + walk(x, depth + 1)).join(",\n") +
            "\n" +
            pad +
            "]"
        : "[]";
    need(object(v), "INVALID_INPUT", "Only JSON values are supported.");
    const keys = Object.keys(v).sort(compareKeys);
    return keys.length
      ? "{\n" +
          keys
            .map(
              (k) => child + JSON.stringify(k) + ": " + walk(v[k], depth + 1),
            )
            .join(",\n") +
          "\n" +
          pad +
          "}"
      : "{}";
  };
  return Buffer.from(walk(value, 0) + "\n");
}
function plain(v) {
  if (isLosslessNumber(v)) {
    let n;
    try {
      n = v.valueOf();
    } catch {
      throw new Fault(
        "UNSAFE_NUMBER",
        "Numeric precision cannot be preserved; keep the original record.",
      );
    }
    need(
      typeof n === "number" && Number.isFinite(n),
      "UNSAFE_NUMBER",
      "Unsupported numeric value.",
    );
    return n;
  }
  if (Array.isArray(v)) return v.map(plain);
  if (object(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}
export function checkedBytes(bytes, ref = "record") {
  let lossless;
  try {
    lossless = parseLossless(bytes.toString("utf8"));
  } catch {
    throw new Fault("INTEGRITY", "Record is not valid JSON.", { path: ref });
  }
  const schema = Number(lossless?.schema),
    revision = Number(lossless?.revision);
  need(
    [1, 2, 3].includes(schema),
    "UNSUPPORTED_SCHEMA",
    "Unsupported record format.",
    { path: ref },
  );
  need(
    Number.isSafeInteger(revision) && revision > 0 && object(lossless.data),
    "INTEGRITY",
    "Invalid record structure.",
    { path: ref },
  );
  const { sha256, ...body } = lossless;
  need(
    sha256 === sha(encoded(body)),
    "INTEGRITY",
    "Record digest does not match.",
    { path: ref },
  );
  return plain(lossless);
}
export function syncDirectory(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomicBytes(file, bytes, replace = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.vf-tmp-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (replace) fs.renameSync(tmp, file);
    else {
      fs.linkSync(tmp, file);
      fs.unlinkSync(tmp);
    }
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) result.push(p);
    }
  };
  walk(root);
  return result.sort();
}
export const receipt = (ref, r, extra = {}) => ({
  path: ref,
  revision: r.revision,
  sha256: r.sha256,
  ...extra,
});
export class Store {
  constructor(root) {
    this.root = canonical(root);
    const pkg = canonical(fileURLToPath(new URL("../../", import.meta.url)));
    need(
      !inside(pkg, this.root),
      "INVALID_WORKSPACE",
      "Workspace must be outside the installed Skill.",
    );
  }
  path(ref) {
    relative(ref);
    let p = this.root;
    for (const part of ref.split("/")) {
      p = path.join(p, part);
      if (fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }))
        need(
          !fs.lstatSync(p).isSymbolicLink(),
          "SYMLINK",
          "Managed paths cannot be symlinks.",
          { path: ref },
        );
    }
    return p;
  }
  read(ref, missing = false) {
    const p = this.path(ref);
    if (missing && !fs.existsSync(p)) return null;
    need(
      fs.existsSync(p) && fs.statSync(p).isFile(),
      "NOT_FOUND",
      "Record not found.",
      { path: ref },
    );
    return checkedBytes(fs.readFileSync(p), ref);
  }
  historyPath(ref, revision, digest, schema = 1) {
    need(/^[a-f0-9]{64}$/.test(digest), "INTEGRITY", "Invalid history digest.");
    return `.qa/${schema === 1 ? "history" : schema === 2 ? "history-v2" : "history-v3"}/${sha(ref)}/${String(revision).padStart(8, "0")}-${digest}.json`;
  }
  version(ref, revision) {
    let r = this.read(ref);
    need(
      Number.isSafeInteger(revision) && revision >= 1 && revision <= r.revision,
      "NOT_FOUND",
      "Revision not found.",
    );
    while (r.revision > revision)
      r = this.read(
        this.historyPath(
          ref,
          r.revision - 1,
          r.previous,
          r.previous_schema ?? 1,
        ),
      );
    return r;
  }
  write(ref, data, expected, schema) {
    const old = this.read(ref, true),
      actual = old?.revision ?? 0;
    need(
      Number.isSafeInteger(expected) && expected === actual,
      "REVISION_CONFLICT",
      "Read the current revision before editing.",
      { path: ref, expected, actual },
    );
    schema ??= old?.schema ?? 3;
    need(
      [1, 2, 3].includes(schema) && (!old || schema >= old.schema),
      "UNSUPPORTED_SCHEMA",
      "Unsupported write or downgrade.",
    );
    const r = {
      schema,
      revision: actual + 1,
      updated_at: now(),
      previous: old?.sha256 ?? null,
      data,
    };
    if (old) r.previous_schema = old.schema;
    r.sha256 = sha(encoded(r));
    const raw = encoded(r);
    atomicBytes(
      this.path(this.historyPath(ref, r.revision, r.sha256, schema)),
      raw,
      false,
    );
    atomicBytes(this.path(ref), raw);
    return r;
  }
  refs(pattern) {
    const parts = pattern.split("/");
    let paths = [this.root];
    for (const part of parts) {
      const re = new RegExp(
        "^" +
          part
            .split("*")
            .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*") +
          "$",
      );
      paths = paths.flatMap((p) =>
        !fs.existsSync(p) || !fs.statSync(p).isDirectory()
          ? []
          : fs
              .readdirSync(p)
              .filter((n) => re.test(n))
              .map((n) => path.join(p, n))
              .filter((p) => !fs.lstatSync(p).isSymbolicLink()),
      );
    }
    return paths
      .filter((p) => fs.statSync(p).isFile())
      .map((p) => path.relative(this.root, p).split(path.sep).join("/"))
      .sort();
  }
  records() {
    const patterns = [
      "workspace.json",
      "shared/*.json",
      "projects/*/project.json",
      "projects/*/ui/*.json",
      "projects/*/requirements/*/state.json",
      "projects/*/requirements/*/tasks/*.json",
      "projects/*/requirements/*/operations/*.json",
      "projects/*/requirements/*/artifacts/*.json",
      "projects/*/requirements/*/runs/*/*.json",
      "projects/*/requirements/*/workflow.json",
      "projects/*/requirements/*/deliverables/*.json",
      "projects/*/requirements/*/followups/*.json",
      "projects/*/requirements/*/context/*.json",
      "projects/*/requirements/*/bindings/*.json",
      "projects/*/requirements/*/actions/*.json",
      "projects/*/requirements/*/bugs/*.json",
      ".qa/resources/*.json",
      ".qa/recovery.json",
    ];
    return [...new Set(patterns.flatMap((p) => this.refs(p)))].sort();
  }
  async locked(fn) {
    const p = this.path(".qa/write.lock");
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Fault(
          "WORKSPACE_BUSY",
          "Workspace is locked; inspect before recovery.",
        );
      throw e;
    }
    const token = crypto.randomUUID();
    try {
      atomicBytes(
        path.join(p, "owner.json"),
        encoded({
          token,
          pid: process.pid,
          host: os.hostname(),
          started_at: now(),
        }),
        false,
      );
      return await fn();
    } finally {
      const owner = path.join(p, "owner.json");
      if (
        fs.existsSync(owner) &&
        JSON.parse(fs.readFileSync(owner)).token === token
      ) {
        fs.unlinkSync(owner);
        fs.rmdirSync(p);
      }
    }
  }
  ready(execution = false) {
    need(
      !fs.existsSync(this.path(".restore-incomplete")),
      "RESTORE_INCOMPLETE",
      "Restore is incomplete.",
    );
    const w = this.read("workspace.json");
    need(
      [1, 2, 3].includes(w.data.runtime_schema ?? 1),
      "UNSUPPORTED_SCHEMA",
      "Unsupported workspace version.",
    );
    const r = this.read(".qa/recovery.json", true);
    need(
      !execution || !r || r.data.reviewed,
      "RECOVERY_REVIEW",
      "Reconcile the restored workspace before dispatch.",
    );
    return w;
  }
  requireV3() {
    const w = this.ready();
    need(
      w.schema === 3 && w.data.runtime_schema === 3,
      "UPGRADE_REQUIRED",
      "Upgrade the workspace before using candidate features.",
    );
  }
  catalog() {
    return [
      ...this.refs("projects/*/project.json"),
      ...this.refs("projects/*/requirements/*/state.json"),
    ].map((ref) => {
      const r = this.read(ref),
        d = r.data;
      return {
        path: ref,
        revision: r.revision,
        kind: d.kind,
        project: d.project,
        requirement: d.requirement ?? null,
        title: d.title,
        archived: d.archived ?? false,
      };
    });
  }
}
