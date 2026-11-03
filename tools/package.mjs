import fs from "node:fs";
import path from "node:path";
import { ROOT, files, sourceFiles, relative } from "./files.mjs";
import { validate } from "./validate.mjs";
import {
  zipFiles,
  unzipChecked,
} from "../skills/qa-workflow/scripts/lib/archive.mjs";
import {
  VERSION,
  sha,
  atomicBytes,
  encoded,
} from "../skills/qa-workflow/scripts/lib/store.mjs";
await validate();
const out = path.join(ROOT, "dist");
fs.mkdirSync(out, { recursive: true });
const skill = path.join(ROOT, "skills/qa-workflow"),
  sets = [
    {
      name: `veriforge-${VERSION}.zip`,
      files: files(skill).map((p) => [
        "qa-workflow/" + path.relative(skill, p).split(path.sep).join("/"),
        fs.readFileSync(p),
      ]),
    },
    {
      name: `veriforge-source-${VERSION}.zip`,
      files: sourceFiles().map((p) => [
        "VeriForge/" + relative(p),
        fs.readFileSync(p),
      ]),
    },
  ];
const outputs = [];
for (const set of sets) {
  const bytes = zipFiles(Object.fromEntries(set.files));
  const check = unzipChecked(bytes);
  if (Object.keys(check).length !== set.files.length)
    throw new Error("Entry mismatch");
  const target = path.join(out, set.name);
  if (fs.existsSync(target)) {
    if (sha(fs.readFileSync(target)) !== sha(bytes))
      throw new Error(
        "Output exists with different content; use a fresh build output after preserving the prior candidate.",
      );
  } else atomicBytes(target, bytes, false);
  outputs.push({
    file: set.name,
    sha256: sha(bytes),
    bytes: bytes.length,
    files: set.files.length,
  });
}
const manifest = {
  version: VERSION,
  outputs,
  contains_git_history: false,
  contains_dependencies: false,
};
atomicBytes(
  path.join(out, `veriforge-${VERSION}.manifest.json`),
  encoded(manifest),
);
console.log(JSON.stringify(manifest));
