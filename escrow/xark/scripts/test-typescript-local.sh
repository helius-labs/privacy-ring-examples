#!/usr/bin/env bash
set -euo pipefail

# Run the Node integration with application Xark proofs and SPP proofs local.
escrow=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "$escrow/../.." && pwd)
source "$repo/test-utils/zolana-release.sh"

check_pins "$escrow/Cargo.toml"
install_zolana_cli "$escrow/.tools/$zolana_release" "$escrow/.tools/bin/zolana"
export ZOLANA_CLI_BIN="$escrow/.tools/bin/zolana"
while IFS='=' read -r name value; do
    case "$name" in
        SHIELDED_POOL_PROGRAM_PATH | ZOLANA_PHOTON_BIN | SURFPOOL_BIN)
            export "$name=$value"
            ;;
    esac
done < <("$ZOLANA_CLI_BIN" dev artifacts)

# Explicit custom programs select the CLI's local-artifact mode. Load the
# initialized production-key snapshot that the release's default stack uses.
snapshot="accounts-$zolana_release.tar.gz"
snapshot_digest=$(awk -v file="$snapshot" '$2 == file { print $1 }' "$escrow/.tools/$zolana_release/SHA256SUMS")
[[ ${#snapshot_digest} == 64 ]] || { echo "Missing release snapshot checksum" >&2; exit 1; }
fetch "$zolana_releases_url/$zolana_release/$snapshot" "$escrow/.tools/$zolana_release/$snapshot" "$snapshot_digest"
export ZOLANA_XARK_ACCOUNTS_DIR="$escrow/target/typescript-accounts"
mkdir -p "$ZOLANA_XARK_ACCOUNTS_DIR"
tar -xzf "$escrow/.tools/$zolana_release/$snapshot" -C "$ZOLANA_XARK_ACCOUNTS_DIR"

bash "$repo/test-utils/setup-ts-local-prover.sh"
if ! command -v wasm-pack >/dev/null; then
    cargo +stable install wasm-pack --version 0.15.0 --locked
fi
"$ZOLANA_CLI_BIN" zk compile --test --single-threaded --wasm-target nodejs --manifest-path "$escrow/program/Cargo.toml"
"$escrow/scripts/check-keys.sh"
cargo build-sbf --manifest-path "$escrow/program/Cargo.toml" --tools-version v1.54 -- --locked --features bpf-entrypoint

npm exec --yes --package=pnpm@11.18.0 -- pnpm --dir "$repo/typescript-client" install --frozen-lockfile
npm exec --yes --package=pnpm@11.18.0 -- pnpm --dir "$repo/typescript-client" test:xark-local
