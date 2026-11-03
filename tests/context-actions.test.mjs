import test from "node:test";
import assert from "node:assert/strict";
import { fixture, error } from "./helpers.mjs";
const prepare = (f, extra = {}) =>
  f.call({
    action: "action.prepare",
    task: "task1",
    operation: "op1",
    provider: "mcp",
    effect: "write",
    resource: "knowledge:demo",
    authorization_basis: "User authorized synthetic test",
    payload: {
      provider: "example",
      tool: "write",
      arguments: { value: "fixture" },
    },
    ...extra,
  });
test("cold-start plan queries historical sources within configured projects", async (t) => {
  const f = await fixture(t);
  await f.call({
    action: "project.configure",
    expected_revision: 1,
    integrations: {
      "asynctest-kb": { project: "Example" },
      nexofolio: { project_id: "demo" },
    },
  });
  const p = await f.call({
    action: "context.plan",
    stage: "bootstrap",
    question: "申请与审批角色是什么",
  });
  assert.equal(p.external_action_executed, false);
  assert.equal(p.calls.length, 3);
  assert.deepEqual(p.calls[1].arguments.projects, ["Example"]);
});
test("missing knowledge sources expose a useful fallback", async (t) => {
  const f = await fixture(t);
  const p = await f.call({
    action: "context.plan",
    stage: "cases",
    question: "审批规则",
    interface_context: true,
  });
  assert.equal(p.missing.length, 2);
  assert.equal(p.calls.length, 0);
});
test("conflicting historical rules retain both sources and never pick newest", async (t) => {
  const f = await fixture(t);
  await f.evidence();
  await f.call({
    action: "context.record",
    context: "rules",
    question: "Limit",
    expected_revision: 0,
    entries: [10, 20].map((n, i) => ({
      provider: "asynctest-kb",
      kind: "rule",
      status: "confirmed",
      scope: { project: "demo", environment: "fixture" },
      reference: "source-" + i,
      summary: "Limit " + n,
      claim_key: "limit",
      claim_value: n,
      artifact: "proof",
    })),
  });
  const r = await f.call({ action: "context.read" });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.items.length, 2);
});
test("context evidence cannot be assigned to another project", async (t) => {
  const f = await fixture(t);
  await f.evidence();
  await assert.rejects(
    f.call({
      action: "context.record",
      context: "x",
      question: "Scope",
      expected_revision: 0,
      entries: [
        {
          provider: "user",
          kind: "rule",
          status: "confirmed",
          scope: { project: "other" },
          reference: "source",
          summary: "Rule",
          artifact: "proof",
        },
      ],
    }),
    error("CONTEXT_SCOPE"),
  );
});
test("action dispatch is persisted once, unknown results cannot replay", async (t) => {
  const f = await fixture(t);
  await f.task();
  await prepare(f);
  await f.call({
    action: "action.dispatch",
    task: "task1",
    operation: "op1",
    expected_revision: 1,
  });
  await assert.rejects(
    f.call({
      action: "action.dispatch",
      task: "task1",
      operation: "op1",
      expected_revision: 2,
    }),
    error("ACTION_STATE"),
  );
  await f.call({
    action: "action.record",
    task: "task1",
    operation: "op1",
    expected_revision: 2,
    status: "unknown",
    tool_result: { error: "timeout" },
    note: "Query remote before retry",
  });
  await assert.rejects(
    f.call({
      action: "resource.release",
      task: "task1",
      resource: "knowledge:demo",
      expected_revision: 1,
    }),
    error("PENDING_WORK"),
  );
});
test("failed write receipt without verified no-effect remains unresolved", async (t) => {
  const f = await fixture(t);
  await f.task();
  await prepare(f);
  await f.call({
    action: "action.dispatch",
    task: "task1",
    operation: "op1",
    expected_revision: 1,
  });
  await assert.rejects(
    f.call({
      action: "action.record",
      task: "task1",
      operation: "op1",
      expected_revision: 2,
      status: "failed",
      tool_result: { error: "network" },
      note: "Failed",
    }),
    error("READBACK_REQUIRED"),
  );
  assert.equal(
    (await f.call({ action: "action.read", operation: "op1" })).data.status,
    "dispatched",
  );
});
test("pending knowledge preview continues in same journal and cannot release early", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.evidence();
  await prepare(f);
  await f.call({
    action: "action.dispatch",
    task: "task1",
    operation: "op1",
    expected_revision: 1,
  });
  await f.call({
    action: "action.record",
    task: "task1",
    operation: "op1",
    expected_revision: 2,
    status: "waiting_user",
    pending_reference: "pending-1",
    tool_result: { preview: "fixture" },
    note: "Await concrete reply",
  });
  await assert.rejects(
    f.call({
      action: "resource.release",
      task: "task1",
      resource: "knowledge:demo",
      expected_revision: 1,
    }),
    error("PENDING_WORK"),
  );
  await f.call({
    action: "action.continue",
    task: "task1",
    operation: "op1",
    expected_revision: 3,
    pending_reference: "pending-1",
    preview_artifact: "proof",
    user_confirmation: "Proceed with shown preview",
    arguments: {
      interaction_response: { pending_id: "pending-1", action: "apply" },
    },
  });
  const r = await f.call({
    action: "action.dispatch",
    task: "task1",
    operation: "op1",
    expected_revision: 4,
  });
  assert.ok(r.host_call.arguments.interaction_response);
  await f.call({
    action: "action.record",
    task: "task1",
    operation: "op1",
    expected_revision: 5,
    status: "completed",
    effect_result: "applied",
    readback_artifact: "proof",
    tool_result: { id: "demo-1" },
    note: "Fixture readback",
  });
  assert.equal(
    (await f.call({ action: "action.read", operation: "op1" })).data.attempts,
    2,
  );
});
test("configuration drift blocks dispatch before external action", async (t) => {
  const f = await fixture(t);
  await f.task();
  await prepare(f);
  await f.call({
    action: "project.configure",
    expected_revision: 1,
    integrations: { http: { allowed_origins: ["https://example.test"] } },
  });
  await assert.rejects(
    f.call({
      action: "action.dispatch",
      task: "task1",
      operation: "op1",
      expected_revision: 1,
    }),
    error("CONFIG_CHANGED"),
  );
});
test("knowledge publication waits for stable release unless explicitly scoped earlier", async (t) => {
  const f = await fixture(t);
  await f.task();
  const q = {
    action: "knowledge.write.plan",
    task: "task1",
    operation: "op1",
    tool: "add_knowledge",
    arguments: { project: "Example", items: [{ text: "Synthetic rule" }] },
    authorization_basis: "Requested publication",
  };
  await assert.rejects(f.call(q), error("KNOWLEDGE_NOT_STABLE"));
  await f.call({
    ...q,
    early_write_basis: "User explicitly asked for this draft to be stored",
  });
});
test("Mind mapping pins case source and verifies saved marker", async (t) => {
  const f = await fixture(t);
  await f.task();
  await f.evidence();
  await f.call({
    action: "binding.set",
    binding: "mind-case",
    carrier: "mind",
    case: "case1",
    artifact: "proof",
    locator: { document_ref: "fixture.amind", node_id: "node1" },
    basis: "Observed node mapping",
    expected_revision: 0,
  });
  await f.call({
    action: "case.record",
    task: "task1",
    case: "case1",
    status: "passed",
    basis: "Fixture passed",
    evidence: ["proof"],
    expected_revision: 0,
  });
  await f.call({
    action: "mind.plan",
    task: "task1",
    operation: "mark1",
    binding: "mind-case",
    window_key: "fixture-window",
    document_revision: "5",
    authorization_basis: "User requested markers",
  });
  const r = await f.call({
    action: "action.dispatch",
    task: "task1",
    operation: "mark1",
    expected_revision: 1,
  });
  assert.equal(r.host_call.arguments.operations[1].markerKey, "100");
  await assert.rejects(
    f.call({
      action: "action.record",
      task: "task1",
      operation: "mark1",
      expected_revision: 2,
      status: "completed",
      effect_result: "applied",
      readback_artifact: "proof",
      tool_result: { ok: true },
      save_verified: false,
      note: "No save",
    }),
    error("CARRIER_READBACK"),
  );
});

test("NexoFolio targeted search preserves project and environment", async (t) => {
  const f = await fixture(t);
  await f.call({
    action: "project.configure",
    expected_revision: 1,
    integrations: {
      nexofolio: {
        project_id: "api-project",
        environment_id: "qa-environment",
      },
    },
  });
  const p = await f.call({
    action: "context.plan",
    question: "Approval fields",
    interface_query: "approval",
  });
  const call = p.calls.find((x) => x.tool === "search_interfaces");
  assert.equal(call.arguments.project_id, "api-project");
  assert.equal(call.arguments.environment_id, "qa-environment");
});
