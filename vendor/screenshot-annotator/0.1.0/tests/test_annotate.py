import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import struct
import zlib
from unittest.mock import patch
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('annotate', ROOT / 'scripts/annotate.py')
annotate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(annotate)


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.source = self.dir / 'source.png'
        Image.new('RGB', (800, 600), '#dce6f1').save(self.source)
        self.out = self.dir / 'marked.png'
        self.spec = {'annotations': [{'box': {'x': 80, 'y': 80, 'width': 100, 'height': 40},
                                     'label': {'x': 80, 'y': 160}, 'text': '1. Check control',
                                     'location_source': 'test fixture'}]}

    def test_preserves_pixels_dimensions_source_and_hashes(self):
        before = self.source.read_bytes()
        report = annotate.render(self.source, self.spec, self.out)
        self.assertEqual(before, self.source.read_bytes())
        with Image.open(self.source) as src, Image.open(self.out) as result:
            self.assertEqual(src.size, result.size)
            diff = ImageChops.difference(src.convert('RGB'), result.convert('RGB'))
            self.assertIsNotNone(diff.getbbox())
            self.assertIsNone(diff.crop((400, 0, 800, 600)).getbbox())
            self.assertIsNone(diff.crop((90, 90, 170, 110)).getbbox())
        self.assertEqual(report['source_sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(report['output_sha256'], hashlib.sha256(self.out.read_bytes()).hexdigest())
        self.assertEqual(json.loads(self.out.with_suffix('.evidence.json').read_text()), report)

    def test_preview_coordinate_scaling(self):
        self.spec['coordinate_space'] = {'width': 400, 'height': 300}
        report = annotate.render(self.source, self.spec, self.out)
        self.assertEqual(report['annotations'][0]['box_pixels'], {'x': 160, 'y': 160, 'width': 200, 'height': 80})

    def test_no_absolute_paths_by_default_and_opt_in(self):
        report = annotate.render(self.source, self.spec, self.out)
        self.assertEqual(report['source'], 'source.png')
        self.assertNotIn(str(self.dir), json.dumps(report))
        explicit = annotate.render(self.source, self.spec, self.dir / 'explicit.png', include_paths=True)
        self.assertEqual(explicit['local_paths']['source'], str(self.source.resolve()))

    def test_rejects_malformed_spec_shapes(self):
        for spec in [[], None, {'annotations': []}, {'annotations': [None]},
                     {'annotations': [{'box': [], 'text': 'x'}]}]:
            with self.subTest(spec=spec), self.assertRaises(annotate.AnnotationError):
                annotate.render(self.source, spec, self.out)
        self.assertFalse(self.out.exists())

    def test_rejects_unknown_fields(self):
        self.spec['annotations'][0]['colour'] = 'red'
        with self.assertRaisesRegex(annotate.AnnotationError, 'unknown field'):
            annotate.render(self.source, self.spec, self.out)

    def test_rejects_nonfinite_bool_and_outside_boxes(self):
        for value in [float('nan'), float('inf'), True, -1, 790]:
            with self.subTest(value=value), self.assertRaises(annotate.AnnotationError):
                self.spec['annotations'][0]['box']['x'] = value
                annotate.render(self.source, self.spec, self.out)

    def test_rejects_wrong_aspect_ratio(self):
        self.spec['coordinate_space'] = {'width': 100, 'height': 100}
        with self.assertRaisesRegex(annotate.AnnotationError, 'aspect ratio'):
            annotate.render(self.source, self.spec, self.out)

    def test_rejects_nonboolean_arrow_and_bad_color(self):
        for field, value in [('arrow', 'false'), ('color', 'not-a-color')]:
            with self.subTest(field=field), self.assertRaises(annotate.AnnotationError):
                self.spec['annotations'][0][field] = value
                annotate.render(self.source, self.spec, self.out)
            self.spec['annotations'][0].pop(field)

    def test_does_not_overwrite_existing_png_or_evidence(self):
        for file in [self.out, self.out.with_suffix('.evidence.json')]:
            file.write_bytes(b'keep')
            with self.assertRaises(annotate.AnnotationError):
                annotate.render(self.source, self.spec, self.out)
            self.assertEqual(file.read_bytes(), b'keep')
            file.unlink()

    def test_dangling_symlink_is_not_overwritten(self):
        try: self.out.symlink_to(self.dir / 'missing')
        except (OSError, NotImplementedError): self.skipTest('symlinks unavailable')
        with self.assertRaises(annotate.AnnotationError):
            annotate.render(self.source, self.spec, self.out)
        self.assertTrue(self.out.is_symlink())

    def test_rollback_if_second_write_fails(self):
        first, second = self.dir / 'first', self.dir / 'second'
        second.write_bytes(b'existing')
        with self.assertRaises(FileExistsError):
            annotate.write_pair([(first, b'new'), (second, b'other')])
        self.assertFalse(first.exists())
        self.assertEqual(second.read_bytes(), b'existing')

    def test_rollback_if_flush_fails(self):
        with patch.object(annotate.os, 'fsync', side_effect=OSError('simulated disk failure')):
            with self.assertRaises(OSError): annotate.render(self.source, self.spec, self.out)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.with_suffix('.evidence.json').exists())

    def test_explicit_missing_font_fails(self):
        with self.assertRaisesRegex(annotate.AnnotationError, 'Requested font'):
            annotate.render(self.source, self.spec, self.out, str(self.dir/'missing.ttf'))

    def test_explicit_labels_cannot_cover_other_targets(self):
        self.spec['annotations'].append({'box': {'x': 80, 'y': 160, 'width': 100, 'height': 40}, 'text': '2. Check'})
        with self.assertRaisesRegex(annotate.AnnotationError, 'no free space'):
            annotate.render(self.source, self.spec, self.out)

    def test_automatic_labels_avoid_each_other_and_targets(self):
        self.spec['annotations'][0].pop('label')
        self.spec['annotations'].append({'box': {'x': 80, 'y': 140, 'width': 100, 'height': 40}, 'text': '2. Check'})
        report = annotate.render(self.source, self.spec, self.out)
        entries = report['annotations']
        rect = lambda d: tuple(d[k] for k in ['x','y','width','height'])
        self.assertFalse(annotate.intersects(rect(entries[0]['label_pixels']), rect(entries[1]['label_pixels'])))
        for entry in entries:
            for target in entries:
                self.assertFalse(annotate.intersects(rect(entry['label_pixels']), rect(target['box_pixels'])))

    def test_label_outside_image_fails_without_output(self):
        self.spec['annotations'][0]['label'] = {'x': 790, 'y': 590}
        with self.assertRaises(annotate.AnnotationError): annotate.render(self.source, self.spec, self.out)
        self.assertFalse(self.out.exists())

    def test_cli_error_is_readable_without_traceback(self):
        spec_path = self.dir/'bad.json'
        spec_path.write_text('[]')
        result = subprocess.run([sys.executable, str(ROOT/'scripts/annotate.py'), str(self.source), str(spec_path), str(self.out)], capture_output=True,text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('spec must be a JSON object', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_rotated_exif_rejected(self):
        exif = Image.Exif(); exif[274] = 6
        source = self.dir/'rotated.jpg'
        Image.new('RGB', (40, 50)).save(source, exif=exif)
        with self.assertRaisesRegex(annotate.AnnotationError, 'orientation'):
            annotate.render(source, self.spec, self.out)

    def test_oversized_header_is_rejected_before_pixel_allocation(self):
        data = bytearray(self.source.read_bytes())
        data[16:24] = struct.pack('>II', 100000, 100000)
        data[29:33] = struct.pack('>I', zlib.crc32(data[12:29]))
        self.source.write_bytes(data)
        with self.assertRaisesRegex(annotate.AnnotationError, 'pixel limit'):
            annotate.render(self.source, self.spec, self.out)
        self.assertFalse(self.out.exists())


if __name__ == '__main__': unittest.main()
