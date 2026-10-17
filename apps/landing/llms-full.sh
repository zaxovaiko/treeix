#!/bin/sh
# Builds llms-full.txt on deploy: llms.txt, the plugin list from the README and the plugin guide, so it never drifts from them
set -e
cd "$(dirname "$0")/../.."
{
  cat apps/landing/llms.txt
  echo
  sed -n '/^## Plugins$/,/^## Roadmap$/p' README.md | sed '$d' | grep -v '^</*details>\|^<summary>' | sed 's|](packages/|](https://github.com/zaxovaiko/treeix/blob/main/packages/|g'
  echo
  sed 's/^#/##/' packages/README.md
} > apps/landing/llms-full.txt
