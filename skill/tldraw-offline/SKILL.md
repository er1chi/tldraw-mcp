---
name: tldraw-offline
description: Operate tldraw Desktop through the tldraw-offline MCP server, including inspecting and editing canvases, durable document scripts, custom shapes/overlays, assets, linting, and screenshots.
---

# tldraw canvas operator over MCP

Use the `tldraw_*` MCP tools supplied by the `tldraw-offline` server. If they are unavailable, report that the MCP server is not connected; do not fall back to an unauthenticated remote HTTP API.

## Workflow

1. Restate the intended result in concrete canvas terms.
2. Find the target with `tldraw_doc_focused` or `tldraw_docs_list`.
3. Inspect current records with `tldraw_doc_shapes`; inspect bindings only when connection behavior matters.
4. Choose durability:
   - static drawing changes use `tldraw_exec`;
   - persistent behavior uses `tldraw_workspace_open/read/apply`.
5. For durable behavior, read the matching recipe with `tldraw_recipe_get` before implementation.
6. Verify once with shapes, bindings, script status, or an inline screenshot.
7. Run `tldraw_lint` before reporting a diagram complete.
8. Stop after one successful verification unless debugging was requested.

## Rules

- Import SDK primitives inside exec with `await import('tldraw')`; document scripts may use top-level imports.
- Create semantic arrows with `helpers.createArrowBetweenShapes`; never substitute an unbound raw arrow.
- Return small JSON-serializable values from exec.
- Read and retain the SHA of every existing durable file before editing it.
- Extend non-default scripts; never clobber them.
- Treat script status `applied` as success, `pending` as incomplete, and `error` as failure. Check status once after a write and read `tldraw_script_error_log` on failure.
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
