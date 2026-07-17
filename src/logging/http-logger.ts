import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

interface JsonRpcMessageSummary {
  id?: string | number | null
  method?: string
  paramKeys?: string[]
  protocolVersion?: string
  clientInfo?: { name?: string; version?: string }
  capabilityKeys?: string[]
  toolName?: string
  argumentKeys?: string[]
}

interface McpBodySummary {
  batch?: boolean
  messageCount?: number
  messages?: JsonRpcMessageSummary[]
  parseError?: true
}

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now()
    const requestId = c.req.header('x-request-id') || randomUUID()
    const isMcp = c.req.path === '/mcp'
    const mcp = isMcp ? await summarizeMcpBody(c.req.raw) : undefined

    c.header('x-request-id', requestId)
    writeLog({
      level: 'info',
      event: isMcp ? 'mcp.request' : 'http.request',
      message: isMcp ? 'MCP request received' : 'HTTP request received',
      requestId,
      method: c.req.method,
      path: c.req.path,
      host: c.req.header('host'),
      contentType: c.req.header('content-type'),
      contentLength: numberHeader(c.req.header('content-length')),
      accept: c.req.header('accept'),
      userAgent: c.req.header('user-agent'),
      forwardedFor: c.req.header('x-forwarded-for'),
      sessionMode: isMcp ? 'stateless' : undefined,
      sessionId: isMcp ? c.req.header('mcp-session-id') ?? null : undefined,
      protocolVersion: isMcp ? c.req.header('mcp-protocol-version') ?? null : undefined,
      lastEventId: isMcp ? c.req.header('last-event-id') ?? null : undefined,
      rpc: mcp,
    })

    try {
      await next()
    } finally {
      writeLog({
        level: 'info',
        event: isMcp ? 'mcp.response' : 'http.response',
        message: isMcp ? 'MCP response sent' : 'HTTP response sent',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        sessionMode: isMcp ? 'stateless' : undefined,
        sessionId: isMcp ? c.res.headers.get('mcp-session-id') : undefined,
        contentType: c.res.headers.get('content-type'),
      })
    }
  }
}

export async function summarizeMcpBody(request: Request): Promise<McpBodySummary | undefined> {
  if (request.method !== 'POST') return undefined

  try {
    const payload: unknown = await request.clone().json()
    const values = Array.isArray(payload) ? payload : [payload]
    return {
      batch: Array.isArray(payload),
      messageCount: values.length,
      messages: values.map(summarizeJsonRpcMessage),
    }
  } catch {
    return { parseError: true }
  }
}

function summarizeJsonRpcMessage(value: unknown): JsonRpcMessageSummary {
  if (!isRecord(value)) return {}

  const method = typeof value.method === 'string' ? value.method : undefined
  const params = isRecord(value.params) ? value.params : undefined
  const summary: JsonRpcMessageSummary = {
    id: typeof value.id === 'string' || typeof value.id === 'number' || value.id === null ? value.id : undefined,
    method,
    paramKeys: params ? Object.keys(params) : undefined,
  }

  if (method === 'initialize' && params) {
    summary.protocolVersion = stringValue(params.protocolVersion)
    if (isRecord(params.clientInfo)) {
      summary.clientInfo = {
        name: stringValue(params.clientInfo.name),
        version: stringValue(params.clientInfo.version),
      }
    }
    if (isRecord(params.capabilities)) summary.capabilityKeys = Object.keys(params.capabilities)
  }

  if (method === 'tools/call' && params) {
    summary.toolName = stringValue(params.name)
    if (isRecord(params.arguments)) summary.argumentKeys = Object.keys(params.arguments)
  }

  return summary
}

function writeLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }))
}

function numberHeader(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
