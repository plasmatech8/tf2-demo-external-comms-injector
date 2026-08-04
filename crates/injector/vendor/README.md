# Vendored demostf/tf-demo-parser

Snapshot of https://codeberg.org/demostf/parser used because crates.io
`tf-demo-parser` 0.6.4 does not publish the `write` feature required to
re-encode demos.

Upstream license: MIT OR Apache-2.0 (see LICENSE files in this directory).

Test fixtures / fuzz corpora / benches were stripped to keep the tree small.
The vendored `Cargo.toml` drops `[[bench]]` and package-level profiles so it
works as a path dependency of the workspace.
