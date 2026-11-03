import fs from "node:fs";
import sharp from "sharp";
import {
  need,
  text,
  slug,
  sha,
  encoded,
  receipt,
  atomicBytes,
} from "./store.mjs";
export async function bugDraft(rt, q) {
  return rt.store.locked(async () => {
    const task = rt.task(q);
    rt.store.requireV3();
    const b = q.bug;
    need(
      b && ["ui", "api"].includes(b.kind),
      "INVALID_BUG",
      "Specify UI or API defect.",
    );
    text(b.title, "title", 300);
    text(b.actual, "actual");
    text(b.expected, "expected");
    need(
      Array.isArray(b.steps) &&
        b.steps.length &&
        b.steps.every((x) => typeof x === "string" && x.trim()),
      "INVALID_BUG",
      "Reproducible numbered steps required.",
    );
    const evidence = rt.pins(task.prefix, b.evidence ?? []);
    need(evidence.length, "EVIDENCE_REQUIRED", "Defect evidence required.");
    const images = [];
    if (b.kind === "ui") {
      need(
        b.screenshots?.length,
        "SCREENSHOT_REQUIRED",
        "UI defects require an annotated real screenshot.",
      );
      for (const pair of b.screenshots) {
        const screenshot = rt.artifact(task.prefix, pair.image),
          manifest = rt.artifact(task.prefix, pair.manifest);
        const m = JSON.parse(
          fs.readFileSync(rt.store.path(manifest.data.path)),
        );
        const bytes = fs.readFileSync(rt.store.path(screenshot.data.path)),
          metadata = await sharp(bytes).metadata();
        need(
          m.kind === "annotated_screenshot" &&
            m.output_sha256 === sha(bytes) &&
            m.annotations?.length &&
            metadata.format === "png",
          "INVALID_SCREENSHOT",
          "Screenshot and annotation evidence must match.",
        );
        need(
          !m.synthetic || q.fixture_only === true,
          "SYNTHETIC_EVIDENCE",
          "Synthetic images cannot substantiate a real defect.",
        );
        images.push({
          artifact: pair.image,
          path: screenshot.data.path,
          sha256: screenshot.data.sha256,
          manifest: pair.manifest,
        });
      }
    }
    const severity = b.severity ?? 3,
      priority = b.priority ?? 3;
    need(
      [1, 2, 3, 4].includes(severity) && [1, 2, 3, 4].includes(priority),
      "INVALID_BUG",
      "Severity and priority must be 1–4.",
    );
    const id = slug(q.bug_id);
    need(
      id.length <= 48,
      "INVALID_ID",
      "BUG identifiers may have at most 48 characters.",
    );
    const folder = `${task.prefix}/bugs`,
      ref = `${folder}/${id}.json`;
    need(
      !rt.store.read(ref, true),
      "ALREADY_EXISTS",
      "Use the existing defect; do not duplicate it.",
    );
    const lines = [
      `# ${b.title}`,
      "",
      `- 环境：${task.r.data.context.environment ?? "待确认"}`,
      `- 项目：${q.project}`,
      `- 需求：${q.requirement}`,
      `- 严重程度：${severity}`,
      `- 优先级：${priority}`,
      ...Object.entries(b.fields ?? {}).map(([k, v]) => `- ${k}：${v}`),
      "",
      `账号：${b.account_ref ? "凭据引用 " + b.account_ref : "未使用账号或待确认"}`,
      "",
      "[步骤]",
      ...b.steps.map((s, i) => `${i + 1}、${s}`),
      "",
      "[结果]",
      b.actual,
      ...images.map((i) => `\n![已标注的问题截图](../../../../../${i.path})`),
      "",
      "[期望]",
      b.expected,
      "",
    ];
    const bytes = Buffer.from(lines.join("\n")),
      snapshot = `artifacts/${sha(bytes)}/${id}.md`;
    atomicBytes(rt.store.path(snapshot), bytes, false);
    atomicBytes(rt.store.path(`${folder}/${id}.md`), bytes, false);
    rt.store.write(
      task.prefix + "/artifacts/" + id + "-draft.json",
      {
        kind: "artifact",
        artifact: id + "-draft",
        path: snapshot,
        sha256: sha(bytes),
        bytes: bytes.length,
        source: "generated-bug-draft",
        purpose: "BUG draft",
        sensitive: false,
      },
      0,
    );
    const data = {
      kind: "bug",
      bug: id,
      project: q.project,
      requirement: q.requirement,
      task: q.task,
      title: b.title,
      status: "draft",
      severity,
      priority,
      evidence,
      images,
      fields: b.fields ?? {},
      account_ref: b.account_ref ?? null,
      fixture_only: q.fixture_only === true,
      snapshot,
      sha256: sha(bytes),
      remote: null,
    };
    return receipt(ref, rt.store.write(ref, data, 0), {
      markdown: `${folder}/${id}.md`,
      submitted: false,
      missing_fields: [
        "product",
        "execution",
        "plan",
        "version",
        "assignee",
      ].filter((k) => !b.fields?.[k]),
    });
  });
}
