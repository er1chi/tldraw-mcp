import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AppConfig } from '../config.ts'

export function securityMiddleware(config: AppConfig): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const host = hostname(c.req.header('host') ?? new URL(c.req.url).host)
    if (!host || !config.allowedHosts.includes(host)) return c.json({ error: 'Host not allowed' }, 403)

    const origin = c.req.header('origin')
    if (origin) {
      let originHost: string
      try {
        originHost = new URL(origin).hostname.toLowerCase()
      } catch {
        return c.json({ error: 'Origin not allowed' }, 403)
      }
      if (!config.allowedHosts.includes(originHost)) return c.json({ error: 'Origin not allowed' }, 403)
    }

    const contentLength = c.req.header('content-length')
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength)) return c.json({ error: 'Invalid Content-Length' }, 400)
      if (decimalExceeds(contentLength, config.maxRequestBytes)) {
        return c.json({ error: 'Request body too large' }, 413)
      }
    }
    await next()
  }
}

/**
 * Reads and rebuilds the request body so downstream consumers can never read more than maxBytes.
 * This must be mounted after authentication and before logging or protocol parsing.
 */
export function requestBodyLimit(maxBytes: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const body = c.req.raw.body
    if (!body) {
      await next()
      return
    }

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return c.json({ error: 'Request body too large' }, 413)
        }
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      throw error
    }

    const requestInit: RequestInit & { duplex: 'half' } = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
      duplex: 'half',
    }
    c.req.raw = new Request(c.req.raw, requestInit)
    await next()
  }
}

export function bearerAuth(config: AppConfig): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const header = c.req.header('authorization') ?? ''
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!safeEqual(supplied, config.mcpToken)) {
      c.header('WWW-Authenticate', 'Bearer realm="tldraw-offline-mcp"')
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function decimalExceeds(value: string, maximum: number): boolean {
  const normalized = value.replace(/^0+/, '') || '0'
  const limit = String(maximum)
  return normalized.length > limit.length || (normalized.length === limit.length && normalized > limit)
}

function hostname(host: string | undefined): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}
