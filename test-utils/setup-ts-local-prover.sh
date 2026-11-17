#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pin="$repo/typescript-client/spr-prover.lock.json"
read_pin() { node -p 'require(process.argv[1])[process.argv[2]]' "$pin" "$1"; }
revision=$(read_pin revision)
source_dir="$repo/target/spr-prover-source"
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full prover commit" >&2; exit 1; }
if [[ ! -d "$source_dir/.git" ]]; then
    mkdir -p "$source_dir"
    git -C "$source_dir" init -q
    git -C "$source_dir" remote add origin "$(read_pin repository)"
fi
[[ -z $(git -C "$source_dir" status --porcelain) ]] || { echo "Prover checkout has local changes: $source_dir" >&2; exit 1; }
git -C "$source_dir" fetch --depth=1 "$(read_pin repository)" "$revision"
git -C "$source_dir" checkout --detach "$revision"
client="$source_dir/$(read_pin path)"
node --input-type=module - "$pin" "$client/packages/web-prover/package.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [pin, pkg] = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, "utf8")));
assert.equal(pkg.name, pin.package);
assert.equal(pkg.version, pin.version);
NODE
runtime_pin() { node -p 'require(process.argv[1])[process.argv[2]]' "$client/runtime.lock.json" "$1"; }
rustup toolchain install "$(runtime_pin rustToolchain)" --profile minimal \
    --component rust-src --target wasm32-unknown-unknown
bindgen=$(runtime_pin wasmBindgen)
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen" ]]; then
    cargo +stable install wasm-bindgen-cli --version "$bindgen" --locked --force
fi
npm --prefix "$client" ci
env -u ZOPRO_DIR npm --prefix "$client" run build:prover
