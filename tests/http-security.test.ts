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

  test('rejects an unapproved host before authentication', async () => {
    const response = await app.request('http://evil.example/healthz', { headers: { host: 'evil.example' } })
    expect(response.status).toBe(403)
  })
})
