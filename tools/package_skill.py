#!/usr/bin/env python3
"""Build a reproducible source ZIP; does not upload or install it."""

import argparse
import hashlib
from pathlib import Path
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "skills/qa-workflow"
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in source.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            if path.is_symlink():
                raise ValueError("Do not package symlinked files")
            info = zipfile.ZipInfo("qa-workflow/" + path.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    print(f"{output}\nfiles={len(files)}\nsha256={hashlib.sha256(output.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
