#!/usr/bin/env bash
# Rebuild the browser WASM package into src/lib/wasm/pkg.
# Requires: rustup target wasm32-unknown-unknown, wasm-bindgen-cli matching Cargo.lock.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/crates/injector"
OUT="$ROOT/src/lib/wasm/pkg"

cd "$CRATE"
rustup target add wasm32-unknown-unknown >/dev/null

echo "Compiling injector for wasm32-unknown-unknown…"
cargo build --lib --release --target wasm32-unknown-unknown \
	--features wasm --no-default-features

WASM="$CRATE/target/wasm32-unknown-unknown/release/tf2_demo_comms_injector.wasm"
mkdir -p "$OUT"

echo "Running wasm-bindgen → $OUT"
wasm-bindgen \
	--target web \
	--out-dir "$OUT" \
	--out-name tf2_demo_comms_injector \
	"$WASM"

# Drop wasm-pack-style gitignore if present so committed artifacts stay tracked.
rm -f "$OUT/.gitignore"

echo "Done: $(du -h "$OUT/tf2_demo_comms_injector_bg.wasm" | cut -f1) WASM module"
