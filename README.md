# tldraw-offline MCP

A Bun + Hono MCP server that gives a remote agent complete control of tldraw Desktop's local Canvas API, durable document-script workspaces, assets, and screenshots.

The server runs on the Mac beside tldraw. Remote clients receive virtual workspace paths and inline MCP images—never unusable Mac paths or the app's bearer token.

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
      "url": "http://MAC_NAME.TAILNET_NAME.ts.net/mcp",
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

| Variable                        |                        Default | Description                           |
| ------------------------------- | -----------------------------: | ------------------------------------- |
| `TLDRAW_MCP_TOKEN`              |                       required | High-entropy MCP bearer token         |
| `TLDRAW_MCP_HOST`               |                    `127.0.0.1` | Bun bind address                      |
| `TLDRAW_MCP_PORT`               |                         `7237` | Bun port                              |
| `TLDRAW_MCP_ALLOWED_HOSTS`      |      `localhost,127.0.0.1,::1` | Comma-separated Host/Origin allowlist |
| `TLDRAW_SERVER_JSON`            | macOS application-support path | Override tldraw discovery file        |
| `TLDRAW_MCP_REQUEST_TIMEOUT_MS` |                        `30000` | Local Canvas API timeout              |
| `TLDRAW_MCP_IDLE_TIMEOUT_SECONDS` |                          `255` | Bun connection idle timeout           |
| `TLDRAW_MCP_MAX_REQUEST_BYTES`  |                     `26214400` | HTTP request limit                    |
| `TLDRAW_MCP_MAX_RESULT_BYTES`   |                      `5242880` | Canvas API response limit             |
| `TLDRAW_MCP_MAX_FILE_BYTES`     |                     `20971520` | Single workspace file limit           |
| `TLDRAW_MCP_MAX_IMAGE_BYTES`    |                     `20971520` | Inline screenshot limit               |

## Logging

Every request and response is written to stdout as one-line JSON. MCP logs include request/session headers, JSON-RPC methods and ids, initialize client metadata, and tool names/argument keys. Authorization headers and argument values are never logged. The current transport is stateless, so logs explicitly report `sessionMode: "stateless"`.

## Security

`tldraw_exec` and document scripts intentionally execute code inside tldraw. Treat MCP access as trusted control of open documents.

- Keep the Bun server on loopback.
- Use Tailscale Serve and ACLs rather than exposing port 7237 publicly.
- Keep the MCP token separate from tldraw's per-launch token.
- Do not enable wildcard CORS.
- The server never returns the local app token or workspace absolute paths.
- Filesystem access is restricted to roots returned by the app's own `script-workspace` endpoint; traversal and symlinks are rejected.

## Development

```bash
bun run dev
bun run typecheck
bun test
bun run check
```

`operator-guide/guide.md` is served as `tldraw://guide`. The MCP-native agent skill is under `skill/tldraw-offline/`.
