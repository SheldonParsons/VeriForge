import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Fault,
  need,
  object,
  text,
  canonical,
  inside,
  sha,
  encoded,
  atomicBytes,
  now,
} from "./store.mjs";

const scopeKeys = [
  "workspace_id",
  "project",
  "system",
  "environment",
  "service",
];
export function privateDirectory(workspace) {
  const root = canonical(
      process.env.VERIFORGE_PRIVATE_DIR ||
        path.join(os.homedir(), ".veriforge", "private"),
    ),
    pkg = canonical(fileURLToPath(new URL("../../", import.meta.url)));
  need(
    !inside(pkg, root) && (!workspace || !inside(canonical(workspace), root)),
    "PRIVATE_LOCATION",
    "Credential storage must be outside the Skill and workspace.",
  );
  for (let p = root; ; p = path.dirname(p)) {
    need(
      !fs.existsSync(path.join(p, ".git")),
      "PRIVATE_LOCATION",
      "Credential storage must be outside Git repositories.",
    );
    if (path.dirname(p) === p) break;
  }
  return root;
}
function key(salt) {
  const value = process.env.VERIFORGE_VAULT_KEY;
  need(
    typeof value === "string" && value.length >= 24,
    "VAULT_LOCKED",
    "Provide a strong VERIFORGE_VAULT_KEY through your local secret manager or environment.",
  );
  return crypto.scryptSync(value, salt, 32);
}
function checkScope(scope) {
  need(
    object(scope) &&
      scopeKeys.every((k) => typeof scope[k] === "string" && scope[k].trim()) &&
      Object.keys(scope).every((k) => [...scopeKeys, "role"].includes(k)),
    "INVALID_SCOPE",
    "Credential scope requires workspace, project, system, environment and service.",
  );
  return scope;
}
export class Vault {
  constructor(workspace) {
    this.root = privateDirectory(workspace);
  }
  file(ref) {
    text(ref, "credential_ref", 200);
    return path.join(this.root, "vault", sha(ref) + ".json");
  }
  status(ref) {
    const p = this.file(ref);
    if (!fs.existsSync(p)) return { ref, configured: false };
    const d = JSON.parse(fs.readFileSync(p));
    return {
      ref,
      configured: true,
      revision: d.revision,
      scope: d.scope,
      fields: d.fields,
      updated_at: d.updated_at,
      encrypted: true,
    };
  }
  list() {
    const dir = path.join(this.root, "vault");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((x) => /^[a-f0-9]{64}\.json$/.test(x))
      .map((x) => {
        const d = JSON.parse(fs.readFileSync(path.join(dir, x)));
        return this.status(d.ref);
      });
  }
  put(q) {
    const ref = text(q.ref, "ref", 200),
      scope = checkScope(q.scope);
    need(
      object(q.value) &&
        Object.keys(q.value).length &&
        Object.entries(q.value).every(
          ([k, v]) =>
            /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) &&
            typeof v === "string" &&
            v.length <= 65536,
        ),
      "INVALID_SECRET",
      "Credential value must be a string-field object.",
    );
    const p = this.file(ref),
      old = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
    need(
      q.expected_revision === (old?.revision ?? 0),
      "REVISION_CONFLICT",
      "Credential metadata changed.",
    );
    need(
      !old || encoded(old.scope).equals(encoded(scope)),
      "CREDENTIAL_SCOPE",
      "Use a new reference for another credential scope.",
    );
    const salt = crypto.randomBytes(16),
      iv = crypto.randomBytes(12),
      meta = {
        schema: 1,
        ref,
        scope,
        revision: (old?.revision ?? 0) + 1,
        fields: Object.keys(q.value).sort(),
        updated_at: now(),
      },
      cipher = crypto.createCipheriv("aes-256-gcm", key(salt), iv);
    cipher.setAAD(encoded(meta));
    const ciphertext = Buffer.concat([
      cipher.update(encoded(q.value)),
      cipher.final(),
    ]);
    const value = {
      ...meta,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    fs.chmodSync(path.dirname(p), 0o700);
    const lock = path.join(this.root, "vault", ".write-lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new Fault("VAULT_BUSY", "Credential store is being updated.");
    }
    try {
      const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
      need(
        (current?.revision ?? 0) === (old?.revision ?? 0),
        "REVISION_CONFLICT",
        "Credential changed while preparing update.",
      );
      if (old)
        atomicBytes(
          path.join(this.root, "history", sha(ref), `${old.revision}.json`),
          encoded(old),
          false,
        );
      atomicBytes(p, encoded(value));
    } finally {
      fs.rmdirSync(lock);
    }
    return this.status(ref);
  }
  resolve(ref, scope) {
    const p = this.file(ref);
    need(
      fs.existsSync(p),
      "CREDENTIAL_MISSING",
      "Credential reference is not configured.",
    );
    const d = JSON.parse(fs.readFileSync(p));
    checkScope(scope);
    need(
      scopeKeys.every((k) => scope[k] === d.scope[k]) &&
        (!d.scope.role || d.scope.role === scope.role),
      "CREDENTIAL_SCOPE",
      "Credential does not match the requested scope.",
    );
    const { salt, iv, tag, ciphertext, ...meta } = d;
    let value;
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key(Buffer.from(salt, "base64")),
        Buffer.from(iv, "base64"),
      );
      decipher.setAAD(encoded(meta));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      value = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64")),
          decipher.final(),
        ]),
      );
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault(
        "VAULT_AUTH_FAILED",
        "Credential decryption or integrity check failed.",
      );
    }
    return { value, revision: d.revision };
  }
}
export const secretLike =
  /^(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token)$/i;
export function rejectPlainSecrets(value) {
  const visit = (x) => {
    if (Array.isArray(x)) x.forEach(visit);
    else if (object(x))
      for (const [k, v] of Object.entries(x)) {
        need(
          !secretLike.test(k) || v === null || v === "" || v === "[REDACTED]",
          "PLAINTEXT_SECRET",
          "Use a credential reference instead of a plaintext secret.",
        );
        visit(v);
      }
  };
  visit(value);
}
export function redact(value, known = []) {
  const scrub = (s) =>
    known
      .filter((x) => typeof x === "string" && x.length >= 3)
      .reduce((a, b) => a.split(b).join("[REDACTED]"), s);
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((x) => redact(x, known));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretLike.test(k) ? "[REDACTED]" : redact(v, known),
      ]),
    );
  return value;
}
