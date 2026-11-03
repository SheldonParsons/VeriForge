import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fixture, error } from "./helpers.mjs";
import {
  Vault,
  privateDirectory,
} from "../skills/qa-workflow/scripts/lib/vault.mjs";
import { walkFiles } from "../skills/qa-workflow/scripts/lib/store.mjs";
async function vaultFixture(t) {
  const f = await fixture(t);
  process.env.VERIFORGE_PRIVATE_DIR = path.join(f.dir, "private");
  process.env.VERIFORGE_VAULT_KEY = "synthetic-key-for-tests-only-123456789";
  t.after(() => {
    delete process.env.VERIFORGE_PRIVATE_DIR;
    delete process.env.VERIFORGE_VAULT_KEY;
  });
  const scope = {
    workspace_id: f.store.read("workspace.json").data.id,
    project: "demo",
    system: "web",
    environment: "fixture",
    service: "http",
    role: "tester",
  };
  return { ...f, scope, vault: new Vault(f.root) };
}
test("vault encrypts credentials and exposes metadata only", async (t) => {
  const f = await vaultFixture(t),
    value = {
      username: "synthetic-user",
      password: "synthetic-password-for-test",
    };
  const result = await f.call({
    action: "secret.put",
    ref: "demo-login",
    scope: f.scope,
    value,
    expected_revision: 0,
  });
  assert.equal(result.encrypted, true);
  assert.equal(JSON.stringify(result).includes(value.password), false);
  const raw = fs.readFileSync(f.vault.file("demo-login"), "utf8");
  assert.equal(raw.includes(value.password), false);
  assert.deepEqual(f.vault.resolve("demo-login", f.scope).value, value);
  assert.equal(
    walkFiles(f.root).some((p) => fs.readFileSync(p).includes(value.password)),
    false,
  );
});
test("wrong vault key, tampering and project mismatch fail closed", async (t) => {
  const f = await vaultFixture(t);
  f.vault.put({
    ref: "test",
    scope: f.scope,
    value: { token: "synthetic-token" },
    expected_revision: 0,
  });
  assert.throws(
    () => f.vault.resolve("test", { ...f.scope, project: "other" }),
    error("CREDENTIAL_SCOPE"),
  );
  process.env.VERIFORGE_VAULT_KEY = "different-synthetic-key-123456789";
  assert.throws(
    () => f.vault.resolve("test", f.scope),
    error("VAULT_AUTH_FAILED"),
  );
});
test("vault cannot live in workspace or any Git repository", async (t) => {
  const f = await vaultFixture(t);
  process.env.VERIFORGE_PRIVATE_DIR = path.join(f.root, "private");
  assert.throws(() => new Vault(f.root), error("PRIVATE_LOCATION"));
  const repo = path.join(f.dir, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  process.env.VERIFORGE_PRIVATE_DIR = path.join(repo, "private");
  assert.throws(() => new Vault(f.root), error("PRIVATE_LOCATION"));
});
test("credentials and vault files cannot enter ordinary state or snapshots", async (t) => {
  const f = await vaultFixture(t);
  await assert.rejects(
    f.call({
      action: "shared.publish",
      shared: "bad",
      kind: "config",
      title: "Bad",
      projects: ["demo"],
      source: "fixture",
      content: { password: "synthetic" },
    }),
    error("PLAINTEXT_SECRET"),
  );
  f.vault.put({
    ref: "test",
    scope: f.scope,
    value: { token: "synthetic-token" },
    expected_revision: 0,
  });
  await assert.rejects(
    f.call({
      action: "artifact.import",
      artifact: "bad",
      source_path: f.vault.file("test"),
      purpose: "Unsafe",
    }),
    error("PRIVATE_SOURCE"),
  );
});
async function serverFixture(t) {
  const f = await fixture(t);
  let writes = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/write") {
      writes++;
      res.end(JSON.stringify({ id: 1 }));
    } else if (req.url === "/error") {
      res.statusCode = 500;
      res.end('{"error":"fixture failure"}');
    } else if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "http://example.invalid/");
      res.end("{}");
    } else if (req.url === "/timeout") {
      req.socket.destroy();
    } else
      res.end(JSON.stringify({ id: 1, state: writes ? "saved" : "initial" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await f.call({
    action: "project.configure",
    expected_revision: 1,
    integrations: { http: { allowed_origins: [origin] } },
  });
  await f.task();
  const prep = (operation, payload, effect = "read") =>
    f.call({
      action: "action.prepare",
      task: "task1",
      operation,
      provider: "http",
      effect,
      resource: "fixture-api",
      authorization_basis: "User authorized isolated fixture",
      payload,
    });
  const run = (operation) =>
    f.call({
      action: "http.execute",
      task: "task1",
      operation,
      expected_revision: 1,
      authorized: true,
    });
  return { ...f, origin, prep, run, writes: () => writes };
}
test("HTTP read returns explicit assertions and does not confuse 200 with business pass", async (t) => {
  const f = await serverFixture(t);
  await f.prep("read", {
    url: f.origin + "/item",
    expect: [
      { path: "status", equals: 200 },
      { path: "body.state", equals: "saved" },
    ],
  });
  const r = await f.run("read");
  assert.equal(r.business_verdict, "failed");
  assert.equal(r.status, "completed");
  assert.equal(f.writes(), 0);
});
test("HTTP write verifies actual stored state with same-origin readback", async (t) => {
  const f = await serverFixture(t);
  await f.prep(
    "write",
    {
      url: f.origin + "/write",
      method: "POST",
      body: { title: "fixture" },
      expect: [{ path: "status", equals: 200 }],
      readback: {
        url: "/item/{body.id}",
        expect: [{ path: "body.state", equals: "saved" }],
      },
    },
    "write",
  );
  const r = await f.run("write");
  assert.equal(r.business_verdict, "passed");
  assert.equal(r.status, "completed");
  assert.equal(f.writes(), 1);
  await assert.rejects(f.run("write"), error("ACTION_STATE"));
  assert.equal(f.writes(), 1);
});
test("write without business readback stays unknown even with HTTP 200", async (t) => {
  const f = await serverFixture(t);
  await f.prep(
    "write",
    {
      url: f.origin + "/write",
      method: "POST",
      expect: [{ path: "status", equals: 200 }],
    },
    "write",
  );
  assert.equal((await f.run("write")).status, "unknown");
});
test("effect mismatch and malformed requests are rejected before dispatch", async (t) => {
  const f = await serverFixture(t);
  await f.prep("bad", { url: f.origin + "/write", method: "POST" });
  await assert.rejects(f.run("bad"), error("EFFECT_MISMATCH"));
  assert.equal(f.writes(), 0);
  assert.equal(
    (await f.call({ action: "action.read", operation: "bad" })).data.status,
    "prepared",
  );
});
test("HTTP never follows a redirect outside project origin", async (t) => {
  const f = await serverFixture(t);
  await f.prep("redirect", {
    url: f.origin + "/redirect",
    expect: [{ path: "status", equals: 302 }],
  });
  const r = await f.run("redirect");
  assert.equal(r.result.response.status, 302);
});
test("transport loss persists unknown state and blocks blind retry", async (t) => {
  const f = await serverFixture(t);
  await f.prep("lost", { url: f.origin + "/timeout" });
  await assert.rejects(f.run("lost"), error("ACTION_UNKNOWN"));
  assert.equal(
    (await f.call({ action: "action.read", operation: "lost" })).data.status,
    "unknown",
  );
  await assert.rejects(f.run("lost"), error("ACTION_STATE"));
});

test("credential reference cannot be reassigned to a different project scope", async (t) => {
  const f = await vaultFixture(t);
  f.vault.put({
    ref: "shared-name",
    scope: f.scope,
    value: { token: "fixture-token" },
    expected_revision: 0,
  });
  assert.throws(
    () =>
      f.vault.put({
        ref: "shared-name",
        scope: { ...f.scope, project: "other" },
        value: { token: "other-fixture-token" },
        expected_revision: 1,
      }),
    error("CREDENTIAL_SCOPE"),
  );
});
