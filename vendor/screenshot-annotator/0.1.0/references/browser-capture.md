# Optional browser capture

Keep using the browser tools already authorized for the task. Scope the target by dialog, label, role and row context; require a unique match. Capture the same viewport state from which coordinates were read. If using `getBoundingClientRect()`, its coordinates belong to that document's viewport; iframe offsets require additional handling. Only set the viewport as `coordinate_space` after confirming the screenshot covers that same viewport.

The CommonJS adapter in `scripts/capture-target.cjs` accepts an existing Playwright `page` and `locator`. It does not import Playwright or create/login to a browser. The core Python renderer does not require this adapter.

```js
const {captureTarget} = require('./scripts/capture-target.cjs');
// page comes from your test. Choose a locator matching the actual UI.
const target = page.getByRole('button', {name: 'Save changes', exact: true});
await captureTarget(page, target, 'raw.png', 'annotations.json',
  '1. Save changes button');
// python scripts/annotate.py raw.png annotations.json marked.png
```

Create output directories first. Use Node 20+ and a Playwright version that supports `page.screenshot({scale: 'css'})`. The adapter checks for one visible target, scrolls it into view, obtains `locator.boundingBox()`, and captures the current viewport at CSS pixel scale. Bounds are relative to the main viewport, including for iframe locators. It checks the bounds, viewport dimensions and scroll offsets after capture; moving targets are retried up to three times. Targets clipped by the viewport are rejected.

The adapter uses `animations: 'disabled'`. For an animation-specific issue, capture with your existing browser tool instead. Full-page screenshots, cropped captures and pinch zoom are not supported by this adapter. Before/after checks are not an atomic freeze of page contents: inspect the final result.

Two output files are created exclusively with cleanup on ordinary write failures. This is not crash-atomic across both files. No click, test assertion, credential entry or ticket submission occurs.

Primary references: [Playwright boundingBox](https://playwright.dev/docs/api/class-locator#locator-bounding-box), [Playwright screenshot](https://playwright.dev/docs/api/class-page#page-screenshot), [DOM bounds](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect).
