import fs from "node:fs";
import path from "node:path";
import {
  need,
  object,
  text,
  slug,
  receipt,
  encoded,
  sha,
  atomicBytes,
  now,
} from "./store.mjs";
import { rejectPlainSecrets, redact } from "./vault.mjs";

export const ACTIONS = new Set([
  "action.prepare",
  "action.dispatch",
  "action.continue",
  "action.record",
  "action.read",
  "binding.set",
  "binding.list",
  "mind.plan",
  "knowledge.write.plan",
]);
export const actionRef = (q) =>
  `projects/${slug(q.project)}/requirements/${slug(q.requirement)}/actions/${slug(q.operation)}.json`;
export function requireAction(rt, q, active = true) {
  rt.store.requireV3();
  const task = rt.task(q, active),
    ref = actionRef(q),
    r = rt.store.read(ref);
  need(r.data.task === q.task, "NOT_OWNER", "Action belongs to another task.");
  return { task, ref, r };
}
export function saveEvidence(rt, q, label, payload) {
  const prefix = rt.req(q).prefix,
    bytes = encoded(redact(payload)),
    digest = sha(bytes),
    id = `proof-${sha(q.operation + ":" + label + ":" + digest).slice(0, 32)}`,
    asset = `artifacts/${digest}/${label}.json`,
    ref = `${prefix}/artifacts/${id}.json`;
  if (!fs.existsSync(rt.store.path(asset)))
    atomicBytes(rt.store.path(asset), bytes, false);
  const old = rt.store.read(ref, true);
  if (!old)
    rt.store.write(
      ref,
      {
        kind: "artifact",
        artifact: id,
        path: asset,
        sha256: digest,
        bytes: bytes.length,
        source: "tool-receipt",
        captured_at: now(),
        purpose: label,
        sensitive: false,
      },
      0,
    );
  return id;
}
export async function actionCommand(rt, q) {
  if (["action.read", "binding.list"].includes(q.action)) {
    rt.store.ready();
    return local(rt, q);
  }
  return rt.store.locked(() => {
    rt.store.ready(
      [
        "action.prepare",
        "action.dispatch",
        "action.continue",
        "mind.plan",
        "knowledge.write.plan",
      ].includes(q.action),
    );
    return local(rt, q);
  });
}
function local(rt, q) {
  if (q.action === "action.read") {
    rt.req(q);
    return rt.store.read(actionRef(q));
  }
  if (q.action === "binding.set") {
    const { prefix } = rt.scoped(q);
    need(
      ["mind", "knowledge"].includes(q.carrier),
      "INVALID_INPUT",
      "Unsupported carrier.",
    );
    need(object(q.locator), "INVALID_INPUT", "Carrier locator required.");
    rejectPlainSecrets(q.locator);
    const artifact = rt.pins(prefix, [q.artifact])[0],
      ref = `${prefix}/bindings/${slug(q.binding)}.json`;
    return receipt(
      ref,
      rt.store.write(
        ref,
        {
          kind: "carrier_binding",
          project: q.project,
          requirement: q.requirement,
          binding: q.binding,
          carrier: q.carrier,
          case: q.case ? slug(q.case) : null,
          artifact,
          locator: q.locator,
          basis: text(q.basis, "basis"),
        },
        q.expected_revision,
      ),
    );
  }
  if (q.action === "binding.list") {
    const { prefix } = rt.req(q);
    return {
      items: rt.store.refs(`${prefix}/bindings/*.json`).map((ref) => {
        const r = rt.store.read(ref);
        return { path: ref, revision: r.revision, ...r.data };
      }),
    };
  }
  if (q.action === "mind.plan") {
    const task = rt.task(q),
      binding = rt.store.read(
        `${task.prefix}/bindings/${slug(q.binding)}.json`,
      );
    need(
      binding.data.carrier === "mind" &&
        binding.data.case &&
        task.r.data.cases.includes(binding.data.case),
      "BINDING_SCOPE",
      "Binding is outside this task.",
    );
    const pin = rt.artifact(task.prefix, binding.data.artifact.artifact);
    need(
      pin.data.sha256 === binding.data.artifact.sha256,
      "ARTIFACT_DRIFT",
      "Case source changed.",
    );
    const result = rt.store.read(
      `${task.prefix}/runs/${task.r.data.run}/${binding.data.case}.json`,
    );
    need(
      result.data.task === q.task,
      "NOT_OWNER",
      "Scenario result belongs to another task.",
    );
    need(
      ["passed", "failed"].includes(result.data.status),
      "RESULT_NOT_TERMINAL",
      "Only complete pass/fail results have default markers. Other states retain notes.",
    );
    const locator = binding.data.locator;
    need(
      locator.node_id &&
        q.window_key &&
        typeof q.document_revision === "string" &&
        q.document_revision,
      "INVALID_INPUT",
      "Use a fresh window identity and document revision.",
    );
    const add = result.data.status === "passed" ? "100" : "error",
      remove = add === "100" ? "error" : "100";
    return local(rt, {
      ...q,
      action: "action.prepare",
      provider: "mcp",
      effect: "write",
      resource: `mind:${locator.document_ref}`,
      authorization_basis: text(q.authorization_basis, "authorization_basis"),
      payload: {
        tool: "mind_apply_node_operations",
        provider: "asynctest-mind",
        arguments: {
          windowKey: q.window_key,
          expectedRevision: q.document_revision,
          operations: [
            {
              type: "remove_marker",
              nodeId: locator.node_id,
              markerKey: remove,
            },
            { type: "add_marker", nodeId: locator.node_id, markerKey: add },
          ],
        },
      },
      binding_pin: {
        ref: `${task.prefix}/bindings/${q.binding}.json`,
        revision: binding.revision,
        sha256: binding.sha256,
      },
      result_pin: {
        ref: `${task.prefix}/runs/${task.r.data.run}/${binding.data.case}.json`,
        revision: result.revision,
        sha256: result.sha256,
      },
      expected_readback: {
        window_key: q.window_key,
        node_id: locator.node_id,
        marker: add,
        document_ref: locator.document_ref,
      },
      requires_save: true,
    });
  }
  if (q.action === "knowledge.write.plan") {
    const { prefix } = rt.task(q);
    need(
      ["add_knowledge", "edit_knowledge", "delete_knowledge"].includes(q.tool),
      "INVALID_INPUT",
      "Unsupported knowledge write tool.",
    );
    need(object(q.arguments), "INVALID_INPUT", "Arguments required.");
    rejectPlainSecrets(q.arguments);
    if (q.arguments.interaction_response) {
      need(
        false,
        "CONTINUATION_REQUIRED",
        "Use action.continue with the original pending action.",
      );
      need(
        q.user_confirmation && q.preview_artifact,
        "CONFIRMATION_REQUIRED",
        "A concrete preview and the user response are required.",
      );
      rt.artifact(prefix, q.preview_artifact);
      need(
        !q.arguments.project &&
          !q.arguments.items &&
          !q.arguments.changes &&
          !q.arguments.replacement &&
          !q.arguments.targets,
        "INVALID_INPUT",
        "Do not mix preview response and new input.",
      );
    } else {
      const facts = rt.workflow_read({ ...q, include_details: true }).facts;
      need(
        q.early_write_basis ||
          (facts.release?.status === "released" &&
            facts.stability?.status === "confirmed"),
        "KNOWLEDGE_NOT_STABLE",
        "Wait for release and stability, or record the user’s specific early-write instruction.",
      );
    }
    return local(rt, {
      ...q,
      action: "action.prepare",
      provider: "mcp",
      effect: "write",
      resource: `knowledge:${q.arguments.project ?? q.project}`,
      payload: {
        provider: "asynctest-kb",
        tool: q.tool,
        arguments: q.arguments,
      },
      confirmation_basis: q.user_confirmation ?? q.early_write_basis ?? null,
    });
  }
  if (q.action === "action.prepare") {
    rt.store.requireV3();
    const task = rt.task(q);
    need(
      ["mcp", "http", "zentao", "ui"].includes(q.provider) &&
        ["read", "draft", "write"].includes(q.effect),
      "INVALID_INPUT",
      "Invalid action provider/effect.",
    );
    need(object(q.payload), "INVALID_INPUT", "Action payload required.");
    rejectPlainSecrets(q.payload);
    if (q.case)
      need(
        task.r.data.cases.includes(q.case),
        "CASE_SCOPE",
        "Scenario outside task.",
      );
    const resource = text(q.resource, "resource", 500);
    if (q.effect !== "read")
      need(
        !rt.blockers(q, resource).operations.length,
        "PENDING_WORK",
        "Reconcile the earlier write first.",
      );
    rt.resource_acquire({ ...q, resource });
    const held = rt.store.read(rt.resourceRef(resource)),
      project = rt.store.read(`projects/${q.project}/project.json`);
    const ref = actionRef(q),
      data = {
        kind: "action",
        ...rt.key(q),
        operation: q.operation,
        case: q.case ?? null,
        provider: q.provider,
        effect: q.effect,
        status: "prepared",
        resource,
        resource_revision: held.revision,
        payload: q.payload,
        payload_sha256: sha(encoded(q.payload)),
        project_revision: project.revision,
        authorization_basis: text(q.authorization_basis, "authorization_basis"),
        created_at: now(),
        attempts: 0,
        binding_pin: q.binding_pin ?? null,
        result_pin: q.result_pin ?? null,
        expected_readback: q.expected_readback ?? null,
        requires_save: q.requires_save ?? false,
        confirmation_basis: q.confirmation_basis ?? null,
      };
    return receipt(ref, rt.store.write(ref, data, 0), {
      external_action_executed: false,
    });
  }
  if (q.action === "action.dispatch") {
    const { ref, r } = requireAction(rt, q);
    need(
      r.data.status === "prepared",
      "ACTION_STATE",
      "Do not replay a dispatched action.",
    );
    need(
      !rt.blockers(q, r.data.resource).operations.length,
      "PENDING_WORK",
      "Resolve the previous action before dispatch.",
    );
    const held = rt.store.read(rt.resourceRef(r.data.resource));
    need(
      held.revision === r.data.resource_revision &&
        held.data.holder?.owner === q.actor &&
        held.data.holder?.task === q.task,
      "RESOURCE_CHANGED",
      "Resource changed.",
    );
    need(
      rt.store.read(`projects/${q.project}/project.json`).revision ===
        r.data.project_revision,
      "CONFIG_CHANGED",
      "Project configuration changed.",
    );
    for (const pin of [r.data.binding_pin, r.data.result_pin].filter(Boolean)) {
      const current = rt.store.read(pin.ref);
      need(
        current.revision === pin.revision && current.sha256 === pin.sha256,
        "SOURCE_CHANGED",
        "Binding or result changed.",
      );
    }
    r.data = {
      ...r.data,
      status: "dispatched",
      attempts: r.data.attempts + 1,
      dispatched_at: now(),
    };
    const result = receipt(
      ref,
      rt.store.write(ref, r.data, q.expected_revision),
      { external_action_executed: false, host_call: r.data.payload },
    );
    return result;
  }
  if (q.action === "action.continue") {
    const { ref, r } = requireAction(rt, q);
    need(
      r.data.status === "waiting_user" && r.data.pending_reference,
      "ACTION_STATE",
      "Only a saved pending interaction can continue.",
    );
    need(
      q.pending_reference === r.data.pending_reference,
      "PENDING_MISMATCH",
      "Continue the exact saved interaction.",
    );
    need(
      object(q.arguments) && q.arguments.interaction_response,
      "INVALID_INPUT",
      "Use the provider interaction_response only.",
    );
    rejectPlainSecrets(q.arguments);
    need(
      Object.keys(q.arguments).length === 1,
      "INVALID_INPUT",
      "Do not combine confirmation with new content.",
    );
    need(
      q.arguments.interaction_response.pending_id === r.data.pending_reference,
      "PENDING_MISMATCH",
      "Provider response must name the original pending interaction.",
    );
    need(
      ["apply", "cancel", "submit", "preserve"].includes(
        q.arguments.interaction_response.action,
      ),
      "INVALID_INPUT",
      "Use a valid provider confirmation action.",
    );
    rt.artifact(rt.req(q).prefix, q.preview_artifact);
    r.data = {
      ...r.data,
      status: "prepared",
      payload: { ...r.data.payload, arguments: q.arguments },
      confirmation_basis: text(q.user_confirmation, "user_confirmation"),
      preview_artifact: q.preview_artifact,
      prior_pending_reference: r.data.pending_reference,
      pending_reference: null,
    };
    r.data.payload_sha256 = sha(encoded(r.data.payload));
    return receipt(ref, rt.store.write(ref, r.data, q.expected_revision), {
      external_action_executed: false,
    });
  }
  if (q.action === "action.record") {
    const { ref, r } = requireAction(rt, q, false);
    need(
      ["dispatched", "unknown", "waiting_user"].includes(r.data.status),
      "ACTION_STATE",
      "Action is not awaiting a receipt.",
    );
    need(
      [
        "completed",
        "failed",
        "blocked",
        "unknown",
        "waiting_user",
        "cancelled",
      ].includes(q.status),
      "INVALID_STATE",
      "Invalid action result.",
    );
    need(
      object(q.tool_result),
      "INVALID_INPUT",
      "Actual tool result is required.",
    );
    const proof = saveEvidence(rt, q, "tool-result", q.tool_result);
    const ids = [proof, ...(q.evidence ?? [])];
    rt.pins(rt.req(q).prefix, ids);
    if (r.data.effect === "write" && q.status === "completed")
      need(
        ["applied", "not_applied"].includes(q.effect_result) &&
          q.readback_artifact,
        "READBACK_REQUIRED",
        "Verify the actual write outcome.",
      );
    if (q.readback_artifact) rt.artifact(rt.req(q).prefix, q.readback_artifact);
    if (q.status === "completed" && r.data.requires_save) {
      need(
        q.save_verified === true &&
          q.marker_readback?.node_id === r.data.expected_readback.node_id &&
          q.marker_readback?.marker === r.data.expected_readback.marker,
        "CARRIER_READBACK",
        "Save and marker readback must match the target.",
      );
    }
    if (q.status === "waiting_user")
      need(
        q.pending_reference,
        "PENDING_REQUIRED",
        "Preserve the provider pending interaction identifier.",
      );
    if (
      r.data.effect === "write" &&
      ["failed", "blocked", "cancelled"].includes(q.status)
    )
      need(
        q.effect_result === "not_applied" && q.readback_artifact,
        "READBACK_REQUIRED",
        "Unknown write effects stay unknown until verified.",
      );
    r.data = {
      ...r.data,
      status: q.status,
      effect_result:
        q.effect_result ??
        (r.data.effect === "write" ? "unknown" : "not_applicable"),
      receipt_artifacts: ids,
      readback_artifact: q.readback_artifact ?? null,
      pending_reference: q.pending_reference ?? null,
      completed_at: now(),
      note: text(q.note, "note"),
    };
    return receipt(ref, rt.store.write(ref, r.data, q.expected_revision), {
      external_action_executed: false,
      business_verdict: "not_inferred",
    });
  }
}
