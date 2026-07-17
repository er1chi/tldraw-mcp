#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$HOME/.agents/skills/tldraw-offline}"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
cp -R "$PROJECT_DIR/skill/tldraw-offline" "$TARGET"
echo "Installed MCP-native skill at $TARGET"
