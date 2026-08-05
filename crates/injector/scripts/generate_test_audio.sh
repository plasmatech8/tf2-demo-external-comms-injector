#!/usr/bin/env bash
# Generate small test WAVs (requires ffmpeg)
set -euo pipefail
CRATE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$CRATE/samples"
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ar 24000 -ac 1 "$CRATE/samples/test_tone_440hz.wav"
ffmpeg -y -f lavfi -i "sine=frequency=880:duration=1.5" -ar 24000 -ac 1 "$CRATE/samples/test_tone_880hz.wav"
ffmpeg -y -f lavfi -i "sine=frequency=300:duration=3,afade=t=in:st=0:d=0.1,afade=t=out:st=2.8:d=0.2" \
  -ar 24000 -ac 1 "$CRATE/samples/test_speechish.wav"
echo "Wrote test WAVs under crates/injector/samples/"
