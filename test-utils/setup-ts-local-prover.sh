#!/usr/bin/env bash
set -euo pipefail

# The Git-pinned TypeScript prover builds both WASM variants during pnpm install.
rustup toolchain install nightly-2025-11-15 --profile minimal \
    --component rust-src --target wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.128" ]]; then
    cargo +stable install wasm-bindgen-cli --version 0.2.128 --locked --force
fi
