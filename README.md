# tldraw-offline MCP

A Bun + Hono MCP server that gives a remote agent complete control of tldraw Desktop's local Canvas API, durable document-script workspaces, assets, and screenshots.

The server runs on the Mac beside tldraw. Remote clients receive virtual workspace paths and inline MCP images—never unusable Mac paths or the app's bearer token.

## TODO

- should be managed by `neo`
- efficiency around mcp docs reading requests

## Requirements

- macOS with tldraw Desktop and its Canvas API
- [Bun](https://bun.sh/)
- an MCP client supporting Streamable HTTP
- Tailscale for the recommended remote transport

## Install

```bash
cd /Users/c1re/Developer/infra/mbp/tldraw-offline-mcp
bun install
bun run check
```

## Start

Export a stable bearer token, then run the start script:

```bash
export TLDRAW_MCP_TOKEN="$(bun run --silent token)"
bun run start
```

The script starts the MCP server on `127.0.0.1:7237` and runs Tailscale Serve in HTTP-only mode on port 80. It prints the remote MCP URL and keeps both processes in the foreground until you press Ctrl-C.

Local endpoints:

- `http://127.0.0.1:7237/mcp`
- `http://127.0.0.1:7237/healthz`
- authenticated `http://127.0.0.1:7237/readyz`

Test the local endpoint with the official MCP client:

```bash
TLDRAW_MCP_URL=http://127.0.0.1:7237/mcp \
TLDRAW_MCP_TOKEN="$TLDRAW_MCP_TOKEN" \
  bun scripts/smoke.ts
```

## Configure a remote MCP client

Copy the printed HTTP endpoint and bearer token to the trusted Linux host. A generic Streamable HTTP configuration looks like:

```json
{
  "mcpServers": {
    "tldraw-offline": {
      "url": "http://DEVICE.TAILNET.ts.net/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

The exact configuration location depends on the MCP host. Keep the endpoint restricted with Tailscale ACLs as well as the bearer token.

Install `skill/tldraw-offline/SKILL.md` on the Linux agent host. If this repository is present there:

```bash
./scripts/install-skill.sh
```

## Tool surface

### Discovery and reference

- `tldraw_health`
- `tldraw_docs_list`
- `tldraw_doc_focused`
- `tldraw_doc_shapes`
- `tldraw_doc_bindings`
- `tldraw_reference_search`
- `tldraw_imports_search`
- `tldraw_helpers_list`
- `tldraw_recipes_list`
- `tldraw_recipe_get`
- `tldraw_readme`

### Canvas control

- `tldraw_search` — complete Canvas API escape hatch
- `tldraw_exec` — complete live Editor escape hatch
- `tldraw_lint`
- `tldraw_screenshot` — inline JPEG MCP content

### Durable scripts and assets

- `tldraw_workspace_open`
- `tldraw_workspace_list`
- `tldraw_workspace_read`
- `tldraw_workspace_apply`
- `tldraw_script_status`
- `tldraw_script_error_log`

The workspace API exposes only virtual `script/**` and `assets/**` paths for writes. Existing files use SHA-256 preconditions, exact edits require one unique match, complete buffers are written in watcher-compatible order, and entrypoints are committed last.

## Configuration

Copy `.env.example` to `.env`, set `TLDRAW_MCP_TOKEN`, and update any values you want to override.

## Development

```bash
bun run dev
bun run typecheck
bun test
bun run check
```

`operator-guide/guide.md` is served as `tldraw://guide`. The MCP-native agent skill is under `skill/tldraw-offline/`.

## Cool Examples

- https://x.com/max__drake/status/2078151243650810198?s=20
- https://x.com/tldraw/status/2078164903911719305?s=20
- https://x.com/shubgaur/status/2078309824199074020?s=20
