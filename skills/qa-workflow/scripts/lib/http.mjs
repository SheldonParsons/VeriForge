import fs from "node:fs";
import { need, object, text, sha, encoded, now, Fault } from "./store.mjs";
import { Vault, redact, rejectPlainSecrets } from "./vault.mjs";
import {
  actionCommand,
  actionRef,
  requireAction,
  saveEvidence,
} from "./actions.mjs";

export function at(value, p) {
  if (!p) return value;
  let x = value;
  for (const k of p.split(".")) {
    need(
      !["__proto__", "prototype", "constructor"].includes(k),
      "INVALID_PATH",
      "Unsafe assertion path.",
    );
    x = x?.[k];
  }
  return x;
}
export function assertions(actual, checks = []) {
  need(
    Array.isArray(checks) && checks.length <= 100,
    "INVALID_INPUT",
    "Invalid checks.",
  );
  return checks.map((c) => {
    need(
      object(c) && typeof c.path === "string",
      "INVALID_INPUT",
      "Assertion path required.",
    );
    const value = at(actual, c.path);
    let pass;
    if (Object.hasOwn(c, "equals"))
      pass = encoded(value ?? null).equals(encoded(c.equals));
    else if (Object.hasOwn(c, "exists"))
      pass = (value !== undefined && value !== null) === c.exists;
    else if (Object.hasOwn(c, "includes"))
      pass = typeof value === "string" && value.includes(c.includes);
    else
      throw new Fault("INVALID_ASSERTION", "Use equals, exists or includes.");
    return { path: c.path, passed: pass };
  });
}
export function requestURL(raw, origins) {
  const u = new URL(raw);
  need(
    ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
    "INVALID_URL",
    "HTTP/HTTPS URL without userinfo required.",
  );
  need(
    Array.isArray(origins) && origins.includes(u.origin),
    "ORIGIN_NOT_ALLOWED",
    "Target origin is outside the configured project scope.",
  );
  for (const key of u.searchParams.keys())
    need(
      !/token|password|secret|api.?key/i.test(key),
      "SECRET_IN_URL",
      "Use a credential binding instead of URL secrets.",
    );
  return u;
}
export function validateRequest(request, origins) {
  requestURL(request.url, origins);
  const method = (request.method ?? "GET").toUpperCase();
  need(
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      method,
    ),
    "INVALID_INPUT",
    "Unsupported HTTP method.",
  );
  need(
    !(["GET", "HEAD"].includes(method) && request.body !== undefined),
    "INVALID_INPUT",
    "This method cannot carry a body.",
  );
  const timeout = request.timeout_ms ?? 15000,
    max = request.max_response_bytes ?? 2097152;
  need(
    Number.isInteger(timeout) && timeout >= 100 && timeout <= 60000,
    "INVALID_INPUT",
    "Invalid timeout.",
  );
  need(
    Number.isInteger(max) && max > 0 && max <= 16777216,
    "INVALID_INPUT",
    "Invalid response bound.",
  );
  assertions({}, request.expect ?? []);
  rejectPlainSecrets(request);
  return method;
}
export async function fetchObserved(
  request,
  { origins, credential, known = [] } = {},
) {
  validateRequest(request, origins);
  const url = requestURL(request.url, origins),
    method = (request.method ?? "GET").toUpperCase();
  need(
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      method,
    ),
    "INVALID_INPUT",
    "Unsupported HTTP method.",
  );
  rejectPlainSecrets(request.headers ?? {});
  const headers = { ...(request.headers ?? {}) };
  if (credential) {
    const strategy = request.auth?.strategy ?? "bearer",
      v = credential.value;
    if (strategy === "basic") {
      need(
        v.username && v.password,
        "CREDENTIAL_FIELDS",
        "Basic credentials are incomplete.",
      );
      headers.Authorization =
        "Basic " +
        Buffer.from(`${v.username}:${v.password}`).toString("base64");
    } else {
      need(v.token, "CREDENTIAL_FIELDS", "Token is missing.");
      if (strategy === "token") headers.Token = v.token;
      else if (strategy === "bearer")
        headers.Authorization = `Bearer ${v.token}`;
      else
        throw new Fault("INVALID_AUTH", "Unsupported authentication strategy.");
    }
  }
  let body;
  if (request.body !== undefined) {
    body =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
    headers["Content-Type"] ??=
      typeof request.body === "string" ? "text/plain" : "application/json";
  }
  need(
    !(["GET", "HEAD"].includes(method) && body !== undefined),
    "INVALID_INPUT",
    "This method cannot carry a body.",
  );
  const timeout = request.timeout_ms ?? 15000;
  need(
    Number.isInteger(timeout) && timeout >= 100 && timeout <= 60000,
    "INVALID_INPUT",
    "Timeout must be 100–60000 ms.",
  );
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
    });
  } catch {
    throw new Fault(
      "TRANSPORT_UNKNOWN",
      "Request outcome is unknown; reconcile before replay.",
    );
  }
  const max = request.max_response_bytes ?? 2 * 1024 * 1024;
  need(
    Number.isInteger(max) && max > 0 && max <= 16 * 1024 * 1024,
    "INVALID_INPUT",
    "Invalid response bound.",
  );
  const chunks = [];
  let size = 0,
    truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > max) {
        chunks.push(value.slice(0, Math.max(0, max - size)));
        size = max;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  }
  const bytes = Buffer.concat(chunks.map((x) => Buffer.from(x))),
    raw = bytes.toString("utf8");
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const actual = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
    truncated,
    bytes: size,
    duration_ms: Date.now() - started,
  };
  return { actual, public: redact(actual, known), body_sha256: sha(bytes) };
}
export async function httpExecute(rt, q) {
  need(
    q.authorized === true,
    "AUTHORIZATION_REQUIRED",
    "This action requires an authorized network task.",
  );
  let state = rt.store.read(actionRef(q));
  need(
    state.data.provider === "http",
    "INVALID_PROVIDER",
    "Not an HTTP action.",
  );
  const task = rt.task(q),
    project = rt.store.read(`projects/${q.project}/project.json`),
    origins = project.data.integrations?.http?.allowed_origins;
  const request = state.data.payload;
  const method = validateRequest(request, origins);
  need(
    state.data.effect === "write" ||
      ["GET", "HEAD", "OPTIONS"].includes(method),
    "EFFECT_MISMATCH",
    "Mutating methods require a write action.",
  );
  if (request.readback) {
    const rb = request.readback;
    const target = new URL(rb.url, new URL(request.url).origin);
    need(
      target.origin === new URL(request.url).origin,
      "ORIGIN_NOT_ALLOWED",
      "Readback must remain on the same origin.",
    );
    need(
      !rb.method || rb.method === "GET",
      "INVALID_INPUT",
      "Readback must be GET.",
    );
    validateRequest({ ...rb, url: target.href }, origins);
  }
  rejectPlainSecrets(request);
  const context = task.r.data.context,
    scope = {
      workspace_id: rt.store.read("workspace.json").data.id,
      project: q.project,
      system: q.system ?? context.systems?.[0]?.system,
      environment: context.environment,
      service: "http",
      ...(q.role ? { role: q.role } : {}),
    };
  need(
    !q.system ||
      context.systems?.some(
        (x) => x.project === q.project && x.system === q.system,
      ),
    "CREDENTIAL_SCOPE",
    "System is outside the task context.",
  );
  need(
    !q.role || context.roles?.includes(q.role),
    "CREDENTIAL_SCOPE",
    "Role is outside the task context.",
  );
  let credential,
    known = [];
  if (request.credential_ref) {
    credential = new Vault(rt.store.root).resolve(
      request.credential_ref,
      scope,
    );
    known = Object.values(credential.value);
  }
  await actionCommand(rt, {
    ...q,
    action: "action.dispatch",
    expected_revision: q.expected_revision,
  });
  state = rt.store.read(actionRef(q));
  try {
    const observed = await fetchObserved(request, {
        origins,
        credential,
        known,
      }),
      checks = assertions(observed.actual, request.expect ?? []);
    let readback = null;
    if (request.readback) {
      const rb = { ...request.readback };
      rb.url = String(rb.url).replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, p) => {
        const value = at(observed.actual, p);
        need(
          ["string", "number"].includes(typeof value),
          "READBACK_BINDING",
          "Readback target missing.",
        );
        return encodeURIComponent(value);
      });
      rb.url = new URL(rb.url, new URL(request.url).origin).href;
      need(
        new URL(rb.url).origin === new URL(request.url).origin,
        "ORIGIN_NOT_ALLOWED",
        "Readback must remain on the same origin.",
      );
      need(
        !rb.method || rb.method === "GET",
        "INVALID_INPUT",
        "Readback must be GET.",
      );
      readback = await fetchObserved(
        { ...rb, auth: request.auth },
        { origins, credential, known },
      );
      checks.push(
        ...assertions(readback.actual, rb.expect ?? []).map((x) => ({
          ...x,
          readback: true,
        })),
      );
    }
    const passed =
      checks.length > 0 &&
      checks.every((x) => x.passed) &&
      !observed.actual.truncated &&
      (!readback || !readback.actual.truncated);
    const verified =
      state.data.effect !== "write" ||
      (!!readback &&
        passed &&
        request.readback.expect?.some((c) => c.path.startsWith("body.")));
    return await rt.store.locked(() => {
      const current = rt.store.read(actionRef(q));
      const evidence = saveEvidence(rt, q, "http-response", {
        request: redact(request, known),
        response: observed.public,
        body_sha256: observed.body_sha256,
        checks,
        readback: readback?.public ?? null,
      });
      let raw_ref = null;
      if (
        JSON.stringify(observed.actual) !== JSON.stringify(observed.public) &&
        process.env.VERIFORGE_VAULT_KEY
      ) {
        raw_ref = `evidence:${scope.workspace_id}:${q.operation}`;
        const vault = new Vault(rt.store.root),
          status = vault.status(raw_ref);
        vault.put({
          ref: raw_ref,
          scope: {
            ...scope,
            system: scope.system ?? "api",
            environment: scope.environment ?? "unspecified",
            service: "evidence",
          },
          value: { response: JSON.stringify(observed.actual) },
          expected_revision: status.revision ?? 0,
        });
      }
      current.data = {
        ...current.data,
        status: verified ? "completed" : "unknown",
        effect_result:
          state.data.effect === "write"
            ? verified
              ? "applied"
              : "unknown"
            : "not_applicable",
        result: {
          response: observed.public,
          checks,
          assertions_passed: passed,
          raw_private_ref: raw_ref,
          capture_complete: !observed.actual.truncated,
          redacted_fields_present:
            JSON.stringify(observed.actual) !== JSON.stringify(observed.public),
          raw_capture_saved: !!raw_ref,
        },
        receipt_artifacts: [evidence],
        completed_at: now(),
      };
      const r = rt.store.write(actionRef(q), current.data, current.revision);
      return {
        path: actionRef(q),
        revision: r.revision,
        status: r.data.status,
        result: r.data.result,
        evidence,
        external_action_executed: true,
        business_verdict:
          state.data.effect === "write" && !verified
            ? "needs_verification"
            : checks.length
              ? passed
                ? "passed"
                : "failed"
              : "not_evaluated",
      };
    });
  } catch (e) {
    await rt.store.locked(() => {
      const r = rt.store.read(actionRef(q));
      r.data = {
        ...r.data,
        status: "unknown",
        effect_result:
          state.data.effect === "write" ? "unknown" : "not_applicable",
        last_error: e instanceof Fault ? e.code : "TRANSPORT_UNKNOWN",
        completed_at: now(),
      };
      rt.store.write(actionRef(q), r.data, r.revision);
    });
    throw new Fault(
      "ACTION_UNKNOWN",
      "Action result needs reconciliation; it will not be automatically replayed.",
    );
  }
}
