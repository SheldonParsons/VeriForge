import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { ROOT, files, sourceFiles, relative } from "./files.mjs";
import { sha, VERSION } from "../skills/qa-workflow/scripts/lib/store.mjs";
export async function validate() {
  const list = sourceFiles(),
    failures = [];
  let links = 0,
    images = 0;
  const deny = [
    /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i,
    /\/(?:Users|home)\/[a-zA-Z0-9_-]+\/(?:Documents|Desktop|Projects)/,
    /codex:\/\/threads\//,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:ghp_|github_pat_|sk-proj-)[a-zA-Z0-9_]{16,}/,
  ];
  const additional = process.env.VERIFORGE_AUDIT_PATTERNS
    ? JSON.parse(fs.readFileSync(process.env.VERIFORGE_AUDIT_PATTERNS))
    : [];
  for (const p of list) {
    const rel = relative(p),
      b = fs.readFileSync(p);
    if (/\.(py|pyc|zip)$/.test(p))
      failures.push({
        file: rel,
        reason: "Forbidden runtime or nested archive",
      });
    if (/\.(mjs|cjs)$/.test(p)) {
      const r = spawnSync(process.execPath, ["--check", p], {
        encoding: "utf8",
      });
      if (r.status !== 0)
        failures.push({ file: rel, reason: "Invalid JavaScript" });
    }
    if (/\.(md|json|mjs|yaml|svg)$/.test(p)) {
      const s = b.toString();
      for (const rule of deny)
        if (rule.test(s))
          failures.push({
            file: rel,
            reason: "Potential private information pattern",
          });
      for (const pattern of additional)
        if (new RegExp(pattern, "i").test(s))
          failures.push({ file: rel, reason: "Organization-specific content" });
      if (p.endsWith(".md"))
        for (const match of s.matchAll(
          /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g,
        )) {
          const link = match[1];
          if (/^(https?:|mailto:|#)/.test(link)) continue;
          if (link.includes("${")) continue;
          const resolved = path.resolve(
            path.dirname(p),
            decodeURIComponent(link.split("#")[0]),
          );
          links++;
          if (!fs.existsSync(resolved))
            failures.push({ file: rel, reason: "Broken local link", link });
        }
      if (p.endsWith(".json"))
        try {
          JSON.parse(s);
        } catch {
          failures.push({ file: rel, reason: "Invalid JSON" });
        }
    }
  }
  const skill = path.join(ROOT, "skills/qa-workflow"),
    entry = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8");
  assert.match(entry, /^---\nname: qa-workflow\n/);
  assert.match(entry, /\ndescription: .+/);
  assert.ok(entry.includes(`version: "${VERSION}"`));
  assert.ok(entry.split("\n").length < 500);
  for (const p of [
    "package.json",
    "skills/qa-workflow/package.json",
    "skills/qa-workflow/assets/capabilities.json",
  ])
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ROOT, p))).version,
      VERSION,
    );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(skill, "assets/guides/manifest.json")),
  );
  for (const item of manifest.items) {
    const b = fs.readFileSync(path.join(skill, item.path));
    assert.equal(sha(b), item.sha256);
    const m = await sharp(b).metadata();
    assert.ok(m.width > 0 && m.height > 0);
    images++;
  }
  const publicPng = files(skill).filter((p) => p.endsWith(".png"));
  assert.equal(
    images,
    publicPng.length,
    "All guide images must be inventoried",
  );
  const result = {
    ok: !failures.length,
    version: VERSION,
    source_files: list.length,
    local_links_checked: links,
    guide_images_checked: images,
    failures,
    scope:
      "Current allowlisted source and Skill files; Git history and host behavior are not covered.",
  };
  if (failures.length)
    throw Object.assign(new Error("Validation failed"), { result });
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  validate()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(JSON.stringify(e.result ?? { error: e.message }));
      process.exitCode = 1;
    });
