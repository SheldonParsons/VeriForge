import { need, object, text, slug, receipt } from "./store.mjs";
import { actionCommand } from "./actions.mjs";
import { rejectPlainSecrets } from "./vault.mjs";
export const MODULE_ACTIONS = new Set([
  "ui.module.register",
  "ui.module.read",
  "ui.plan",
]);
const moduleRef = (q) =>
  `projects/${slug(q.project)}/ui/${slug(q.module)}.json`;
function substitute(v, params) {
  if (typeof v === "string") {
    const m = v.match(/^\$\{([a-zA-Z0-9_]+)\}$/);
    if (m) {
      need(
        Object.hasOwn(params, m[1]),
        "MISSING_PARAMETER",
        "Missing UI module parameter.",
      );
      return params[m[1]];
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, params));
  if (object(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, substitute(x, params)]),
    );
  return v;
}
export async function moduleAction(rt, q) {
  rt.store.ready();
  if (q.action === "ui.module.read") return rt.store.read(moduleRef(q));
  if (q.action === "ui.module.register")
    return rt.store.locked(() => {
      rt.scoped(q);
      const definition = q.definition;
      need(
        object(definition) &&
          object(definition.scope) &&
          Array.isArray(definition.steps) &&
          definition.steps.length,
        "INVALID_MODULE",
        "Scoped steps required.",
      );
      const scope = definition.scope;
      need(
        scope.project === q.project &&
          scope.environment &&
          scope.role &&
          scope.system,
        "MODULE_SCOPE",
        "Project, system, environment and role are required.",
      );
      rt.systems([{ project: q.project, system: scope.system }]);
      need(
        ["candidate", "verified", "stale"].includes(definition.status),
        "INVALID_MODULE",
        "Invalid module state.",
      );
      need(
        definition.headless !== false,
        "VISIBLE_NOT_DEFAULT",
        "Reusable modules default to headless.",
      );
      for (const step of definition.steps) {
        need(
          step.tool &&
            object(step.arguments) &&
            ["read", "write"].includes(step.effect),
          "INVALID_MODULE",
          "Each step needs an observed host tool, arguments and effect.",
        );
        text(step.check, "check");
      }
      rejectPlainSecrets(definition);
      const proof = rt.pins(rt.req(q).prefix, q.evidence ?? []);
      need(
        definition.status !== "verified" || proof.length,
        "EVIDENCE_REQUIRED",
        "Verified modules need real observed evidence.",
      );
      const ref = moduleRef(q);
      return receipt(
        ref,
        rt.store.write(
          ref,
          {
            kind: "ui_module",
            module: q.module,
            definition,
            evidence: proof,
            source_requirement: q.requirement,
            basis: text(q.basis, "basis"),
          },
          q.expected_revision,
        ),
      );
    });
  const task = rt.task(q),
    module = rt.store.read(moduleRef(q)),
    d = module.data.definition,
    c = task.r.data.context;
  need(
    d.status === "verified",
    "MODULE_UNVERIFIED",
    "Capture the real page before reusing this module.",
  );
  need(
    d.scope.project === q.project &&
      c.environment === d.scope.environment &&
      c.roles?.includes(d.scope.role) &&
      c.systems?.some(
        (x) => x.project === q.project && x.system === d.scope.system,
      ),
    "MODULE_SCOPE",
    "Reuse requires the same verified project, system, environment and role.",
  );
  need(
    q.page_verified === true && q.page_evidence,
    "PAGE_CHECK_REQUIRED",
    "Verify the current page identity before planning.",
  );
  rt.artifact(task.prefix, q.page_evidence);
  const steps = substitute(d.steps, q.parameters ?? {});
  rejectPlainSecrets(steps);
  return actionCommand(rt, {
    ...q,
    action: "action.prepare",
    provider: "ui",
    effect: steps.some((x) => x.effect === "write") ? "write" : "read",
    resource:
      q.resource ??
      `ui:${q.project}:${d.scope.system}:${d.scope.environment}:${d.scope.role}`,
    payload: {
      headless: q.visible === true ? false : true,
      steps,
      module: q.module,
      visible_basis:
        q.visible === true ? text(q.visible_basis, "visible_basis") : null,
      stop_on_unexpected_page: true,
      case_assertions_separate: true,
    },
    binding_pin: {
      ref: moduleRef(q),
      revision: module.revision,
      sha256: module.sha256,
    },
  });
}
