// Optional Playwright adapter. The caller supplies an existing page and locator.
// Captures a viewport PNG and matching coordinates; it does not execute test steps.
const fs = require('node:fs/promises');
const path = require('node:path');

async function writePair(files) {
  const created = [];
  try {
    for (const [file, data] of files) {
      const handle = await fs.open(file, 'wx');
      try {
        const stat = await handle.stat();
        created.push({file, ino: stat.ino, dev: stat.dev});
        await handle.writeFile(data);
        await handle.sync();
      } finally { await handle.close(); }
    }
  } catch (error) {
    for (const entry of created.reverse()) {
      try {
        const stat = await fs.lstat(entry.file);
        if (stat.ino === entry.ino && stat.dev === entry.dev) await fs.unlink(entry.file);
      } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; }
    }
    throw error;
  }
}

async function captureTarget(page, locator, pngPath, jsonPath, text) {
  if (path.resolve(pngPath) === path.resolve(jsonPath)) throw new Error('Screenshot and specification paths must differ');
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Annotation text must contain 1 to 1000 characters');
  for (const path of [pngPath, jsonPath]) {
    try { await fs.lstat(path); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Refusing to overwrite ${path}`);
  }
  if (await locator.count() !== 1) throw new Error('Locator must resolve to exactly one element');
  await locator.waitFor({state: 'visible'});
  await locator.scrollIntoViewIfNeeded();
  const viewportState = () => ({width: innerWidth, height: innerHeight,
    scrollX, scrollY, zoom: visualViewport?.scale ?? 1});
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await locator.boundingBox();
    const viewport = await page.evaluate(viewportState);
    if (!before || viewport.zoom !== 1) throw new Error('Target invisible or viewport pinch-zoom unsupported');
    const png = await page.screenshot({type: 'png', fullPage: false, scale: 'css', animations: 'disabled'});
    const after = await locator.boundingBox();
    const current = await page.evaluate(viewportState);
    const stable = after && Object.keys(before).every(k => Math.abs(before[k] - after[k]) <= 0.5)
      && JSON.stringify(viewport) === JSON.stringify(current);
    if (!stable) continue;
    if (before.x < 0 || before.y < 0 || before.x + before.width > viewport.width
      || before.y + before.height > viewport.height) throw new Error('Target is clipped by viewport');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (width !== viewport.width || height !== viewport.height)
      throw new Error('PNG size differs from CSS viewport; check browser capture settings');
    const spec = {schema_version: 1, coordinate_space: {width, height}, font_size: 18, line_width: 2,
      annotations: [{box: before, text, location_source: 'playwright.locator.boundingBox', arrow: true}]};
    await writePair([[pngPath, png], [jsonPath, JSON.stringify(spec, null, 2) + '\n']]);
    return spec;
  }
  throw new Error('Target moved during capture; wait for a stable page and retry');
}

module.exports = {captureTarget, writePair};
