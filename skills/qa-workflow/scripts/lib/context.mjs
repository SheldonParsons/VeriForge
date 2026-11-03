import {
  need,
  object,
  text,
  slug,
  receipt,
  encoded,
  sha,
  now,
} from "./store.mjs";
import { page } from "./runtime.mjs";
import { rejectPlainSecrets } from "./vault.mjs";

const providers = ["asynctest-kb", "nexofolio", "user", "page"];
export const CONTEXT_ACTIONS = new Set([
  "project.configure",
  "context.plan",
  "context.record",
  "context.read",
  "context.brief",
]);
export async function contextAction(rt, q) {
  if (["context.plan", "context.read", "context.brief"].includes(q.action)) {
    rt.store.ready();
    return local(rt, q);
  }
  return rt.store.locked(() => {
    rt.store.ready();
    rt.store.requireV3();
    return local(rt, q);
  });
}
function local(rt, q) {
  const projectRef = `projects/${slug(q.project)}/project.json`,
    project = rt.store.read(projectRef);
  if (q.action === "project.configure") {
    rt.coordinator(q, project);
    need(
      object(q.integrations) &&
        Object.keys(q.integrations).every((k) =>
          [
            "asynctest-kb",
            "nexofolio",
            "http",
            "zentao",
            "mind",
            "browser",
          ].includes(k),
        ),
      "INVALID_INPUT",
      "Unsupported integration.",
    );
    rejectPlainSecrets(q.integrations);
    for (const p of Object.values(q.integrations)) {
      need(object(p), "INVALID_INPUT", "Integration config must be an object.");
      for (const url of p.allowed_origins ?? []) {
        const u = new URL(url);
        need(
          ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            u.origin === url,
          "INVALID_URL",
          "Use exact authorized origins.",
        );
      }
      if (p.base_url) {
        const u = new URL(p.base_url);
        need(
          ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash,
          "INVALID_URL",
          "Invalid service URL.",
        );
      }
    }
    project.data.integrations = {
      ...(project.data.integrations ?? {}),
      ...q.integrations,
    };
    return receipt(
      projectRef,
      rt.store.write(projectRef, project.data, q.expected_revision),
      { external_action_executed: false },
    );
  }
  const { prefix, r: req } = rt.req(q),
    config = project.data.integrations ?? {};
  if (q.action === "context.plan") {
    const stage = q.stage ?? "analysis";
    need(
      ["bootstrap", "analysis", "cases", "investigation", "retest"].includes(
        stage,
      ),
      "INVALID_INPUT",
      "Invalid retrieval stage.",
    );
    const question = text(q.question, "question", 1200),
      calls = [],
      missing = [];
    if (config["asynctest-kb"]?.project) {
      if (stage === "bootstrap")
        calls.push({
          provider: "asynctest-kb",
          tool: "get_knowledge_overview",
          arguments: { project: config["asynctest-kb"].project },
          purpose:
            "Identify relevant business topics; follow pagination when needed.",
        });
      calls.push({
        provider: "asynctest-kb",
        tool: "search_knowledge",
        arguments: {
          projects: [config["asynctest-kb"].project],
          query: question,
        },
        purpose:
          "Read historical business concepts, rules and prior changes before asking the user.",
      });
    } else
      missing.push({
        provider: "asynctest-kb",
        need: "project mapping",
        fallback:
          "Use provided local rules and state the missing historical source.",
      });
    if (config.nexofolio) {
      calls.push({
        provider: "nexofolio",
        tool: config.nexofolio.project_id
          ? "list_project_environments"
          : "list_projects",
        arguments: config.nexofolio.project_id
          ? { project_id: config.nexofolio.project_id, offset: 0, limit: 20 }
          : { offset: 0, limit: 20 },
        purpose:
          "Find actual project/environment identities. Do not guess IDs.",
      });
    } else if (q.interface_context === true)
      missing.push({
        provider: "nexofolio",
        need: "project/environment mapping",
        fallback:
          "Use supplied API documentation and mark unverified interface details.",
      });
    if (
      config.nexofolio?.project_id &&
      config.nexofolio.environment_id &&
      q.interface_query
    ) {
      calls.push({
        provider: "nexofolio",
        tool: "search_interfaces",
        arguments: {
          project_id: config.nexofolio.project_id,
          environment_id: config.nexofolio.environment_id,
          query: text(q.interface_query, "interface_query", 1200),
          search_in: "interface",
          limit: 20,
        },
        purpose:
          "Read relevant interface contracts and provenance in the configured environment.",
      });
    }
    return {
      stage,
      question,
      project: q.project,
      requirement: q.requirement,
      read_only: true,
      external_action_executed: false,
      calls,
      missing,
      next: "Use host-native tools. Read relevant full rules/fields and provenance, then context.record the evidence. NexoFolio queries are knowledge reads, never business requests.",
      coverage: [
        "concepts",
        "roles",
        "states",
        "main_flow",
        "changed_rules",
        "unknowns",
      ],
      discovery_is_not_complete: true,
    };
  }
  if (q.action === "context.record") {
    rt.coordinator(q, req);
    need(!req.data.archived, "ARCHIVED", "Reopen first.");
    const entries = q.entries;
    need(
      Array.isArray(entries) && entries.length && entries.length <= 50,
      "INVALID_INPUT",
      "Provide 1–50 bounded source entries.",
    );
    const normalized = entries.map((e) => {
      need(
        object(e) &&
          providers.includes(e.provider) &&
          ["concept", "rule", "interface", "observation", "inference"].includes(
            e.kind,
          ) &&
          ["confirmed", "candidate", "unknown", "superseded"].includes(
            e.status,
          ),
        "INVALID_INPUT",
        "Invalid context entry.",
      );
      need(
        object(e.scope) && e.scope.project === q.project,
        "CONTEXT_SCOPE",
        "Context belongs to another project.",
      );
      rejectPlainSecrets(e);
      return {
        ...e,
        reference: text(e.reference, "reference", 2048),
        summary: text(e.summary, "summary", 4000),
        evidence: rt.pins(prefix, [e.artifact]),
        observed_at: now(),
      };
    });
    const ref = `${prefix}/context/${slug(q.context)}.json`,
      data = {
        kind: "knowledge_context",
        project: q.project,
        requirement: q.requirement,
        context: q.context,
        question: text(q.question, "question", 1200),
        entries: normalized,
      };
    return receipt(ref, rt.store.write(ref, data, q.expected_revision), {
      external_action_executed: false,
      source_truth_not_inferred: true,
    });
  }
  const entries = rt.store
    .refs(`${prefix}/context/*.json`)
    .flatMap((ref) => {
      const r = rt.store.read(ref);
      return r.data.entries.map((e) => ({
        ...e,
        record: ref,
        record_revision: r.revision,
      }));
    })
    .filter(
      (e) =>
        (q.include_superseded || e.status !== "superseded") &&
        (!q.environment || e.scope.environment === q.environment) &&
        (!q.query ||
          e.summary.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())),
    );
  const claims = new Map(),
    conflicts = [];
  for (const e of entries) {
    if (!e.claim_key || e.status !== "confirmed") continue;
    const key = sha(encoded({ claim: e.claim_key, scope: e.scope })),
      value = sha(encoded(e.claim_value ?? e.summary));
    const prior = claims.get(key);
    if (prior && prior.value !== value)
      conflicts.push({
        claim_key: e.claim_key,
        sources: [prior.entry.reference, e.reference],
        action:
          "Check scope/version and confirm the relevant rule; do not pick by timestamp alone.",
      });
    else claims.set(key, { value, entry: e });
  }
  const selection = page(
    entries.map((e) => ({
      provider: e.provider,
      kind: e.kind,
      status: e.status,
      scope: e.scope,
      reference: e.reference,
      revision: e.revision ?? null,
      summary: e.summary.slice(0, 400),
      summary_truncated: e.summary.length > 400,
      record: e.record,
      record_revision: e.record_revision,
    })),
    q,
  );
  if (q.action === "context.brief")
    return {
      markdown: [
        "# Project context",
        "",
        ...selection.items.map(
          (e) =>
            `- **${e.kind} / ${e.status}** ${e.summary}${e.summary_truncated ? "…" : ""}\n  Source: ${e.reference}`,
        ),
        "",
        "## Questions and conflicts",
        ...conflicts.map((c) => `- ${c.claim_key}: ${c.action}`),
        "",
        `Listed ${selection.items.length}/${selection.total} source entries. Missing evidence remains unknown; this is not a complete requirement specification.`,
      ].join("\n"),
      ...selection,
      conflicts,
      complete_requirements: false,
    };
  return { ...selection, conflicts, complete_requirements: false };
}
