#!/bin/sh
# Builds the Swift helper (native/voice) for this Mac and puts it where tauri's externalBin expects it:
# src-tauri/binaries/treeix-voice-<host triple>. Dictation and meetings run on Apple silicon only, so the Intel
# app ships without it and there is no universal build. Not macOS: nothing to build.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
profile=${1:-$([ "${TAURI_ENV_DEBUG:-false}" = true ] && echo debug || echo release)}
swift build --package-path native/voice -c "$profile"
mkdir -p src-tauri/binaries
out="src-tauri/binaries/treeix-voice-$(rustc --print host-tuple)"
install -m 755 "$(swift build --package-path native/voice -c "$profile" --show-bin-path)/treeix-voice" "$out"
# Local symbols are only for debuggers; tauri signs the binary after this
[ "$profile" = debug ] || strip -x "$out"
