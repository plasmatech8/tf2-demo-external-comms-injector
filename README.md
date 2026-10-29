# TF2 Demo External Comms Injector

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo-light.svg" alt="TF2 Demo External Comms Injector logo" width="160"/>
  </picture>
</p>

<p align="center"><b>Review TF2 demos with external comms synced in the built-in player</b></p>

<p align="center">
  <a href="https://tf2-demo-external-comms-injector.plasmatech8.workers.dev/"><b>Open the web app</b></a>
</p>

Injects an external audio recording into a SourceTV demo as in-game voice chat, so you can review gameplay and comms together in the built-in demo player—staying in sync even when you change playback speed.

**TF2 Demo External Comms Injector** turns an audio recording — or the audio from a video (e.g. Medal, OBS) — into Steam voice packets inside a `.dem` via `svc_VoiceData`. Generation runs in your browser. Files stay on your machine unless you choose **Create Share Link**, which uploads the generated demo, including its injected voice chat, to Cloudflare R2.

**Features:**

- Inject Discord/Mic (or any audio) into a `.dem` as `svc_VoiceData`
- Pick the speaker from players already in the demo
- Align to game start with a simple “seconds into the recording” field
- Auto-place on the demo timeline at `teamplay_round_start`
- Optional share links that expire after 7 days, with link history saved in this browser
- Offline CLI for the same engine (inspect / inject / extract)

**Use cases:**

- Add missing team voice to a STV for review or highlight reels
- Sync a Medal clip’s Discord track into the demo for Demoman / `playdemo`

## How it works

1. Drop in a SourceTV `.dem` and an audio/video recording
2. Choose who the voice should belong to
3. Set when the game starts in your recording (end of countdown / GO)
4. Generate — download a new `.dem` with injected voice chat
5. Optionally choose **Create Share Link** below the form. It uploads the same generated file without running generation again. The saved-links list stays on the same page.

```
.dem  +  audio/video  →  WASM inject  →  .dem with voice chat
```

| Path                                   | Role                              |
| -------------------------------------- | --------------------------------- |
| [`/`](.)                               | SvelteKit UI (Cloudflare Workers) |
| [`crates/injector/`](crates/injector/) | Rust library, CLIs, WASM target   |
| [`src/lib/wasm/`](src/lib/wasm/)       | Prebuilt WASM package for the UI  |

## Quick start (UI)

Use the hosted app at [tf2-demo-external-comms-injector.plasmatech8.workers.dev](https://tf2-demo-external-comms-injector.plasmatech8.workers.dev/), or run it locally:

```sh
npm install
npm run dev
```

The full generate → download → save share link → download from the link workflow works at `http://localhost:5173/`. Development uses a persistent R2 emulator in `.wrangler/state/v3`; it needs no Cloudflare account or bucket setup and never uploads to cloud storage. Use the same hostname and port when testing saved-link history, because local storage belongs to that origin. Local links work on this computer while the server runs. Server-side 7-day expiry is enforced locally too; bucket lifecycle cleanup is configured separately for production.

The progress box stays below **Generate & download** after completion, showing **Downloaded** and **Create Share Link**. Creating a link uploads the file already in memory. A **Share Links** footer appears once links exist and expands to the saved-link list. Copying and removing links happens in that list. The form scrolls above the footer, so an expanded list never covers the generation button.

```sh
npm run build
npm run preview
```

### Share-link storage (Cloudflare R2)

The Worker uses the `SHARED_DEMOS` binding in `wrangler.jsonc`, with `bucket_name` set to `tf2-demo-shares`. This is a bucket name, not an ID. With this configuration, bucket creation and lifecycle setup are a one-time provisioning step, not part of `npm run build` or a normal Worker deployment.

Enable R2 in your Cloudflare account if necessary, then run:

```sh
npx wrangler login
npx wrangler r2 bucket create tf2-demo-shares
npx wrangler r2 bucket lifecycle set tf2-demo-shares --file r2-lifecycle.json
```

If you choose another bucket name, update `bucket_name` in `wrangler.jsonc` and the commands above. Keep public bucket access disabled: downloads must pass through the Worker to enforce expiry. No R2 API keys, public bucket URL, or CORS configuration are needed. The commands configure cloud resources; local development and tests use local R2 storage.

After this initial setup, your normal CI build and `wrangler deploy` reuse the bucket and binding on each push. There is no GitHub Actions workflow in this repository; build triggers and deploy commands may be configured in Cloudflare Workers Builds. Creating buckets or applying lifecycle rules from CI requires R2 storage write permissions. The lifecycle JSON is versioned here but is only applied when the lifecycle command runs.

Wrangler also supports [automatic resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) when an R2 binding omits its bucket name. This project deliberately names the bucket so storage is explicit. Bucket creation and lifecycle configuration can be automated separately through Wrangler, the Cloudflare API or infrastructure tooling; no per-deployment manual dashboard edits are needed.

Share links open a minimal page with the filename, size, remaining lifetime and a **Download demo** button. Opening the page reads object metadata only. The button streams the `.dem` from `/share/<id>/download`; expired or missing links show a friendly unavailable page. The Worker checks expiry on every download and sends `no-store` headers. The R2 lifecycle policy removes demos after 7 days, session records after one day, and unfinished multipart uploads after one day. Physical cleanup can lag expiry; the Worker still denies expired downloads immediately. See [Cloudflare's object lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Uploads use 16 MiB parts and support demos up to 200 MiB (shown as 200 MB in the UI). Part uploads and completion retry transient failures. Session creation makes a single attempt because it allocates new resources on every call; a lost creation response must not automatically create additional sessions. A session whose creation response was lost contains no demo bytes and is removed by the one-day cleanup policy. Creation is limited to five attempts per minute per IP using a Workers rate-limit binding. This is a basic limit, not authentication. The initial upload response gives the browser an owner key; uploading parts, completing, and cancelling require that key in an Authorization header. A session ID in a URL grants no authority by itself. New session records store a verification proof rather than the owner key. Someone with a public share link cannot replace or delete the demo. A private R2 bucket is essential to these access rules.

The last generated file stays in memory until another successful generation or page reload. Link metadata and a private deletion key are saved to local storage, never demo bytes. Every unexpired link keeps its deletion key; other saved links are capped at 100. The deletion key is returned only to the uploader, never included in public share pages or copied URLs. Editing the form does not change the last generated file. Saved links are specific to the browser and origin; clearing browser data loses the list. For new links, the trash action deletes the uploaded demo and immediately revokes its link, then removes local history. If deletion fails, the entry and key remain available for retry. Existing links created before deletion keys were introduced can only be removed from history; their tooltip and a message explain that the link stays accessible until expiry. Expired entries remain labeled until removed.

Run `npm run test:shares` for local R2 upload/download, expiry, validation, retry, and browser-history tests.

Failed uploads and cancellation both discard unfinished parts and any completed demo whose response never reached the browser. Cleanup makes up to three attempts, with an independent 10-second deadline per attempt. If cleanup still fails, the page shows **Retry cancellation** and retains the owner key for another attempt. If the upload session has expired or been removed, cleanup uses that key to delete the demo directly. Cancelled session records stay in R2 until the existing one-day cleanup, making retries safe and preventing cancelled uploads from being resumed.

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
