import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppConfig {
  host: string
  port: number
  mcpToken: string
  allowedHosts: string[]
  tldrawServerJson: string
  requestTimeoutMs: number
  idleTimeoutSeconds: number
  maxRequestBytes: number
  maxResultBytes: number
  maxFileBytes: number
  maxImageBytes: number
}

function integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`)
  }
  return parsed
}

function token(): string {
  const value = process.env.TLDRAW_MCP_TOKEN?.trim()
  if (!value) {
    throw new Error('TLDRAW_MCP_TOKEN is required. Generate one with `bun run token`.')
  }
  if (value.length < 32) throw new Error('TLDRAW_MCP_TOKEN must contain at least 32 characters')
  return value
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.TLDRAW_MCP_HOST ?? '127.0.0.1',
    port: integer('TLDRAW_MCP_PORT', 7237),
    mcpToken: token(),
    allowedHosts: (process.env.TLDRAW_MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    tldrawServerJson:
      process.env.TLDRAW_SERVER_JSON ?? join(homedir(), 'Library', 'Application Support', 'tldraw', 'server.json'),
    requestTimeoutMs: integer('TLDRAW_MCP_REQUEST_TIMEOUT_MS', 30_000),
    idleTimeoutSeconds: integer('TLDRAW_MCP_IDLE_TIMEOUT_SECONDS', 255, 255),
    maxRequestBytes: integer('TLDRAW_MCP_MAX_REQUEST_BYTES', 25 * 1024 * 1024),
    maxResultBytes: integer('TLDRAW_MCP_MAX_RESULT_BYTES', 5 * 1024 * 1024),
    maxFileBytes: integer('TLDRAW_MCP_MAX_FILE_BYTES', 20 * 1024 * 1024),
    maxImageBytes: integer('TLDRAW_MCP_MAX_IMAGE_BYTES', 20 * 1024 * 1024),
  }
}
