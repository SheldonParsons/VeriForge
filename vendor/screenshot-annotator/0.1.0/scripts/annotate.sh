#!/usr/bin/env bash
set -euo pipefail
annotate_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${ANNOTATE_PYTHON:-}" ]]; then
  exec "$ANNOTATE_PYTHON" "$annotate_dir/annotate.py" "$@"
fi
if [[ -x "$annotate_dir/../.venv/bin/python" ]]; then
  exec "$annotate_dir/../.venv/bin/python" "$annotate_dir/annotate.py" "$@"
fi
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$annotate_dir/annotate.py" "$@"
fi
printf '%s\n' 'Python 3.10+ is required. Follow README.md or set ANNOTATE_PYTHON.' >&2
exit 2
