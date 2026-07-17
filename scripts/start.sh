#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TAILSCALE_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
export TLDRAW_MCP_ALLOWED_HOSTS="${TLDRAW_MCP_ALLOWED_HOSTS:-localhost,127.0.0.1,::1},$TAILSCALE_HOST"

bun src/server.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

tailscale serve --http=80 --yes "http://127.0.0.1:${TLDRAW_MCP_PORT:-7237}"
