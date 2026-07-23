# tldraw-offline-mcp

## What this codebase does

A Bun/Hono Streamable HTTP MCP server running beside tldraw Desktop on macOS.
It lets a trusted remote agent inspect and mutate live canvases, execute Canvas API
JavaScript, capture screenshots, and manage durable document scripts/assets. It
proxies to tldraw's loopback Canvas API and exposes virtual paths rather than Mac
filesystem paths or the app's per-launch token.

## Auth shape

- `loadConfig` requires `TLDRAW_MCP_TOKEN` (minimum 32 characters); the MCP bearer
  is a single capability with no users, sessions, roles, or per-tool scopes.
- `bearerAuth` protects `/mcp` and `/readyz`; `safeEqual` performs the token
  comparison with `timingSafeEqual`.
- Global `securityMiddleware` enforces `allowedHosts`, matching browser origins,
  and the configured request-size ceiling, but is not a substitute for auth.
- `/healthz` is deliberately unauthenticated and returns only static liveness;
  all Canvas API access, including readiness, is authenticated.
- `scripts/start.sh` keeps Bun on loopback and publishes it through Tailscale
  Serve; Tailscale ACLs are an expected second boundary around bearer auth.

## Threat model

The highest-impact compromise is theft or bypass of the MCP bearer: `/mcp`
intentionally grants arbitrary Canvas API/editor execution, document inspection,
screenshots, and document-script writes. Next are disclosure of tldraw's
per-launch Canvas token or absolute Mac paths, and any escape from the virtual
`script/**` / `assets/**` workspace into host files. This is a trusted-agent,
single-operator capability service, not a mutually untrusted multi-user system.

## Project-specific patterns to flag

- Any privileged Hono route mounted without `bearerAuth`; remember that
  `securityMiddleware` only checks host, origin, and body size.
- Returning/logging `mcpToken`, `TldrawServerInfo.token`, `ScriptWorkspaceResult`
  absolute paths, or unsanitized script status to MCP clients.
- Changes to `CanvasApiClient.fetchOnce` that make the upstream host/port/path
  caller-controlled instead of loopback plus `assertDocId` validation.
- Workspace operations that bypass `normalizeVirtualPath`, `inside`,
  `assertNoSymlink`, writable-root checks, or SHA-256 replacement preconditions.
- New Canvas JavaScript templates containing raw user values; helper programs
  should embed structured input with `JSON.stringify` as inspection services do.

## Known false-positives

- `src/mcp/create-server.ts`: `tldraw_search` and `tldraw_exec` accept arbitrary
  JavaScript by design; exposure is controlled at the authenticated `/mcp` route.
- `src/tldraw/canvas-api-client.ts`: reading `server.json` and forwarding its
  bearer token is required for the private loopback Canvas API.
- `src/tldraw/workspace-service.ts`: filesystem reads/writes/deletes are the
  intended durable-workspace feature and are restricted to virtual approved roots.
- `src/tldraw/screenshot-service.ts`: reading a returned file path is intentional;
  it is constrained to a single JPEG under tldraw's realpath-resolved temp root.
- `/healthz` and test fixture tokens under `tests/` are intentionally public or
  non-production; `/readyz` is not public and must remain authenticated.
