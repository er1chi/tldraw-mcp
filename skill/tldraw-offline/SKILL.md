---
name: tldraw-offline
description: Operate tldraw Desktop through the tldraw-offline MCP server, including inspecting and editing canvases, durable document scripts, custom shapes/overlays, assets, linting, and screenshots.
---

# tldraw canvas operator over MCP

Use the `tldraw_*` MCP tools supplied by the `tldraw-offline` server. If they are unavailable, report that the MCP server is not connected; do not fall back to an unauthenticated remote HTTP API.

## Workflow

1. Restate the intended result in concrete canvas terms.
2. Call `tldraw_doc_inspect` without a document id to select and inspect the focused document in one request. Use `tldraw_docs_list` first only when choosing by filename; request bindings only when connection behavior matters.
3. Choose durability:
   - static drawing changes use `tldraw_exec`;
   - persistent behavior uses `tldraw_workspace_open/read/apply`.
4. For durable behavior, read the matching recipe with `tldraw_recipe_get` before implementation.
5. Verify once with `tldraw_doc_inspect`, script status, or an inline screenshot.
6. Run `tldraw_lint` before reporting a diagram complete.
7. Stop after one successful verification unless debugging was requested.

## Rules

- Import SDK primitives inside exec with `await import('tldraw')`; document scripts may use top-level imports.
- Create semantic arrows with `helpers.createArrowBetweenShapes`; never substitute an unbound raw arrow.
- Return JSON-serializable values normally from search and exec; results arrive as JSON text, so never throw an error merely to surface data. Document records use `id` with `api.getShapes(id)` and `api.getBindings(id)`.
- Read and retain the SHA of every existing durable file before editing it.
- Extend non-default scripts; never clobber them.
- Treat the status returned by `tldraw_workspace_apply` as authoritative: `applied` is success, `pending` is incomplete after its bounded wait, and `error` is failure. Call `tldraw_script_status` only if apply remains pending; read `tldraw_script_error_log` on failure.
- Use only virtual `script/**` and `assets/**` paths. Never attempt to access archives, databases, metadata, locks, or Mac absolute paths.
- Use `tldraw_screenshot` only when visual placement is uncertain, UI chrome must be checked, or the user requests proof. The image is returned inline.

## Recipes

Discover recipes with `tldraw_recipes_list`. Read the relevant recipe in full before using it:

- `stack-existing-boxes`
- `add-durable-behavior-with-a-document-script`
- `editable-furniture-with-anchored-internals`
- `clickable-card-or-button-ui`
- `connection-dependent-behavior`
- `animation-simulation-loop`
- `custom-shape-config-js`
- `custom-overlay-config-js`

## Reporting

Include the document ID/name, changed shape IDs or virtual paths, and one verification result. If something fails, quote the MCP error, script state, or relevant error-log line.
