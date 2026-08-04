# TF2 Demo External Comms Injector

SvelteKit UI will live at the **repo root**. The Rust inject engine is a self-contained crate:

| Path | Role |
|------|------|
| *(upcoming)* `/` | SvelteKit + Cloudflare Workers host / UI |
| [`crates/injector/`](crates/injector/) | Rust library + CLIs |

## Rust engine

Work inside the crate directory (no Cargo workspace at repo root):

```bash
cd crates/injector
cargo build --release
./scripts/fetch_sample_demo.sh
./target/release/inject-comms --help
```

Full usage, verification, and format notes: **[crates/injector/README.md](crates/injector/README.md)**.

## License

MIT. Vendored `tf-demo-parser` retains its upstream MIT/Apache-2.0 license.
