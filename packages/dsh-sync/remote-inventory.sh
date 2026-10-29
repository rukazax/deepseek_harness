#!/bin/bash
# Print one line per session log: <relpath>|<size>|<mtime-unix>|<sha256>
set -euo pipefail
ROOT=/root/.dsh/sessions
[ -d "$ROOT" ] || exit 0
cd "$ROOT"
find . -mindepth 3 -maxdepth 3 -type f \( -name 'session.v*.jsonl' -o -name 'session.v*.jsonl.zstd' \) -print0 |
while IFS= read -r -d '' f; do
  printf '%s|%s|%s|%s\n' "$f" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
done
