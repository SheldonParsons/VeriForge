import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ignore = new Set([
  "node_modules",
  ".git",
  ".local",
  "dist",
  "coverage",
  "__pycache__",
]);
export function files(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) => {
      if (ignore.has(e.name) || e.isSymbolicLink()) return [];
      const p = path.join(root, e.name);
      return e.isDirectory() ? files(p) : [p];
    })
    .sort();
}
export const relative = (p) => path.relative(ROOT, p).split(path.sep).join("/");
export function sourceFiles() {
  const roots = [
    "README.md",
    "AGENTS.md",
    "HANDOFF.md",
    "roadmap.md",
    "package.json",
    "package-lock.json",
    ".gitignore",
    "skills",
    "tools",
    "tests",
    "docs",
  ];
  return roots.flatMap((p) => {
    const a = path.join(ROOT, p);
    return fs.statSync(a).isDirectory() ? files(a) : [a];
  });
}
