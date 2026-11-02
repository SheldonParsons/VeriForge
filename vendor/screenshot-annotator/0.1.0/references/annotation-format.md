# Annotation format (schema version 1)

```json
{
  "schema_version": 1,
  "coordinate_space": {"width": 1200, "height": 800},
  "font_size": 20,
  "line_width": 2,
  "annotations": [{
    "box": {"x": 60, "y": 120, "width": 160, "height": 44},
    "label": {"x": 60, "y": 190},
    "text": "1. Check this control",
    "max_text_width": 400,
    "color": "#ff2020",
    "arrow": true,
    "location_source": "visual estimate on 1200x800 screenshot"
  }]
}
```

`annotations`, `box` and `text` are required. Unknown fields are rejected to catch spelling mistakes. `schema_version` defaults to 1. Use plain JSON, not Markdown code fences.

Coordinates start at the top-left; x goes right and y goes down. A box is x/y/width/height, not two corners. `coordinate_space` defaults to the source image size. All positions, font size, line width and text width use this same coordinate system. The renderer scales x and y separately to actual image pixels and rejects a mismatched aspect ratio. A matching ratio does not prove that two images share the same crop origin.

| Field | Default | Meaning |
|---|---|---|
| `font_size` | 20 | 6–256 coordinate units; final size must be 6–512 pixels |
| `line_width` | 2 | 1–32 coordinate units |
| `label` | automatic | Top-left of the white label background; optional |
| `max_text_width` | min(480, canvas width) | Text wrapping width, excluding label padding |
| `color` | `#ff2020` | A Pillow color string |
| `arrow` | true | A JSON boolean, not a string |
| `location_source` | `unspecified` | Up to 200 characters; agents should provide the actual source |

Use `\n` inside JSON text for a line break. Labels are wrapped by character and placed below, above or beside the target when space permits. Explicit labels are reserved first. No label may cover any supplied target box or another label. If there is no valid position, shorten text, reduce the font or provide `label.x/y` in free space. Arrow paths and unrelated page content are not automatically avoided.

CLI: `python scripts/annotate.py SOURCE SPEC_JSON NEW_OUTPUT.png [--font FONT] [--include-paths]`. Exit 0 means both files were written; input/layout/file errors return 2 with an actionable message. `--version` and `--help` do not require Pillow. Output and evidence hashes refer to the generated PNG and unchanged source bytes respectively; claims in labels are supplied data, not conclusions derived by the renderer.
