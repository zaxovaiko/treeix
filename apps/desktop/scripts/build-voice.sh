#!/bin/sh
# Builds the Swift helpers (native/voice) and puts them where tauri's externalBin expects them:
# src-tauri/binaries/treeix-{voice,meetings}-<host triple>, and -universal-apple-darwin for the universal app.
# Release is arm64 + x86_64 in one file; debug is the host arch only. Not macOS: nothing to build.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
profile=${1:-$([ "${TAURI_ENV_DEBUG:-false}" = true ] && echo debug || echo release)}
triple=$(rustc --print host-tuple)
mkdir -p src-tauri/binaries
if [ "$profile" = debug ]; then
  swift build --package-path native/voice -c debug
  bin=$(swift build --package-path native/voice -c debug --show-bin-path)
  for name in treeix-voice treeix-meetings; do cp "$bin/$name" "src-tauri/binaries/$name-$triple"; done
  exit 0
fi
# One build per arch, then lipo: `--arch arm64 --arch x86_64` builds through xcbuild, which can't link the
# text_processing_rs xcframework FluidAudio pulls in. Each arch gets its own scratch path, newer toolchains
# put every triple in the same products folder
build() { arch=$1; shift; swift build --package-path native/voice -c release --triple "$arch-apple-macosx14.0" --scratch-path "native/voice/.build/$arch" "$@"; }
for target in arm64 x86_64; do build "$target"; done
for name in treeix-voice treeix-meetings; do
  universal=src-tauri/binaries/$name-universal-apple-darwin
  lipo -create -output "$universal" "$(build arm64 --show-bin-path)/$name" "$(build x86_64 --show-bin-path)/$name"
  cp "$universal" "src-tauri/binaries/$name-$triple"
done
