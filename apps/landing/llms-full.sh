#!/bin/sh
# Builds llms-full.txt on deploy: llms.txt plus the architecture notes, so it never drifts from them
set -e
cd "$(dirname "$0")/../.."
{
  cat apps/landing/llms.txt
  echo
  sed 's/^#/##/' docs/architecture.md
} > apps/landing/llms-full.txt
