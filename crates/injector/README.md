# TF2 Demo External Comms Injector (Rust engine)

Inject external audio (WAV / converted video audio) into Team Fortress 2 `.dem` files as **Steam voice chat** (`svc_VoiceData`), so the built-in demo player can play the comms in sync.

This crate lives at `crates/injector/`. Run Cargo commands from **this directory** (`cd crates/injector`).

## Status

Working end-to-end **offline**:

1. Encode PCM → Steam Voice (Opus PLC wrapper + CRC32)
2. Rewrite a SourceTV demo, inserting `svc_VoiceData` at chosen ticks
3. Round-trip verify by extracting/decoding voice back to WAV

**In-game TF2 playback is not verified in this environment** (no TF2 client). Structural + decode verification is strong; please confirm with `playdemo` on a gaming PC.

## Quick start

```bash
cd crates/injector

# Dependencies: Rust 1.85+, pkg-config, libopus (headers), ffmpeg (optional for media convert)
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:$PKG_CONFIG_PATH

cargo build --release

# Download the sample STV demo used during research (demos.tf #1479677)
./scripts/fetch_sample_demo.sh

# Inspect players / voice codec
./target/release/inspect-demo samples/match-20260717-1011-koth_proot_b6c-alt2.dem

# Inject a tone as plasmatech8 (demo offset auto = teamplay_round_start, or pass --offset)
./target/release/inject-comms \
  samples/match-20260717-1011-koth_proot_b6c-alt2.dem \
  samples/test_tone_440hz.wav \
  -o samples/injected.dem \
  --player plasmatech8 \
  --offset 10 \
  --loudness-db 0

# Extract voice back out (offline verification)
./target/release/extract-voice samples/injected.dem -o samples/extracted.wav
```

### Convert arbitrary audio/video to WAV

```bash
ffmpeg -i input.mp4 -ar 24000 -ac 1 samples/comms.wav
```

## CLI

### `inject-comms`

| Flag                 | Description                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `demo`               | Input `.dem`                                                                                                                                                 |
| `audio`              | Input `.wav` (PCM)                                                                                                                                           |
| `-o, --output`       | Output `.dem`                                                                                                                                                |
| `--audio-skip`       | Seconds to skip from the start of the input audio (game start in the recording; default `0`)                                                                 |
| `--offset`           | Demo-time inject start in seconds. **Default: auto** `teamplay_round_start`, else `0`. Not the same as `--audio-skip` — see [docs/timing.md](docs/timing.md) |
| `--loudness-db`      | Gain in dB (default `0`)                                                                                                                                     |
| `--gain`             | Linear gain (overrides dB)                                                                                                                                   |
| `--player`           | Player name substring                                                                                                                                        |
| `--steam-id`         | SteamID64 / `STEAM_X:Y:Z` / `[U:1:n]`                                                                                                                        |
| `--client-index`     | Explicit 0-based slot                                                                                                                                        |
| `--sample-rate`      | Encode rate (default `24000`; use 24 kHz for TF2 playback)                                                                                                   |
| `--bitrate`          | Opus bitrate bits/sec (default `64000`)                                                                                                                      |
| `--replace-existing` | Drop that client's voice in the injection window                                                                                                             |

### `inspect-demo` / `extract-voice`

See `--help`.

## How it works

Modern TF2 uses `sv_voicecodec steam`. Voice in demos is carried as `svc_VoiceData` net messages whose payload is a Steam Voice datagram:

```
steamid64 | SampleRate(0x0B) | OpusPlc(0x06, len/seq/opus…) | CRC32
```

This tool encodes your audio with libopus, wraps it in that format, and splices messages into `dem_packet` frames at ticks corresponding to the resolved demo `--offset` (auto round-start by default) and frame duration (~20 ms).

Voice is attributed to an existing player slot (client index + steamid) so the demo player has a valid speaker identity.

**Sync:** `--audio-skip` trims the recording; `--offset` places it on the demo timeline. Details: [docs/timing.md](docs/timing.md).

## Verification (no TF2 required)

Against demos.tf `#1479677` + a 2s 440 Hz tone attributed to `plasmatech8`:

| Check                       | Result                    |
| --------------------------- | ------------------------- |
| Original voice packets      | 0                         |
| Injected packets            | 100                       |
| Extracted packets / steamid | 100 / `76561198081400087` |
| Extracted duration          | 2.00 s @ 24 kHz           |
| Dominant frequency          | ~440 Hz (matches source)  |

Run the automated suite from this crate directory:

```bash
cargo test
./scripts/e2e_roundtrip.sh
```

## WASM (browser)

The library builds as `cdylib` for `wasm32-unknown-unknown` with pure-Rust Opus (`rusty-opus`):

```bash
# from repo root
npm run build:wasm
# or:
./scripts/build-wasm.sh
```

Exports (see `src/wasm.rs`):

- `inspect_demo(demo_bytes) → InspectReport JSON`
- `inject_comms(demo_bytes, wav_bytes, WasmInjectOptions) → { demo, meta_json }`

Native builds keep using libopus (`native-opus` feature). Browser builds use `--features wasm --no-default-features`.

## Limits / open questions

- **In-game playback** still needs a human with TF2 to confirm audible output, spatialization, and UI “speaking” indicators.
- SourceTV must have recorded with a `steam` voice init (this sample does). Older CELT/Speex demos need different codecs.
- Very large injections near demo EOF can fail if no later packets exist to hang frames on — use an earlier `--offset`.
- Alternate approaches (client mods, external A/V sync hooks) were intentionally avoided for security/complexity reasons; see `docs/research.md`.
- Browser WASM loads the whole demo into memory (tens of MB is fine; multi-hundred-MB demos may stress tab memory). Cloudflare Worker hosting of the injector itself is a separate follow-up (request body / CPU limits).

## Layout

```
crates/injector/
  Cargo.toml / Cargo.lock / rust-toolchain.toml
  src/           library + CLIs + wasm bindings
  docs/          format notes + research
  scripts/       sample fetch + e2e
  samples/       small WAVs (large .dem downloaded by script)
  vendor/        tf-demo-parser snapshot (write feature not on crates.io 0.6.4)
  scratch/       local manual-test files (gitignored except README)
```

## License

MIT (see repo-root `LICENSE`). `vendor/tf-demo-parser` retains its upstream MIT/Apache-2.0 license.
