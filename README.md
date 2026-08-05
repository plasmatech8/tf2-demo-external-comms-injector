# TF2 Demo External Comms Injector

Inject external audio into Team Fortress 2 `.dem` files as Steam voice chat. The **SvelteKit UI** lives at the repo root (Cloudflare Workers host); the **Rust engine** is a self-contained crate.

| Path | Role |
|------|------|
| `/` | SvelteKit UI + Cloudflare Workers host |
| [`crates/injector/`](crates/injector/) | Rust library + CLIs |

## UI (repo root)

```sh
npm install
npm run dev
```

```sh
npm run build
npm run preview
```

Generate is still mocked in the UI — real injection lands in a follow-up. Engine details stay in the crate.

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
