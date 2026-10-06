#!/bin/sh
# Release notes from the conventional commits in a git range (v0.5.63..HEAD): breaking changes, features and fixes,
# scope first. A "## Breaking" heading in the output is what makes release.yml ship a major.
# Usage: sh apps/desktop/scripts/release-notes.sh <range>
set -u
range=$1

subjects() { git log "$range" --no-merges --format=%s "$@"; }
# feat(hub)!: x -> - **hub**: x
pretty() { sed -E 's/^[a-z]+(\(([^)]*)\))?!?: */- **\2**: /; s/^- \*\*\*\*: /- /'; }
section() { [ -n "$2" ] && printf '## %s\n\n%s\n\n' "$1" "$2"; }

breaking=$({ subjects | grep -E '^[a-z]+(\([^)]*\))?!:'; subjects -E --grep='^BREAKING[ -]CHANGE:'; } | awk '!seen[$0]++' | pretty)
section Breaking "$breaking"
section Features "$(subjects | grep -E '^feat(\([^)]*\))?:' | pretty)"
section Fixes "$(subjects | grep -E '^fix(\([^)]*\))?:' | pretty)"
exit 0
