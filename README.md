# TF2 Demo External Comms Injector

Monorepo layout (prepared for the web UI to land at repo root):

| Path | Role |
|------|------|
| `crates/injector/` | Rust library + CLIs that inject external audio into TF2 `.dem` files as Steam voice chat |
| *(upcoming)* repo root | SvelteKit + Cloudflare Workers host / UI |

## Rust engine

See **[crates/injector/README.md](crates/injector/README.md)** for build, CLI usage, verification, and format notes.

```bash
# from repo root
cargo build --release -p tf2-demo-comms-injector
./crates/injector/scripts/fetch_sample_demo.sh
./target/release/inject-comms --help
```

## License

MIT. Vendored `tf-demo-parser` retains its upstream MIT/Apache-2.0 license.
