#!/usr/bin/env python3
"""Local, deterministic screenshot annotations. Python 3.10+; Pillow required."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import sys

VERSION = "0.1.0"


class AnnotationError(ValueError):
    """An input or layout problem that can be corrected by the caller."""


def object_fields(value, allowed, required, name):
    if not isinstance(value, dict):
        raise AnnotationError(f"{name} must be a JSON object")
    missing, unknown = set(required) - value.keys(), value.keys() - set(allowed)
    if missing:
        raise AnnotationError(f"{name} missing field(s): {', '.join(sorted(missing))}")
    if unknown:
        raise AnnotationError(f"{name} unknown field(s): {', '.join(sorted(unknown))}")
    return value


def number(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AnnotationError(f"{name} must be a finite number")
    if not minimum <= value <= maximum:
        raise AnnotationError(f"{name} must be between {minimum:g} and {maximum:g}")
    return float(value)


def text_value(value, name, maximum=1000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AnnotationError(f"{name} must be nonempty text, at most {maximum} characters")
    return value


def validate_spec(spec, width, height):
    from PIL import ImageColor
    object_fields(spec, ['schema_version', 'coordinate_space', 'font_size', 'line_width', 'annotations'],
                  ['annotations'], 'spec')
    if type(spec.get('schema_version', 1)) is not int or spec.get('schema_version', 1) != 1:
        raise AnnotationError('schema_version must be 1')
    space = spec.get('coordinate_space', {'width': width, 'height': height})
    object_fields(space, ['width', 'height'], ['width', 'height'], 'coordinate_space')
    cw = number(space['width'], 'coordinate_space.width', 1, 100000)
    ch = number(space['height'], 'coordinate_space.height', 1, 100000)
    sx, sy = width / cw, height / ch
    if abs(sx - sy) > max(sx, sy) * 0.01:
        raise AnnotationError('coordinate_space aspect ratio differs from the image; check scaling or cropping')
    font_size = number(spec.get('font_size', 20), 'font_size', 6, 256)
    line_width = number(spec.get('line_width', 2), 'line_width', 1, 32)
    entries = spec['annotations']
    if not isinstance(entries, list) or not 1 <= len(entries) <= 100:
        raise AnnotationError('annotations must be an array with 1 to 100 entries')
    normalized = []
    for i, item in enumerate(entries):
        name = f'annotations[{i}]'
        object_fields(item, ['box', 'text', 'label', 'max_text_width', 'color', 'arrow', 'location_source'],
                      ['box', 'text'], name)
        box = object_fields(item['box'], ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height'], name + '.box')
        x = number(box['x'], name + '.box.x', 0, cw)
        y = number(box['y'], name + '.box.y', 0, ch)
        w = number(box['width'], name + '.box.width', 0.01, cw)
        h = number(box['height'], name + '.box.height', 0.01, ch)
        if x + w > cw or y + h > ch:
            raise AnnotationError(name + '.box falls outside the coordinate canvas')
        label = None
        if 'label' in item:
            pos = object_fields(item['label'], ['x', 'y'], ['x', 'y'], name + '.label')
            label = (number(pos['x'], name + '.label.x', 0, cw) * sx,
                     number(pos['y'], name + '.label.y', 0, ch) * sy)
        color = item.get('color', '#ff2020')
        if not isinstance(color, str):
            raise AnnotationError(name + '.color must be a color string')
        try:
            ImageColor.getrgb(color)
        except (ValueError, TypeError) as error:
            raise AnnotationError(name + '.color is not a valid color') from error
        arrow = item.get('arrow', True)
        if type(arrow) is not bool:
            raise AnnotationError(name + '.arrow must be true or false')
        normalized.append({'box': (x * sx, y * sy, w * sx, h * sy), 'label': label,
                           'text': text_value(item['text'], name + '.text'), 'color': color, 'arrow': arrow,
                           'max_text_width': number(item.get('max_text_width', min(480, cw)), name + '.max_text_width', 1, cw) * sx,
                           'location_source': text_value(item.get('location_source', 'unspecified'), name + '.location_source', 200)})
    size = round(font_size * min(sx, sy))
    if not 6 <= size <= 512:
        raise AnnotationError('scaled font_size must be between 6 and 512 image pixels')
    return normalized, space, sx, sy, size, max(1, round(line_width * min(sx, sy)))


def choose_font(explicit, text):
    requested = explicit or os.environ.get('ANNOTATE_FONT')
    if requested:
        if not Path(requested).is_file():
            raise AnnotationError('Requested font does not exist; correct --font or ANNOTATE_FONT')
        return str(Path(requested))
    candidates = [
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
        str(Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/msyh.ttc')]
    if all(ord(c) < 128 for c in text):
        candidates += ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                       '/System/Library/Fonts/Supplemental/Arial.ttf',
                       str(Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/arial.ttf')]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise AnnotationError('No suitable font found; provide --font FONT.ttf/ttc with glyphs for your labels')


def intersects(a, b):
    return a[0] < b[0] + b[2] and a[0] + a[2] > b[0] and a[1] < b[1] + b[3] and a[1] + a[3] > b[1]


def wrapped_lines(text, font, width):
    lines = []
    for paragraph in text.split('\n'):
        line = ''
        for char in paragraph:
            if font.getlength(char) > width:
                raise AnnotationError('max_text_width is too narrow for a character; increase it or reduce font_size')
            if line and font.getlength(line + char) > width:
                lines.append(line)
                line = ''
            line += char
        lines.append(line)
    return lines


def layout(entries, font, width, height, size):
    pad, gap = max(5, round(size * 0.4)), max(12, round(size * 0.8))
    line_height = sum(font.getmetrics()) + max(2, round(size * 0.2))
    boxes = [entry['box'] for entry in entries]
    placed = []
    for entry in entries:
        lines = wrapped_lines(entry['text'], font, min(entry['max_text_width'], width - 4 * pad))
        entry.update(lines=lines, label_size=(math.ceil(max(font.getlength(s) for s in lines)) + 2 * pad,
                                            len(lines) * line_height + 2 * pad))
    # Reserve explicit positions before choosing automatic positions.
    order = sorted(range(len(entries)), key=lambda i: entries[i]['label'] is None)
    for i in order:
        entry = entries[i]
        x, y, w, h = entry['box']
        lw, lh = entry['label_size']
        def fits(rect):
            return rect[0] >= 0 and rect[1] >= 0 and rect[0] + lw <= width and rect[1] + lh <= height and not any(intersects(rect, r) for r in boxes + placed)
        if entry['label'] is not None:
            candidates = [entry['label']]
        else:
            clamp_x = lambda a: max(0, min(a, width - lw))
            clamp_y = lambda a: max(0, min(a, height - lh))
            candidates = [(clamp_x(x), y+h+gap), (clamp_x(x), y-lh-gap),
                          (x+w+gap, clamp_y(y)), (x-lw-gap, clamp_y(y)),
                          (clamp_x(x+w-lw), y+h+gap), (clamp_x(x+w-lw), y-lh-gap)]
        rect = next(((lx, ly, lw, lh) for lx, ly in candidates if fits((lx, ly, lw, lh))), None)
        if rect is None:
            raise AnnotationError(f'annotations[{i}].label has no free space: choose label.x/y, shorten text or reduce font_size')
        entry['label_box'] = rect
        placed.append(rect)
    return pad, line_height


def write_pair(files):
    """Exclusive writes with rollback on ordinary errors; not a crash-atomic multi-file transaction."""
    created = []
    try:
        for path, data in files:
            with path.open('xb') as stream:
                stat = os.fstat(stream.fileno())
                created.append((path, stat.st_dev, stat.st_ino))
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
    except BaseException:
        for path, device, inode in reversed(created):
            try:
                stat = path.lstat()
                if (stat.st_dev, stat.st_ino) == (device, inode):
                    path.unlink()
            except FileNotFoundError:
                pass
        raise


def render(source, spec, output, font_path=None, include_paths=False):
    from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version
    source, output = Path(source), Path(output)
    report_path = output.with_suffix('.evidence.json')
    if output.suffix.lower() != '.png':
        raise AnnotationError('Output must have a .png extension')
    if output.resolve() == source.resolve() or report_path.resolve() == source.resolve():
        raise AnnotationError('Output must not replace the source')
    if any(os.path.lexists(p) for p in [output, report_path]):
        raise AnnotationError('Output or evidence file already exists; choose a new output name')
    if source.stat().st_size > 50 * 1024 * 1024:
        raise AnnotationError('Source image exceeds 50 MiB')
    original = source.read_bytes()
    try:
        opened = Image.open(io.BytesIO(original))
    except Image.DecompressionBombError as error:
        raise AnnotationError('Source image exceeds the supported pixel limit') from error
    with opened as raw:
        if raw.format not in ('PNG', 'JPEG', 'WEBP') or getattr(raw, 'n_frames', 1) != 1:
            raise AnnotationError('Use a single-frame PNG, JPEG or WebP screenshot')
        if raw.width * raw.height > 40_000_000:
            raise AnnotationError('Source image exceeds 40 million pixels')
        if raw.getexif().get(274, 1) != 1:
            raise AnnotationError('Source has a rotated EXIF orientation; export an upright screenshot first')
        if raw.mode not in ('RGB', 'RGBA', 'L', 'LA', 'P'):
            raise AnnotationError('Use an 8-bit RGB, RGBA, grayscale or palette screenshot')
        image = raw.convert('RGBA')
        profile = raw.info.get('icc_profile')
    width, height = image.size
    entries, space, sx, sy, size, stroke = validate_spec(spec, width, height)
    chosen_font = choose_font(font_path, ''.join(e['text'] for e in entries))
    font = ImageFont.truetype(chosen_font, size)
    pad, line_height = layout(entries, font, width, height, size)
    overlay = Image.new('RGBA', image.size)
    draw = ImageDraw.Draw(overlay)
    records = []
    for entry in entries:
        x, y, w, h = entry['box']
        lx, ly, lw, lh = entry['label_box']
        color = entry['color']
        draw.rectangle((x, y, min(width-1, x+w), min(height-1, y+h)), outline=color, width=stroke)
        if entry['arrow']:
            lc, tc = (lx+lw/2, ly+lh/2), (x+w/2, y+h/2)
            start = (min(max(tc[0], lx), lx+lw), min(max(tc[1], ly), ly+lh))
            end = (min(max(lc[0], x), x+w), min(max(lc[1], y), y+h))
            draw.line((start, end), fill=color, width=stroke)
            angle, length = math.atan2(end[1]-start[1], end[0]-start[0]), max(10, size*0.6)
            draw.polygon([end] + [(end[0]-length*math.cos(angle+d), end[1]-length*math.sin(angle+d)) for d in (-0.42, 0.42)], fill=color)
        draw.rectangle((lx, ly, lx+lw, ly+lh), fill='white')
        for n, line in enumerate(entry['lines']):
            draw.text((lx+pad, ly+pad+n*line_height), line, font=font, fill=color, anchor='lt')
        records.append({'box_pixels': dict(zip(['x', 'y', 'width', 'height'], entry['box'])),
                        'label_pixels': dict(zip(['x', 'y', 'width', 'height'], entry['label_box'])),
                        'text': entry['text'], 'location_source': entry['location_source']})
    result = Image.alpha_composite(image, overlay)
    buffer = io.BytesIO()
    result.save(buffer, format='PNG', **({'icc_profile': profile} if profile else {}))
    png = buffer.getvalue()
    report = {'schema_version': 1, 'tool': 'screenshot-annotator', 'tool_version': VERSION,
              'source': source.name, 'source_sha256': hashlib.sha256(original).hexdigest(),
              'output': output.name, 'output_sha256': hashlib.sha256(png).hexdigest(),
              'image_size': {'width': width, 'height': height}, 'coordinate_space': space,
              'scale': {'x': sx, 'y': sy}, 'font': Path(chosen_font).name,
              'runtime': {'python': platform.python_version(), 'pillow': pillow_version},
              'annotations': records, 'note': 'Supplied annotations; not a test verdict. No timestamps or absolute paths by default.'}
    if include_paths:
        report['local_paths'] = {'source': str(source.resolve()), 'font': str(Path(chosen_font).resolve())}
    evidence = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    write_pair([(output, png), (report_path, evidence)])
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', action='version', version=VERSION)
    parser.add_argument('source', help='Source screenshot; never overwritten')
    parser.add_argument('spec', help='Annotation JSON; schema version 1')
    parser.add_argument('output', help='New PNG path; creates matching .evidence.json')
    parser.add_argument('--font', help='Font file with the glyphs needed by your labels')
    parser.add_argument('--include-paths', action='store_true', help='Opt in to absolute local paths in evidence')
    args = parser.parse_args(argv)
    try:
        try:
            import PIL
        except ImportError as error:
            raise AnnotationError('Pillow is missing; install requirements.txt in your Python environment') from error
        spec_path = Path(args.spec)
        if spec_path.stat().st_size > 1024 * 1024:
            raise AnnotationError('Annotation JSON exceeds 1 MiB')
        spec = json.loads(spec_path.read_text(encoding='utf-8'))
        report = render(args.source, spec, args.output, args.font, args.include_paths)
        print(json.dumps({'status': 'complete', 'output': str(Path(args.output)),
                          'evidence': str(Path(args.output).with_suffix('.evidence.json')),
                          'annotations': len(report['annotations'])}, ensure_ascii=False))
        return 0
    except (AnnotationError, ValueError, TypeError, KeyError, OSError, UnicodeError) as error:
        print(f'Annotation failed: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
