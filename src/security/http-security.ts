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

    const contentLength = Number.parseInt(c.req.header('content-length') ?? '0', 10)
    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBytes) {
      return c.json({ error: 'Request body too large' }, 413)
    }
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

function hostname(host: string | undefined): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}
