#!/bin/sh
# Builds treeix-ptyd and puts it where tauri's externalBin expects it: src-tauri/binaries/treeix-ptyd-<host triple>.
# Profile: the first argument (debug|release), else debug when tauri builds with --debug, else release.
set -eu
cd "$(dirname "$0")/.."
profile=${1:-$([ "${TAURI_ENV_DEBUG:-false}" = true ] && echo debug || echo release)}
triple=$(rustc --print host-tuple)
if [ "$profile" = release ]; then
  cargo build -p treeix-ptyd --bin treeix-ptyd --release
else
  cargo build -p treeix-ptyd --bin treeix-ptyd
fi
target_dir=$(cargo metadata --format-version 1 --no-deps | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
mkdir -p src-tauri/binaries
cp "$target_dir/$profile/treeix-ptyd" "src-tauri/binaries/treeix-ptyd-$triple"
