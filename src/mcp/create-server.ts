import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CanvasApiClient } from '../tldraw/canvas-api-client.ts'
import type { ScreenshotService } from '../tldraw/screenshot-service.ts'
import type { WorkspaceChange, WorkspaceService } from '../tldraw/workspace-service.ts'
import { image, ok, safely } from './results.ts'

const GUIDE_PATH = resolve(import.meta.dir, '../../operator-guide/guide.md')
const GUIDE = readFileSync(GUIDE_PATH, 'utf8')

export interface McpServices {
  canvas: CanvasApiClient
  workspace: WorkspaceService
  screenshots: ScreenshotService
}

const readOnly = { readOnlyHint: true } as const
const mutating = { readOnlyHint: false, destructiveHint: true } as const

export function createMcpServer(services: McpServices): McpServer {
  const { canvas, workspace, screenshots } = services
  const server = new McpServer(
    { name: 'tldraw-offline', version: '0.1.0' },
    {
      instructions:
        'Control the Mac-hosted tldraw Desktop app. Inspect before mutating. Use tldraw_exec for static edits and workspace tools for durable behavior. Use bound arrows for meaningful connections, run tldraw_lint before completion, and verify once. Never overwrite a non-default script before reading it and retaining its SHA-256.',
    },
  )

  server.registerTool(
    'tldraw_health',
    { description: 'Check whether the Mac-hosted tldraw Canvas API is available. Never returns its secret token.', annotations: readOnly },
    async (_extra) =>
      safely(async () => {
        try {
          const app = await canvas.readiness(_extra.signal)
          const docs = await canvas.search<unknown[]>('return await api.getDocs()', _extra.signal)
          return ok({ running: true, app, openDocumentCount: docs.length })
        } catch (error) {
          return ok({ running: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }),
  )

  server.registerTool(
    'tldraw_docs_list',
    {
      description: 'List open tldraw documents in focus-recency order, optionally filtering by file name.',
      inputSchema: z.object({ name: z.string().min(1).optional() }),
      annotations: readOnly,
    },
    async ({ name }, extra) =>
      safely(async () => ok(await canvas.search(`return await api.getDocs(${name ? JSON.stringify({ name }) : ''})`, extra.signal))),
  )

  server.registerTool(
    'tldraw_doc_focused',
    { description: 'Return the most recently focused tldraw document, or null.', annotations: readOnly },
    async (extra) => safely(async () => ok(await canvas.search('return await api.getFocusedDoc()', extra.signal))),
  )

  server.registerTool(
    'tldraw_doc_shapes',
    {
      description: 'Read current-page metadata, viewport, and raw shape records for one document with pagination.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(5000).default(500),
        detail: z.enum(['full', 'summary']).default('full'),
      }),
      annotations: readOnly,
    },
    async ({ documentId, offset, limit, detail }, extra) =>
      safely(async () => {
        const code = `const data = await api.getShapes(${JSON.stringify(documentId)}); const all = data.shapes ?? []; const page = all.slice(${offset}, ${offset + limit}); return { page: data.page, viewport: data.viewport, total: all.length, offset: ${offset}, limit: ${limit}, shapes: ${detail === 'full' ? 'page' : "page.map(s => ({ id: s.id, type: s.type, x: s.x, y: s.y, rotation: s.rotation, parentId: s.parentId, props: s.props, meta: s.meta }))"} }`
        return ok(await canvas.search(code, extra.signal))
      }),
  )

  server.registerTool(
    'tldraw_doc_bindings',
    {
      description: 'Read raw binding records for a document. Use this to verify meaningful arrows are truly bound.',
      inputSchema: z.object({ documentId: z.string().min(1), shapeId: z.string().min(1).optional() }),
      annotations: readOnly,
    },
    async ({ documentId, shapeId }, extra) =>
      safely(async () => {
        const code = `const bindings = await api.getBindings(${JSON.stringify(documentId)}); return ${shapeId ? `bindings.filter(b => b.fromId === ${JSON.stringify(shapeId)} || b.toId === ${JSON.stringify(shapeId)})` : 'bindings'}`
        return ok(await canvas.search(code, extra.signal))
      }),
  )

  server.registerTool(
    'tldraw_reference_search',
    {
      description: 'Search the tldraw Editor API reference by member name, category, or free text.',
      inputSchema: z.object({
        query: z.string().default(''),
        category: z.string().optional(),
        exactName: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: readOnly,
    },
    async ({ query, category, exactName, offset, limit }, extra) =>
      safely(async () => {
        const code = `const q=${JSON.stringify(query.toLowerCase())}, category=${JSON.stringify(category ?? null)}, exact=${JSON.stringify(exactName ?? null)}; const matches=api.members.filter(m => (!exact || m.name === exact) && (!category || m.category === category) && (!q || JSON.stringify(m).toLowerCase().includes(q))); return { memberCount: api.memberCount, categories: api.categories, total: matches.length, offset: ${offset}, members: matches.slice(${offset}, ${offset + limit}) }`
        return ok(await canvas.search(code, extra.signal))
      }),
  )

  server.registerTool(
    'tldraw_imports_search',
    {
      description: 'Search modules and symbols importable by exec snippets and durable document scripts.',
      inputSchema: z.object({ query: z.string().default(''), module: z.string().optional(), kind: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) }),
      annotations: readOnly,
    },
    async ({ query, module, kind, limit }, extra) =>
      safely(async () => {
        const code = `const q=${JSON.stringify(query.toLowerCase())}, mod=${JSON.stringify(module ?? null)}, kind=${JSON.stringify(kind ?? null)}; const modules=api.imports.filter(m => !mod || m.module === mod).map(m => ({...m, exports: (m.exports ?? []).filter(e => (!kind || e.kind === kind) && (!q || e.name.toLowerCase().includes(q))).slice(0, ${limit})})); return { importCount: api.importCount, modules }`
        return ok(await canvas.search(code, extra.signal))
      }),
  )

  server.registerTool(
    'tldraw_helpers_list',
    { description: 'Return documentation for all editor-bound helper functions available in exec and scripts.', annotations: readOnly },
    async (extra) => safely(async () => ok(await canvas.search('return { helperCount: api.helperCount, helpers: api.helpers }', extra.signal))),
  )

  server.registerTool(
    'tldraw_recipes_list',
    { description: 'List all tldraw operator recipes by id, title, and intended use.', annotations: readOnly },
    async (extra) =>
      safely(async () =>
        ok(await canvas.search("return Object.values(api.recipes).map(({id,title,whenToUse}) => ({id,title,whenToUse}))", extra.signal)),
      ),
  )

  server.registerTool(
    'tldraw_recipe_get',
    {
      description: 'Read one complete operator recipe before implementing matching durable behavior.',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ id }, extra) => safely(async () => ok(await canvas.search(`return api.recipes[${JSON.stringify(id)}] ?? null`, extra.signal))),
  )

  server.registerTool(
    'tldraw_readme',
    { description: 'Read the live Canvas API documentation from the running tldraw app.', annotations: readOnly },
    async (extra) => safely(async () => ok({ readme: await canvas.readme(extra.signal) })),
  )

  server.registerTool(
    'tldraw_search',
    {
      description: 'Execute arbitrary JavaScript against the Canvas API `api` object. Top-level await works. Return JSON-serializable data.',
      inputSchema: z.object({ code: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ code }, extra) => safely(async () => ok(await canvas.search(code, extra.signal))),
  )

  server.registerTool(
    'tldraw_exec',
    {
      description: 'Execute arbitrary JavaScript against one live editor with `editor`, `helpers`, `signal`, and `app`. Use for saved static canvas edits and targeted inspection.',
      inputSchema: z.object({ documentId: z.string().min(1), code: z.string().min(1) }),
      annotations: mutating,
    },
    async ({ documentId, code }, extra) => safely(async () => ok(await canvas.exec(documentId, code, extra.signal))),
  )

  server.registerTool(
    'tldraw_lint',
    {
      description: 'Run the tldraw canvas linter on the current page. Address every actionable result before reporting completion.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ documentId }, extra) => safely(async () => ok(await canvas.exec(documentId, 'return helpers.getLints()', extra.signal))),
  )

  server.registerTool(
    'tldraw_screenshot',
    {
      description: 'Capture a canvas-only or full-window JPEG and return it inline as MCP image content with metadata.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        mode: z.enum(['canvas', 'window']).default('canvas'),
        size: z.enum(['small', 'medium', 'large', 'full']).default('small'),
        bounds: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(),
      }),
      annotations: readOnly,
    },
    async ({ documentId, mode, size, bounds }, extra) =>
      safely(async () => {
        const result = await screenshots.capture(documentId, { mode, size, bounds }, extra.signal)
        return image(result.data, result.mimeType, result.metadata)
      }),
  )

  server.registerTool(
    'tldraw_workspace_open',
    {
      description: 'Initialize and inspect a document script workspace using virtual paths. Read non-default scripts before editing.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ documentId }, extra) => safely(async () => ok(await workspace.open(documentId, extra.signal))),
  )

  server.registerTool(
    'tldraw_workspace_list',
    {
      description: 'List script/assets and approved read-only tooling files with SHA-256 hashes.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ documentId }, extra) => safely(async () => ok(await workspace.list(documentId, extra.signal))),
  )

  server.registerTool(
    'tldraw_workspace_read',
    {
      description: 'Read an approved virtual workspace file as UTF-8 or base64. Returns its SHA-256 for safe subsequent edits.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        path: z.string().min(1),
        encoding: z.enum(['utf8', 'base64']).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).optional(),
      }),
      annotations: readOnly,
    },
    async ({ documentId, path, encoding, offset, limit }, extra) =>
      safely(async () => ok(await workspace.read(documentId, path, { encoding, offset, limit }, extra.signal))),
  )

  const changeSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('write_text'), path: z.string().min(1), content: z.string(), expectedSha256: z.string().length(64).optional() }),
    z.object({
      op: z.literal('edit_text'),
      path: z.string().min(1),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1),
      expectedSha256: z.string().length(64),
    }),
    z.object({ op: z.literal('write_base64'), path: z.string().min(1), data: z.string(), expectedSha256: z.string().length(64).optional() }),
    z.object({ op: z.literal('delete'), path: z.string().min(1), expectedSha256: z.string().length(64) }),
  ])

  server.registerTool(
    'tldraw_workspace_apply',
    {
      description: 'Apply a validated batch of script/asset writes, exact edits, binary writes, and deletes, then return the current watcher status.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        changes: z.array(changeSchema).min(1).max(100),
      }),
      annotations: mutating,
    },
    async ({ documentId, changes }, extra) =>
      safely(async () => ok(await workspace.apply(documentId, changes as WorkspaceChange[], extra.signal))),
  )

  server.registerTool(
    'tldraw_script_status',
    {
      description: 'Read the current document-script watcher status.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ documentId }, extra) => safely(async () => ok(await workspace.status(documentId, extra.signal))),
  )

  server.registerTool(
    'tldraw_script_error_log',
    {
      description: 'Read the current document-script runtime/apply error log without exposing its Mac path.',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      annotations: readOnly,
    },
    async ({ documentId }, extra) => safely(async () => ok(await workspace.errorLog(documentId, extra.signal))),
  )

  server.registerResource(
    'tldraw-operator-guide',
    'tldraw://guide',
    { title: 'tldraw offline MCP operator guide', description: 'Canonical workflow and safety guidance', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }),
  )

  server.registerResource(
    'tldraw-live-readme',
    'tldraw://readme',
    { title: 'Live tldraw Canvas API readme', description: 'Documentation from the currently running app', mimeType: 'text/markdown' },
    async (uri, extra) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await canvas.readme(extra.signal) }] }),
  )

  return server
}
