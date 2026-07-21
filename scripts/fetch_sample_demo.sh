#!/usr/bin/env bash
# Download demos.tf #1479677 into samples/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/samples/match-20260717-1011-koth_proot_b6c-alt2.dem"
META_URL="https://api.demos.tf/demos/1479677"

if [[ -f "$OUT" ]]; then
  echo "Already present: $OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

mkdir -p "$ROOT/samples"
echo "Fetching demo metadata..."
URL="$(curl -fsSL "$META_URL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["url"])')"
echo "Downloading $URL"
curl -fL --progress-bar -o "$OUT" "$URL"
echo "Saved $OUT ($(du -h "$OUT" | cut -f1))"
