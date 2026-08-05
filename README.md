# TF2 Demo External Comms Injector

Inject external audio into Team Fortress 2 `.dem` files as Steam voice chat. The **SvelteKit UI** lives at the repo root (Cloudflare Workers host); the **Rust engine** is a self-contained crate compiled to **WASM** for in-browser injection.

| Path | Role |
|------|------|
| `/` | SvelteKit UI + Cloudflare Workers host |
| [`crates/injector/`](crates/injector/) | Rust library + CLIs (+ WASM target) |
| [`src/lib/wasm/`](src/lib/wasm/) | Prebuilt WASM package used by the UI |

## UI (repo root)

```sh
npm install
npm run dev
```

```sh
npm run build
npm run preview
```

Generate runs the Rust injector in the browser via WASM. Demo + audio stay on-device; the Cloudflare Worker only hosts the static app.

### Rebuild WASM

Requires Rust (`rustup` toolchain from `crates/injector/rust-toolchain.toml`) and `wasm-bindgen-cli` matching the crate’s `wasm-bindgen` version:

```sh
cargo install wasm-bindgen-cli --version 0.2.126
npm run build:wasm
```

Prebuilt artifacts under `src/lib/wasm/pkg/` are committed so `npm run build` works without a Rust toolchain (e.g. Cloudflare).

## Rust engine

```bash
cd crates/injector
cargo build --release
./scripts/fetch_sample_demo.sh
./target/release/inject-comms --help
```

Full usage, verification, and format notes: **[crates/injector/README.md](crates/injector/README.md)**.

## License

MIT. Vendored `tf-demo-parser` retains its upstream MIT/Apache-2.0 license.
