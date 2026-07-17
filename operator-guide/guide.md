# tldraw offline MCP operator guide

Use this server to inspect and control tldraw Desktop running on the Mac.

## Choose the correct workflow

- **Static canvas changes**—create, move, style, align, stack, select, or delete shapes—use `tldraw_exec`.
- **Durable behavior**—click handlers, keyboard behavior, animations, reactive layouts, run-on-open logic, custom shapes, tools, or overlays—use the workspace tools.

Before acting, identify the document with `tldraw_doc_focused` or `tldraw_docs_list`. Inspect existing shapes before mutating them. Verify once after a successful operation and stop unless debugging was requested.

## Static edits

1. Find the document.
2. Read shapes with `tldraw_doc_shapes`; read bindings only when connection behavior matters.
3. Call `tldraw_exec` with code that returns a small JSON result.
4. Verify once with shape records, bindings, or `tldraw_screenshot` when visual placement is uncertain.
5. Run `tldraw_lint` before reporting a diagram complete.

An exec snippet receives only `editor`, `helpers`, `signal`, and `app` as bare values. Import SDK symbols dynamically:

```js
const { createShapeId, toRichText } = await import('tldraw')
const id = createShapeId('box1')
editor.createShape({
  id,
  type: 'geo',
  x: 100,
  y: 100,
  props: { geo: 'rectangle', w: 300, h: 200, richText: toRichText('Label') },
})
return { created: [id] }
```

Create every meaningful connection with `helpers.createArrowBetweenShapes(fromId, toId, options)` so both endpoints receive real bindings. Raw unbound arrows are only for explicitly decorative marks. Address every actionable linter result.

## Reference and recipes

Start with semantic tools rather than dumping the whole reference:

- `tldraw_reference_search`
- `tldraw_imports_search`
- `tldraw_helpers_list`
- `tldraw_recipes_list`
- `tldraw_recipe_get`

Read the matching recipe before building durable behavior. Recipe IDs are:

- `stack-existing-boxes`
- `add-durable-behavior-with-a-document-script`
- `editable-furniture-with-anchored-internals`
- `clickable-card-or-button-ui`
- `connection-dependent-behavior`
- `animation-simulation-loop`
- `custom-shape-config-js`
- `custom-overlay-config-js`

`tldraw_search` and `tldraw_exec` are complete escape hatches when a semantic tool is insufficient.

## Durable scripts

1. Call `tldraw_workspace_open`.
2. Check `isDefaultScript` and the manifest.
3. If `main.js`, `config.js`, or another target already exists, call `tldraw_workspace_read` and retain its `sha256`. Extend a non-default script; never clobber it.
4. Read the matching recipe.
5. Apply changes with `tldraw_workspace_apply`. Use exact edits plus the observed SHA for existing text. Write dependencies before the entrypoint; a batch does this automatically.
6. Read the returned watcher status. If needed, call `tldraw_script_status` once afterward.
7. Treat `state: "applied"` as success, `"pending"` as not ready, and `"error"` as failure.
8. On failure, call `tldraw_script_error_log`, fix the source, and verify once.

Virtual writable paths are only `script/**` and `assets/**`. Approved generated context is available through `.tooling/**` but is read-only. Never attempt to access archive files, SQLite files, metadata, lock files, or arbitrary Mac paths.

Document scripts may use top-level imports from `tldraw`, `react`, and `react-dom`. Other bare package specifiers are unavailable. `main.js` runs after mount. `config.js` runs before editor creation and is required for custom shape types, tools, overlays, and UI components. `config.js` and `main.js` are separate module graphs.

For editable furniture with script-owned internals:

- use stable IDs and `helpers.createShapeIfMissing` / `createShapesIfMissing`;
- preserve user-facing shapes on rerun;
- react to one visible anchor with `helpers.onShapeTranslate`;
- move internals with `helpers.translateShapes`;
- perform script-owned writes with ignored history;
- avoid broad store listeners that recurse on the script's own changes.

## Screenshots

`tldraw_screenshot` returns the JPEG inline. Use `mode: "canvas"` for shapes and `mode: "window"` for UI chrome, custom panels, or component overrides. Prefer records for inspection and screenshots only for visual uncertainty or requested proof.

## Reporting

Keep the final report concise: include document ID/name, changed shape IDs or virtual script paths, and one verification result. For failures, quote the MCP error, script state, or relevant error-log line.
