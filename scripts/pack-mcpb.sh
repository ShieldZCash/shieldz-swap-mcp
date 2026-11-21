#!/usr/bin/env bash
# Builds shieldz-swap.mcpb (Claude Desktop / MCPB bundle) with production deps only.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R dist manifest.json icon.png package.json package-lock.json LICENSE README.md "$stage/"
(cd "$stage" && npm ci --omit=dev --silent)
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" shieldz-swap.mcpb
shasum -a 256 shieldz-swap.mcpb
