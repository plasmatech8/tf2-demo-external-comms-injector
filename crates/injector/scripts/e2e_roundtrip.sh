#!/usr/bin/env bash
# End-to-end: inject tone → extract → check duration/steamid/packet count
set -euo pipefail
CRATE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CRATE"

export PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}/usr/local/lib/pkgconfig"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}/usr/local/lib"

./scripts/fetch_sample_demo.sh
cargo build --release -q

DEMO="samples/match-20260717-1011-koth_proot_b6c-alt2.dem"
AUDIO="samples/test_tone_440hz.wav"
INJECTED="samples/e2e_injected.dem"
EXTRACTED="samples/e2e_extracted.wav"

rm -f "$INJECTED" "$EXTRACTED"

./target/release/inject-comms "$DEMO" "$AUDIO" -o "$INJECTED" \
  --player plasmatech8 --offset 10 --loudness-db 0 > samples/e2e_inject.json

./target/release/extract-voice "$INJECTED" -o "$EXTRACTED" > samples/e2e_extract.json

python3 - <<'PY'
import json, wave, struct, math
inj = json.load(open("samples/e2e_inject.json"))
ext = json.load(open("samples/e2e_extract.json"))
assert inj["packets_injected"] == 100, inj
assert ext["packets"] == 100, ext
assert ext["steam_ids"] == [76561198081400087], ext
assert ext["decoded_samples"] == 48000, ext
with wave.open("samples/e2e_extracted.wav") as w:
    assert w.getframerate() == 24000
    assert w.getnframes() == 48000
    raw = w.readframes(w.getnframes())
    samples = struct.unpack("<" + "h" * (len(raw)//2), raw)
    rms = math.sqrt(sum(s*s for s in samples)/len(samples))
    assert rms > 500, rms
print("e2e_roundtrip OK")
print(json.dumps({"injected": inj["packets_injected"], "extracted": ext["packets"], "rms": rms}, indent=2))
PY
