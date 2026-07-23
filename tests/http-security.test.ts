import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../src/config.ts'
import { createApp } from '../src/app.ts'

const config: AppConfig = {
  host: '127.0.0.1',
  port: 7237,
  mcpToken: 'secret-token-that-is-at-least-32-characters',
  allowedHosts: ['localhost', '127.0.0.1'],
  tldrawServerJson: '/does/not/exist',
  requestTimeoutMs: 1000,
  idleTimeoutSeconds: 255,
  maxRequestBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxImageBytes: 1024 * 1024,
}

const authenticatedHeaders = { authorization: `Bearer ${config.mcpToken}` }

describe('HTTP security', () => {
  const app = createApp(config)

  test('serves minimal liveness without authentication', async () => {
    const response = await app.request('http://localhost/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', service: 'tldraw-offline-mcp' })
  })

  test('requires bearer authentication for MCP and readiness', async () => {
    expect((await app.request('http://localhost/mcp', { method: 'POST' })).status).toBe(401)
    expect((await app.request('http://localhost/readyz')).status).toBe(401)
  })

  test('does not read an unauthenticated MCP request body', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array([123, 125]))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const response = await app.fetch(request)

    expect(response.status).toBe(401)
    expect(pulls).toBe(0)
  })

  test('rejects an incorrect bearer token', async () => {
    const headers = { authorization: 'Bearer incorrect-token-that-is-at-least-32-characters' }

    expect((await app.request('http://localhost/mcp', { method: 'POST', headers })).status).toBe(401)
    expect((await app.request('http://localhost/readyz', { headers })).status).toBe(401)
  })

  test('enforces the actual MCP body size without trusting Content-Length', async () => {
    const limitedApp = createApp({ ...config, maxRequestBytes: 64 })
    const oversizedBody = JSON.stringify({ value: 'x'.repeat(128) })

    const missingLength = await limitedApp.request('http://localhost/mcp', {
      method: 'POST',
      headers: authenticatedHeaders,
      body: oversizedBody,
    })
    const understatedLength = await limitedApp.request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...authenticatedHeaders, 'content-length': '1' },
      body: oversizedBody,
    })

    expect(missingLength.status).toBe(413)
    expect(understatedLength.status).toBe(413)
  })

  test('rejects malformed Content-Length headers', async () => {
    const response = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...authenticatedHeaders, 'content-length': 'not-a-number' },
      body: '{}',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid Content-Length' })
  })

  test('accepts the correct bearer token for MCP requests', async () => {
    const response = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        ...authenticatedHeaders,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-security-test', version: '1.0.0' },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'tldraw-offline', version: '0.1.0' } },
    })
  })

  test('reports readiness with valid MCP and Canvas API tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tldraw-offline-mcp-test-'))
    const serverJson = join(directory, 'server.json')
    const canvasToken = 'canvas-api-test-token'
    const receivedAuthorizations: Array<string | null> = []
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const authorization = request.headers.get('authorization')
        receivedAuthorizations.push(authorization)
        if (authorization !== `Bearer ${canvasToken}`) return new Response('Unauthorized', { status: 401 })
        return Response.json({ success: true, result: true })
      },
    })

    try {
      await writeFile(serverJson, JSON.stringify({ port: upstream.port, token: canvasToken }))
      const readyApp = createApp({ ...config, tldrawServerJson: serverJson })
      const response = await readyApp.request('http://localhost/readyz', { headers: authenticatedHeaders })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ready' })
      expect(receivedAuthorizations).toEqual([`Bearer ${canvasToken}`])
    } finally {
      await upstream.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects an unapproved host before authentication', async () => {
    const response = await app.request('http://evil.example/healthz', { headers: { host: 'evil.example' } })
    expect(response.status).toBe(403)
  })
})
