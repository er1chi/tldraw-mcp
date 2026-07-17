import { describe, expect, test } from 'bun:test'
import { summarizeMcpBody } from '../src/logging/http-logger.ts'

describe('MCP request logging', () => {
  test('summarizes initialize metadata without logging complete params', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'test-client', version: '1.2.3' },
          capabilities: { roots: {}, sampling: {} },
        },
      }),
    })

    expect(await summarizeMcpBody(request)).toEqual({
      batch: false,
      messageCount: 1,
      messages: [
        {
          id: 1,
          method: 'initialize',
          paramKeys: ['protocolVersion', 'clientInfo', 'capabilities'],
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'test-client', version: '1.2.3' },
          capabilityKeys: ['roots', 'sampling'],
        },
      ],
    })
  })

  test('logs tool and argument names but not argument values', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: { name: 'tldraw_exec', arguments: { documentId: 'secret-doc', code: 'secret-code' } },
      }),
    })

    const summary = await summarizeMcpBody(request)
    expect(summary?.messages?.[0]).toEqual({
      id: 'call-1',
      method: 'tools/call',
      paramKeys: ['name', 'arguments'],
      toolName: 'tldraw_exec',
      argumentKeys: ['documentId', 'code'],
    })
    expect(JSON.stringify(summary)).not.toContain('secret-doc')
    expect(JSON.stringify(summary)).not.toContain('secret-code')
  })
})
