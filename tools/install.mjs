import fs from "node:fs";
import path from "node:path";
import { ROOT, files } from "./files.mjs";
const canonical = (value) => {
  let p = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(p)) {
    tail.unshift(path.basename(p));
    p = path.dirname(p);
  }
  return path.join(fs.realpathSync(p), ...tail);
};
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--target")
  throw new Error(
    "Usage: node tools/install.mjs --target /new/path/qa-workflow",
  );
const source = path.join(ROOT, "skills/qa-workflow"),
  target = canonical(args[1]);
if (
  path.basename(target) !== "qa-workflow" ||
  fs.existsSync(target) ||
  inside(source, target)
)
  throw new Error("Use a new target outside the source Skill.");
fs.mkdirSync(target, { recursive: true });
try {
  for (const p of files(source)) {
    const dest = path.join(target, path.relative(source, p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(p, dest, fs.constants.COPYFILE_EXCL);
  }
} catch (e) {
  fs.writeFileSync(
    path.join(target, ".install-incomplete"),
    "Installation incomplete; preserve or remove this new directory before retry.",
  );
  throw e;
}
console.log(
  JSON.stringify({
    installed: target,
    host_discovery_verified: false,
    dependencies_installed: false,
    next: "Run npm ci --omit=dev in the target, then node scripts/qa.mjs --capabilities. Refresh the host according to its actual Skill discovery mechanism.",
  }),
);
