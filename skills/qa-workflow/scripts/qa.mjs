#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Runtime } from "./lib/runtime.mjs";
import { VERSION, Fault, need, object } from "./lib/store.mjs";
import { Vault, rejectPlainSecrets } from "./lib/vault.mjs";
import { CONTEXT_ACTIONS, contextAction } from "./lib/context.mjs";
import { ACTIONS, actionCommand } from "./lib/actions.mjs";
import { httpExecute } from "./lib/http.mjs";

import { annotate } from "./lib/annotate.mjs";
import { MODULE_ACTIONS, moduleAction } from "./lib/modules.mjs";
import { bugDraft } from "./lib/bugs.mjs";

export async function execute(workspace, q) {
  need(object(q), "INVALID_INPUT", "A JSON object is required.");
  if (q.action === "capabilities")
    return {
      ...JSON.parse(
        fs.readFileSync(
          new URL("../assets/capabilities.json", import.meta.url),
        ),
      ),
      version: VERSION,
    };
  if (q.action === "screenshot.annotate") return annotate(q);
  need(workspace, "WORKSPACE_REQUIRED", "Select a workspace.");
  const rt = new Runtime(workspace);
  if (q.action?.startsWith("secret.")) {
    rt.store.ready();
    rt.maintainer(q);
    const vault = new Vault(workspace);
    if (q.action === "secret.put") {
      need(
        q.scope?.workspace_id === rt.store.read("workspace.json").data.id,
        "CREDENTIAL_SCOPE",
        "Credential belongs to another workspace.",
      );
      return vault.put(q);
    }
    if (q.action === "secret.list")
      return {
        items: vault
          .list()
          .filter(
            (x) =>
              x.scope.workspace_id === rt.store.read("workspace.json").data.id,
          ),
        values_exposed: false,
      };
    if (q.action === "secret.status") {
      const status = vault.status(q.ref);
      need(
        !status.configured ||
          status.scope.workspace_id === rt.store.read("workspace.json").data.id,
        "CREDENTIAL_SCOPE",
        "Credential belongs to another workspace.",
      );
      return status;
    }
    throw new Fault(
      "UNKNOWN_ACTION",
      "Secret values are not exposed by the CLI.",
    );
  }
  const publicRequest = { ...q };
  if (q.action === "action.record") delete publicRequest.tool_result;
  rejectPlainSecrets(publicRequest);
  if (q.action === "bug.draft") {
    rt.store.ready(true);
    return bugDraft(rt, q);
  }
  if (MODULE_ACTIONS.has(q.action)) return moduleAction(rt, q);
  if (CONTEXT_ACTIONS.has(q.action)) return contextAction(rt, q);
  if (ACTIONS.has(q.action)) return actionCommand(rt, q);
  if (q.action === "http.execute") return httpExecute(rt, q);
  if (q.action?.startsWith("backup.")) {
    const b = await import("./lib/archive.mjs");
    if (q.action === "backup.create") return b.createBackup(workspace, q);
    if (q.action === "backup.verify") {
      const { manifest: m } = b.verifyBackup(q.archive);
      return {
        verified: true,
        files: m.entries.length,
        backup_time: m.created_at,
        complete_for_registered_snapshots: m.complete_for_registered_snapshots,
        exclusions: m.exclusions,
      };
    }
    if (q.action === "backup.restore")
      return b.restoreBackup(q.archive, q.destination);
  }
  return rt.dispatch(q);
}
async function main() {
  let workspace, requestFile, mode;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace") workspace = args[++i];
    else if (args[i] === "--request") requestFile = args[++i];
    else if (["--capabilities", "--version", "--help"].includes(args[i]))
      mode = args[i];
    else throw new Fault("INVALID_INPUT", "Unknown argument.");
  }
  if (mode === "--version") {
    console.log(VERSION);
    return;
  }
  if (mode === "--help") {
    console.log(
      "node scripts/qa.mjs --workspace PATH [--request FILE]\nOne JSON request on stdin. --capabilities and --version need no workspace.",
    );
    return;
  }
  let q;
  if (mode === "--capabilities") q = { action: "capabilities" };
  else {
    const input = requestFile
      ? fs.readFileSync(requestFile)
      : await new Promise((resolve, reject) => {
          const chunks = [];
          let n = 0;
          process.stdin.on("data", (b) => {
            n += b.length;
            if (n > 1024 * 1024) {
              reject(new Fault("INVALID_INPUT", "Request exceeds 1 MiB."));
              process.stdin.destroy();
            } else chunks.push(b);
          });
          process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
        });
    need(
      input.length <= 1024 * 1024,
      "INVALID_INPUT",
      "Request exceeds 1 MiB.",
    );
    try {
      q = JSON.parse(input);
    } catch {
      throw new Fault("INVALID_JSON", "Input is not valid JSON.");
    }
  }
  const result = await execute(workspace, q);
  console.log(JSON.stringify({ ok: true, action: q.action, result }));
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
)
  main().catch((e) => {
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code: e instanceof Fault ? e.code : "IO_ERROR",
          message:
            e instanceof Fault
              ? e.message
              : "Local operation failed. Inspect saved state before retry.",
          details: e instanceof Fault ? e.details : {},
        },
      }),
    );
    process.exitCode = e instanceof Fault ? 2 : 3;
  });
