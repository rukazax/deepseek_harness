#!/bin/bash
# Convert one uploaded Windows session log and place it into the Debian DSH store.
# usage: remote-push.sh <session-id> <uploaded-log-path>
set -euo pipefail

id="$1"
src="$2"
ROOT=/root/.dsh/sessions
STAGE=/root/dsh-sync/stage
NODE=/usr/local/bin/node

rm -rf "$STAGE"
mkdir -p "$STAGE" /root/dsh-sync/incoming
"$NODE" /root/dsh-sync/convert.js --in "$src" --root "$STAGE" --direction win2posix \
  --mkdir-cwd --meta /tmp/dsh-convert-meta.json >/dev/null

REL=$("$NODE" -p "require('/tmp/dsh-convert-meta.json').rel")
SHA=$("$NODE" -p "require('/tmp/dsh-convert-meta.json').sha256")
DST="$ROOT/$REL"
DIR=$(dirname "$DST")

if [ -f "$DST" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  mkdir -p "/root/.dsh/sync-backup/$TS/$id"
  cp -a "$DST" "/root/.dsh/sync-backup/$TS/$id/"
fi

mkdir -p "$DIR"
mv -f "$STAGE/$REL" "$DST"
chmod 600 "$DST"
# Keep a single generation in the session directory so the store reads the pushed log.
find "$DIR" -maxdepth 1 -type f -name 'session.v*.jsonl*' ! -name "$(basename "$DST")" -delete 2>/dev/null || true
# Drop the upload; the converted log is the copy we keep.
rm -f "$src"
rmdir "$(dirname "$src")" 2>/dev/null || true

echo "{\"rel\":\"$REL\",\"sha256\":\"$SHA\",\"dst\":\"$DST\"}"
