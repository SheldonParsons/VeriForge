#!/usr/bin/env python3
"""Validate a standalone Skill ZIP and exercise only synthetic local records."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile


def validate(archive_path):
    calls = []
    with tempfile.TemporaryDirectory(prefix="veriforge-bundle-") as temporary:
        root = Path(temporary).resolve()
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            assert len(names) == len(set(names))
            for info in archive.infolist():
                path = PurePosixPath(info.filename)
                assert not path.is_absolute() and '..' not in path.parts and path.parts[0] == 'qa-workflow'
                assert not stat.S_ISLNK(info.external_attr >> 16)
                assert '.local' not in path.parts and '__pycache__' not in path.parts
            archive.extractall(root)
        package = root / "qa-workflow"
        local_links = 0
        for path in package.rglob('*.md'):
            body = re.sub(r'```.*?```', '', path.read_text(encoding='utf-8'), flags=re.S)
            body = re.sub(r'`[^`\n]+`', '', body)
            for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', body):
                target = target.strip('<>').split('#', 1)[0]
                if not target or re.match(r'[a-zA-Z][a-zA-Z0-9+.-]*:', target):
                    continue
                destination = (path.parent / target).resolve()
                assert destination.is_relative_to(package) and destination.exists(), (path.name, target)
                local_links += 1
        manifest = json.loads((package / 'assets/guides/manifest.json').read_text(encoding='utf-8'))
        for guide in manifest['guides']:
            content = (package / 'assets/guides' / guide['file']).read_bytes()
            assert hashlib.sha256(content).hexdigest() == guide['sha256']
            assert content[:8] == b'\x89PNG\r\n\x1a\n'
            assert struct.unpack('>II', content[16:24]) == (guide['width'], guide['height'])
        script = package / 'scripts/qa.py'
        workspace = root / 'work'
        def call(action, expected_ok=True, target=None, **fields):
            proc = subprocess.run([sys.executable, str(script), '--workspace', str(target or workspace)],
                cwd=root, input=json.dumps({'action': action, 'actor': 'lead', **fields}),
                text=True, capture_output=True)
            result = json.loads(proc.stdout)
            assert result['ok'] == expected_ok, result
            assert proc.returncode == (0 if expected_ok else 2), result
            calls.append({'action': action, 'ok': result['ok']})
            return result.get('result', result.get('error'))
        cap = call('capabilities')
        assert not workspace.exists()
        assert cap['version'] == '0.3.0'
        call('workspace.init', title='合成安装包验证')
        call('project.create', project='demo', title='合成项目')
        call('requirement.create', project='demo', requirement='123', title='合成需求')
        scope = {'project': 'demo', 'requirement': '123'}
        source = root / 'basis.md'
        source.write_text('Synthetic evidence only. No real test was executed.', encoding='utf-8')
        call('artifact.import', **scope, artifact='basis', source_path=str(source), purpose='合成依据')
        call('workflow.record', **scope, expected_revision=0, facts={
            'business': {'status': 'ready', 'basis': '合成理解确认', 'evidence': ['basis']},
            'release': {'status': 'not_released', 'basis': '尚未上线'},
            'knowledge': {'status': 'draft', 'basis': '本地草稿'}})
        refused = call('workflow.record', expected_ok=False, **scope, expected_revision=1,
                       facts={'release': {'status': 'released', 'basis': '没有依据'}})
        assert refused['code'] == 'EVIDENCE_REQUIRED'
        call('deliverable.set', **scope, deliverable='cases', artifact='basis', role='case_set', title='合成用例', basis='草稿', expected_revision=0)
        call('followup.record', **scope, followup='deploy', title='等待部署', status='waiting', basis='合成待办', next='部署后继续', expected_revision=0)
        state = call('resume', **scope)
        assert state['workflow']['facts']['release']['status'] == 'not_released'
        assert state['deliverables']['total'] == state['followups']['total'] == 1
        call('summary.write', **scope)
        saved = root / 'state.zip'
        call('backup.create', destination=str(saved))
        restored = root / 'restored'
        call('backup.restore', archive=str(saved), destination=str(restored))
        resumed = call('resume', target=restored, **scope)
        assert resumed['restored_review_required']
        assert resumed['workflow']['facts'] == state['workflow']['facts']
        assert resumed['followups']['items'][0]['next'] == '部署后继续'
        return {'schema': 1, 'version': cap['version'], 'archive_sha256': hashlib.sha256(Path(archive_path).read_bytes()).hexdigest(),
                'archive_bytes': Path(archive_path).stat().st_size, 'package_files': len(names),
                'local_links_checked': local_links, 'guide_hashes_and_dimensions_checked': len(manifest['guides']),
                'synthetic_cli_calls': calls, 'standalone_package_passed': True,
                'external_business_calls': 0, 'independent_agent_verified': False,
                'native_host_image_display_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    result = validate(Path(args.archive))
    report = Path(args.report)
    report.parent.mkdir(parents=True, exist_ok=True)
    with report.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'report': str(report), 'package_files': result['package_files'],
                      'synthetic_calls': len(result['synthetic_cli_calls']), 'passed': True}, ensure_ascii=False))
