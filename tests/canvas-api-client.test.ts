import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../src/config.ts'
import { CanvasApiClient } from '../src/tldraw/canvas-api-client.ts'

function config(tldrawServerJson: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 7237,
    mcpToken: 'secret-token-that-is-at-least-32-characters',
    allowedHosts: ['localhost', '127.0.0.1'],
    tldrawServerJson,
    requestTimeoutMs: 1000,
    idleTimeoutSeconds: 255,
    maxRequestBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    maxImageBytes: 1024 * 1024,
  }
}

describe('CanvasApiClient server sessions', () => {
  test('uses the server session loaded at initialization for successful requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-api-client-test-'))
    const serverJson = join(directory, 'server.json')
    const token = 'initial-canvas-token'
    const authorizations: Array<string | null> = []
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get('authorization'))
        return Response.json({ success: true, result: true })
      },
    })
    const upstreamPort = upstream.port
    if (upstreamPort === undefined) throw new Error('Test server did not bind a port')

    try {
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token, pid: 10, startedAt: 20 }))
      const client = new CanvasApiClient(config(serverJson), () => {})
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token: 'token-that-must-not-be-read' }))

      await expect(client.search('return true')).resolves.toBe(true)
      await expect(client.search('return true')).resolves.toBe(true)
      expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`])
    } finally {
      await upstream.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('refreshes server.json and retries after the cached token is rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-api-client-test-'))
    const serverJson = join(directory, 'server.json')
    const oldToken = 'old-canvas-token'
    const newToken = 'new-canvas-token'
    const authorizations: Array<string | null> = []
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const authorization = request.headers.get('authorization')
        authorizations.push(authorization)
        return authorization === `Bearer ${newToken}`
          ? Response.json({ success: true, result: true })
          : new Response('Unauthorized', { status: 401 })
      },
    })
    const upstreamPort = upstream.port
    if (upstreamPort === undefined) throw new Error('Test server did not bind a port')

    try {
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token: oldToken, pid: 10, startedAt: 20 }))
      const logs: Array<Record<string, unknown>> = []
      const client = new CanvasApiClient(config(serverJson), (entry) => logs.push(entry))
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token: newToken, pid: 11, startedAt: 21 }))

      await expect(client.search('return true')).resolves.toBe(true)
      expect(authorizations).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`])
      expect(logs.find((entry) => entry.event === 'canvas.request.unauthorized')).toMatchObject({
        status: 401,
        willRetry: true,
      })
      expect(logs.find((entry) => entry.event === 'canvas.session.refreshed')).toMatchObject({
        portChanged: false,
        pidChanged: true,
        startedAtChanged: true,
        tokenChanged: true,
      })
      expect(JSON.stringify(logs)).not.toContain(oldToken)
      expect(JSON.stringify(logs)).not.toContain(newToken)
    } finally {
      await upstream.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('refreshes server.json and retries after the cached port becomes stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-api-client-test-'))
    const serverJson = join(directory, 'server.json')
    const stale = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stale') })
    const newToken = 'new-canvas-token'
    const authorizations: Array<string | null> = []
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get('authorization'))
        return Response.json({ success: true, result: true })
      },
    })
    const stalePort = stale.port
    const upstreamPort = upstream.port
    if (stalePort === undefined || upstreamPort === undefined) throw new Error('Test server did not bind a port')

    try {
      await writeFile(serverJson, JSON.stringify({ port: stalePort, token: 'stale-token', pid: 10, startedAt: 20 }))
      const logs: Array<Record<string, unknown>> = []
      const client = new CanvasApiClient(config(serverJson), (entry) => logs.push(entry))
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token: newToken, pid: 11, startedAt: 21 }))
      await stale.stop(true)

      await expect(client.search('return true')).resolves.toBe(true)
      expect(authorizations).toEqual([`Bearer ${newToken}`])
      expect(logs.find((entry) => entry.event === 'canvas.session.unreachable')).toMatchObject({ willRetry: true })
      expect(logs.find((entry) => entry.event === 'canvas.session.refreshed')).toMatchObject({
        previousSession: { port: stalePort, pid: 10, startedAt: 20 },
        currentSession: { port: upstreamPort, pid: 11, startedAt: 21 },
        portChanged: true,
        pidChanged: true,
        startedAtChanged: true,
        tokenChanged: true,
      })
    } finally {
      await stale.stop(true)
      await upstream.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reports an unchanged unreachable session as stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-api-client-test-'))
    const serverJson = join(directory, 'server.json')
    const stale = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stale') })
    const stalePort = stale.port
    if (stalePort === undefined) throw new Error('Test server did not bind a port')

    try {
      await writeFile(serverJson, JSON.stringify({ port: stalePort, token: 'stale-token', pid: 10, startedAt: 20 }))
      const client = new CanvasApiClient(config(serverJson), () => {})
      await stale.stop(true)

      await expect(client.search('return true')).rejects.toMatchObject({
        code: 'APP_NOT_RUNNING',
        message: 'tldraw is not running: the server.json session is stale',
      })
    } finally {
      await stale.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
