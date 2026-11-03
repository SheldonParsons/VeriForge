import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  need,
  text,
  sha,
  encoded,
  atomicBytes,
  canonical,
  now,
} from "./store.mjs";
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export async function annotate(q) {
  const input = canonical(text(q.input, "input")),
    output = canonical(text(q.output, "output"));
  need(
    input !== output && !fs.existsSync(output) && output.endsWith(".png"),
    "INVALID_DESTINATION",
    "Use a new PNG output; preserve the original.",
  );
  const bytes = fs.readFileSync(input),
    meta = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
  need(
    ["png", "jpeg", "webp"].includes(meta.format) && !meta.pages,
    "INVALID_IMAGE",
    "Use a single-frame PNG/JPEG/WebP screenshot.",
  );
  const { width: w, height: h } = meta;
  const overlays = [];
  const box = (b) => {
    need(
      Array.isArray(b) && b.length === 4 && b.every(Number.isFinite),
      "INVALID_ANNOTATION",
      "Use [x,y,width,height].",
    );
    const [x, y, width, height] = b;
    need(
      x >= 0 &&
        y >= 0 &&
        width > 0 &&
        height > 0 &&
        x + width <= w &&
        y + height <= h,
      "INVALID_ANNOTATION",
      "Region lies outside the screenshot.",
    );
    return { x, y, width, height };
  };
  need(
    Array.isArray(q.annotations) &&
      q.annotations.length > 0 &&
      q.annotations.length <= 30,
    "INVALID_ANNOTATION",
    "Provide 1–30 annotations.",
  );
  const masks = q.redactions ?? [];
  need(
    Array.isArray(masks) && masks.length <= 100,
    "INVALID_ANNOTATION",
    "Too many redactions.",
  );
  for (const region of masks) {
    const b = box(region);
    overlays.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="#172033"/>`,
    );
  }
  q.annotations.forEach((a, i) => {
    const b = box(a.box),
      label = text(a.label, "label", 100);
    const color = a.color ?? "#087F8C";
    need(
      /^#[0-9a-f]{6}$/i.test(color),
      "INVALID_ANNOTATION",
      "Use a six-digit color.",
    );
    const size = Math.max(14, Math.min(28, Math.round(w / 70))),
      lineHeight = size + 10;
    const words = Array.from(`${i + 1}. ${label}`);
    const available = Math.min(w - 16, Math.max(220, b.width)),
      lineLen = Math.max(8, Math.floor((available - 20) / size));
    const lines = [];
    for (let n = 0; n < words.length; n += lineLen)
      lines.push(words.slice(n, n + lineLen).join(""));
    const lh = lines.length * lineHeight + 12;
    need(lh <= h - 16, "INVALID_ANNOTATION", "Label cannot fit screenshot.");
    const lx = Math.min(Math.max(8, b.x), w - available - 8),
      ly =
        b.y >= lh + 8 ? b.y - lh - 6 : Math.min(h - lh - 8, b.y + b.height + 6);
    overlays.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="6" fill="none" stroke="${color}" stroke-width="3"/><rect x="${lx}" y="${ly}" width="${available}" height="${lh}" rx="8" fill="${color}"/>`,
    );
    lines.forEach((line, j) =>
      overlays.push(
        `<text x="${lx + 10}" y="${ly + size + 8 + j * lineHeight}" fill="white" font-family="sans-serif" font-size="${size}">${xml(line)}</text>`,
      ),
    );
  });
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${overlays.join("")}</svg>`,
  );
  const png = await sharp(bytes)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  const manifest = {
    schema: 1,
    kind: "annotated_screenshot",
    source_sha256: sha(bytes),
    output_sha256: sha(png),
    width: w,
    height: h,
    annotations: q.annotations,
    redactions: masks,
    redaction_method: "opaque overlay",
    synthetic: q.synthetic === true,
    created_at: now(),
  };
  need(
    !fs.existsSync(output + ".evidence.json"),
    "INVALID_DESTINATION",
    "Evidence output already exists.",
  );
  atomicBytes(output, png, false);
  atomicBytes(output + ".evidence.json", encoded(manifest), false);
  return {
    path: output,
    evidence: output + ".evidence.json",
    sha256: manifest.output_sha256,
    source_preserved: true,
    synthetic: manifest.synthetic,
    requires_visual_review: true,
  };
}
