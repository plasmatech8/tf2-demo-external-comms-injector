# TF2 Demo External Comms Injector

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo-light.svg" alt="TF2 Demo External Comms Injector logo" width="160"/>
  </picture>
</p>

<p align="center"><b>Review TF2 demos with external comms synced in the built-in player</b></p>

Injects an external audio recording into a SourceTV demo as in-game voice chat, so you can review gameplay and comms together in the built-in demo player—staying in sync even when you change playback speed.

**TF2 Demo External Comms Injector** turns an audio recording — or the audio from a video (e.g. Medal, OBS) — into Steam voice packets inside a `.dem` via `svc_VoiceData`. Everything runs in your browser; your demo and audio never leave your machine.

**Features:**
- Inject Discord/Mic (or any audio) into a `.dem` as `svc_VoiceData`
- Pick the speaker from players already in the demo
- Align to game start with a simple “seconds into the recording” field
- Auto-place on the demo timeline at `teamplay_round_start`
- Offline CLI for the same engine (inspect / inject / extract)

**Use cases:**
- Add missing team voice to a STV for review or highlight reels
- Sync a Medal clip’s Discord track into the demo for Demoman / `playdemo`

## How it works

1. Drop in a SourceTV `.dem` and an audio/video recording
2. Choose who the voice should belong to
3. Set when the game starts in your recording (end of countdown / GO)
4. Generate — download a new `.dem` with injected voice chat

```
.dem  +  audio/video  →  WASM inject  →  .dem with voice chat
```

| Path | Role |
| ---- | ---- |
| [`/`](.) | SvelteKit UI (Cloudflare Workers) |
| [`crates/injector/`](crates/injector/) | Rust library, CLIs, WASM target |
| [`src/lib/wasm/`](src/lib/wasm/) | Prebuilt WASM package for the UI |

## Quick start (UI)

```sh
npm install
npm run dev
```

```sh
npm run build
npm run preview
```

### Rebuild WASM

Needs Rust (`rustup` toolchain from `crates/injector/rust-toolchain.toml`) and a matching `wasm-bindgen-cli`:

```sh
cargo install wasm-bindgen-cli --version 0.2.126
npm run build:wasm
```

Prebuilt artifacts under `src/lib/wasm/pkg/` are committed, so `npm run build` works without a Rust toolchain (e.g. on Cloudflare).

## Rust engine (CLI)

```bash
cd crates/injector
cargo build --release
./scripts/fetch_sample_demo.sh
./target/release/inject-comms --help
```

Full usage, verification, and format notes → **[crates/injector/README.md](crates/injector/README.md)**

Timing (`--audio-skip` vs demo `--offset`) → **[crates/injector/docs/timing.md](crates/injector/docs/timing.md)**

## License

MIT. Vendored `tf-demo-parser` retains its upstream MIT/Apache-2.0 license. Optional CLI decode (`--features extract`) pulls in `steam-audio-codec` (EUPL-1.2) and is off by default.
