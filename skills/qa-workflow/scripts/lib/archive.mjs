import fs from "node:fs";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import {
  Store,
  need,
  relative,
  sha,
  encoded,
  checkedBytes,
  atomicBytes,
  now,
  canonical,
  inside,
  Fault,
} from "./store.mjs";

export function zipFiles(files) {
  const items = {};
  for (const [name, bytes] of Object.entries(files)) {
    relative(name);
    items[name] = [
      new Uint8Array(bytes),
      { mtime: new Date("2000-01-01T00:00:00Z"), os: 3, attrs: 0o100600 << 16 },
    ];
  }
  return Buffer.from(zipSync(items, { level: 6 }));
}
export function unzipChecked(
  bytes,
  { maxBytes = 512 * 1024 * 1024, maxFiles = 100000 } = {},
) {
  bytes = Buffer.from(bytes);
  need(
    bytes.length <= maxBytes,
    "UNSAFE_ARCHIVE",
    "Compressed archive too large.",
  );
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  need(end >= 0, "UNSAFE_ARCHIVE", "Missing ZIP directory.");
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16);
  need(
    count !== 65535 &&
      count <= maxFiles &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0,
    "UNSAFE_ARCHIVE",
    "Unsupported ZIP64 or split archive.",
  );
  let cursor = offset,
    total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    need(
      cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50,
      "UNSAFE_ARCHIVE",
      "Invalid ZIP directory.",
    );
    const flags = bytes.readUInt16LE(cursor + 8),
      size = bytes.readUInt32LE(cursor + 24),
      n = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      attr = bytes.readUInt32LE(cursor + 38);
    need(
      !(flags & 1) &&
        size !== 0xffffffff &&
        ((attr >>> 16) & 0o170000) !== 0o120000,
      "UNSAFE_ARCHIVE",
      "Encrypted or symbolic-link entry is not supported.",
    );
    const name = bytes.subarray(cursor + 46, cursor + 46 + n).toString("utf8");
    relative(name);
    need(
      !names.has(name) && !name.endsWith("/"),
      "UNSAFE_ARCHIVE",
      "Duplicate or non-file entry.",
    );
    names.add(name);
    total += size;
    need(total <= maxBytes, "UNSAFE_ARCHIVE", "Expanded archive too large.");
    cursor += 46 + n + extra + comment;
  }
  let result;
  try {
    result = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Fault("INTEGRITY", "Archive decompression failed.");
  }
  need(
    Object.keys(result).length === names.size &&
      Object.keys(result).every((x) => names.has(x)),
    "UNSAFE_ARCHIVE",
    "ZIP entries disagree.",
  );
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, Buffer.from(v)]),
  );
}
export function verifyBackup(archive) {
  const files = unzipChecked(fs.readFileSync(archive));
  need(files["manifest.json"], "UNSAFE_ARCHIVE", "Manifest missing.");
  let m;
  try {
    m = JSON.parse(files["manifest.json"]);
  } catch {
    throw new Fault("INTEGRITY", "Invalid manifest.");
  }
  need(
    m.format === "qa-workflow-backup" &&
      m.schema === 1 &&
      Array.isArray(m.entries),
    "UNSUPPORTED_SCHEMA",
    "Unsupported backup format.",
  );
  const names = new Set(["manifest.json"]),
    records = [];
  for (const e of m.entries) {
    relative(e.path);
    need(
      e.path === "workspace.json" ||
        /^(projects|shared|artifacts)\//.test(e.path) ||
        /^\.qa\/(history(?:-v[23])?|resources)\//.test(e.path) ||
        e.path === ".qa/recovery.json",
      "UNSAFE_ARCHIVE",
      "Unmanaged backup path.",
    );
    const name = `data/${e.path}`,
      b = files[name];
    need(
      !names.has(name) && b && sha(b) === e.sha256 && b.length === e.bytes,
      "INTEGRITY",
      "Backup entry does not match manifest.",
    );
    names.add(name);
    if (e.path.endsWith(".json") && !e.path.startsWith("artifacts/"))
      records.push([e.path, checkedBytes(b, e.path)]);
  }
  need(
    names.size === Object.keys(files).length && files["data/workspace.json"],
    "UNSAFE_ARCHIVE",
    "Unexpected archive entries.",
  );
  const w = checkedBytes(files["data/workspace.json"]);
  need(
    w.data.id === m.workspace_id,
    "INTEGRITY",
    "Workspace identity differs.",
  );
  const excluded = new Set((m.exclusions ?? []).map((x) => x.artifact));
  for (const [ref, r] of records)
    if (r.data.kind === "artifact" && !excluded.has(ref))
      need(
        files[`data/${r.data.path}`] &&
          sha(files[`data/${r.data.path}`]) === r.data.sha256,
        "INTEGRITY",
        "Registered snapshot is missing.",
      );
  return { manifest: m, files };
}
export async function createBackup(root, q) {
  const store = new Store(root);
  return store.locked(() => {
    const w = store.ready();
    need(
      q.actor === w.data.maintainer,
      "NOT_MAINTAINER",
      "Maintainer required.",
    );
    const dest = canonical(q.destination);
    need(
      !inside(store.root, dest) &&
        fs.existsSync(path.dirname(dest)) &&
        !fs.existsSync(dest),
      "INVALID_DESTINATION",
      "Use a new archive outside the workspace.",
    );
    const refs = [
        ...new Set([
          ...store.records(),
          ...store.refs(".qa/history/*/*.json"),
          ...store.refs(".qa/history-v2/*/*.json"),
          ...store.refs(".qa/history-v3/*/*.json"),
        ]),
      ].sort(),
      files = {},
      exclusions = [];
    for (const ref of refs) {
      const r = store.read(ref);
      files[`data/${ref}`] = fs.readFileSync(store.path(ref));
      if (r.data.kind === "bug" && !ref.startsWith(".qa/")) {
        const draft = ref.replace(/\.json$/, ".md");
        const body = store.path(r.data.snapshot);
        need(
          fs.existsSync(body) && sha(fs.readFileSync(body)) === r.data.sha256,
          "INTEGRITY",
          "BUG draft snapshot changed.",
        );
        files["data/" + draft] = fs.readFileSync(body);
      }
      if (r.data.kind === "artifact") {
        let reason;
        if (r.data.sensitive && !q.include_sensitive)
          reason = "sensitive_not_included";
        else if (!fs.existsSync(store.path(r.data.path)))
          reason = "missing_snapshot";
        else if (
          sha(fs.readFileSync(store.path(r.data.path))) !== r.data.sha256
        )
          reason = "snapshot_hash_mismatch";
        if (reason) exclusions.push({ artifact: ref, reason });
        else
          files[`data/${r.data.path}`] = fs.readFileSync(
            store.path(r.data.path),
          );
      }
    }
    need(
      !exclusions.length || q.allow_partial === true,
      "BACKUP_INCOMPLETE",
      "Backup has explicit gaps.",
      { exclusions },
    );
    const manifest = {
      format: "qa-workflow-backup",
      schema: 1,
      created_at: now(),
      workspace_id: w.data.id,
      entries: Object.keys(files)
        .sort()
        .map((name) => ({
          path: name.slice(5),
          sha256: sha(files[name]),
          bytes: files[name].length,
        })),
      exclusions,
      complete_for_registered_snapshots: !exclusions.length,
      coverage:
        "Managed records and registered snapshots only; encrypted credential vault is excluded.",
    };
    files["manifest.json"] = encoded(manifest);
    const bytes = zipFiles(files);
    const tmp = `${dest}.verify-${process.pid}`;
    need(
      !fs.existsSync(tmp),
      "INVALID_DESTINATION",
      "Temporary output exists.",
    );
    try {
      atomicBytes(tmp, bytes, false);
      verifyBackup(tmp);
      fs.linkSync(tmp, dest);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    return {
      path: dest,
      sha256: sha(bytes),
      bytes: bytes.length,
      files: manifest.entries.length,
      exclusions,
      complete_for_registered_snapshots: !exclusions.length,
      off_device_copy_verified: false,
    };
  });
}
export async function restoreBackup(archive, destination) {
  const { manifest: m, files } = verifyBackup(archive),
    dest = canonical(destination),
    store = new Store(dest);
  need(
    !fs.existsSync(dest) && fs.existsSync(path.dirname(dest)),
    "INVALID_DESTINATION",
    "Restore into a new directory.",
  );
  fs.mkdirSync(dest, { mode: 0o700 });
  const marker = store.path(".restore-incomplete");
  atomicBytes(marker, Buffer.from("Restoration not yet verified.\n"), false);
  try {
    for (const e of m.entries)
      atomicBytes(store.path(e.path), files[`data/${e.path}`], false);
    await store.locked(() => {
      const old = store.read(".qa/recovery.json", true);
      store.write(
        ".qa/recovery.json",
        {
          kind: "recovery",
          reviewed: false,
          source_backup: canonical(archive),
          restored_at: now(),
          backup_time: m.created_at,
          exclusions: m.exclusions,
        },
        old?.revision ?? 0,
      );
      store.records().forEach((ref) => store.read(ref));
    });
    fs.unlinkSync(marker);
  } catch {
    throw new Fault(
      "RESTORE_INCOMPLETE",
      "Restore failed; new directory is retained with a marker.",
      { destination: dest },
    );
  }
  return {
    path: dest,
    files_restored: m.entries.length,
    execution_enabled: false,
    exclusions: m.exclusions,
  };
}
