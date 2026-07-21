import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/create-server.ts'
import type { CanvasApiClient } from '../src/tldraw/canvas-api-client.ts'
import type { ScreenshotService } from '../src/tldraw/screenshot-service.ts'
import type { WorkspaceService } from '../src/tldraw/workspace-service.ts'

let client: Client
let closeServer: () => Promise<void>

beforeEach(async () => {
  const canvas = {
    readiness: async () => ({ running: true, port: 7236 }),
    search: async (code: string) =>
      code === 'return { answer: 42 }'
        ? { answer: 42 }
        : code.includes('getShapes')
          ? { document: { id: 'doc:test', name: 'Test' }, total: 1, shapes: [{ id: 'shape:test', type: 'geo' }] }
          : code.includes('getDocs')
            ? [{ id: 'doc:test' }]
            : null,
  } as unknown as CanvasApiClient
  const workspace = {} as WorkspaceService
  const screenshots = {
    capture: async () => ({ data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg', metadata: { width: 1, height: 1 } }),
  } as unknown as ScreenshotService

  const server = createMcpServer({ canvas, workspace, screenshots })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  closeServer = () => server.close()
})

afterEach(async () => {
  await client.close()
  await closeServer()
})

describe('MCP contract', () => {
  test('advertises the complete core tool surface', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('tldraw_doc_inspect')
    expect(names).toContain('tldraw_search')
    expect(names).toContain('tldraw_exec')
    expect(names).toContain('tldraw_screenshot')
    expect(names).toContain('tldraw_workspace_apply')
    expect(names).toContain('tldraw_script_error_log')
    expect(names).not.toContain('tldraw_doc_focused')
    expect(names).not.toContain('tldraw_doc_shapes')
    expect(names).not.toContain('tldraw_doc_bindings')
    expect(names.length).toBe(19)
  })

  test('selects and inspects the focused document with one portable text result', async () => {
    const result = await client.callTool({ name: 'tldraw_doc_inspect', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toBeUndefined()
    const content = result.content as Array<{ type: string; text?: string }>
    const text = content[0]?.type === 'text' ? (content[0].text ?? '') : ''
    expect(JSON.parse(text)).toEqual({
      document: { id: 'doc:test', name: 'Test' },
      total: 1,
      shapes: [{ id: 'shape:test', type: 'geo' }],
    })
    expect(text.match(/shape:test/g)).toHaveLength(1)
  })

  test('returns search data directly without requiring thrown errors', async () => {
    const result = await client.callTool({ name: 'tldraw_search', arguments: { code: 'return { answer: 42 }' } })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual({ answer: 42 })
  })

  test('exposes the operator guide as a resource', async () => {
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain('tldraw://guide')
    const guide = await client.readResource({ uri: 'tldraw://guide' })
    const content = guide.contents[0]
    expect(content && 'text' in content ? content.text : '').toContain('Choose the correct workflow')
  })
})
