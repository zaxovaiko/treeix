#!/bin/sh
# Builds the Swift helpers (native/voice) and puts them where tauri's externalBin expects them:
# src-tauri/binaries/treeix-{voice,meetings}-<host triple>, and -universal-apple-darwin for the universal app.
# Release is arm64 + x86_64 in one file; debug is the host arch only. Not macOS: nothing to build.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
profile=${1:-$([ "${TAURI_ENV_DEBUG:-false}" = true ] && echo debug || echo release)}
triple=$(rustc --print host-tuple)
if [ "$profile" = release ]; then
  set -- -c release --arch arm64 --arch x86_64
else
  set -- -c debug
fi
swift build --package-path native/voice "$@"
bin=$(swift build --package-path native/voice "$@" --show-bin-path)
mkdir -p src-tauri/binaries
for name in treeix-voice treeix-meetings; do
  cp "$bin/$name" "src-tauri/binaries/$name-$triple"
  if [ "$profile" = release ]; then cp "$bin/$name" "src-tauri/binaries/$name-universal-apple-darwin"; fi
done
