import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage, TldrawMcpError } from '../tldraw/errors.ts'

export function ok(data: unknown, summary?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary ?? stringify(data) }],
    structuredContent: { result: normalize(data) },
  }
}

export function image(data: string, mimeType: string, metadata: unknown): CallToolResult {
  return {
    content: [
      { type: 'text', text: stringify(metadata) },
      { type: 'image', data, mimeType },
    ],
    structuredContent: { result: normalize(metadata) },
  }
}

export async function safely(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    const payload =
      error instanceof TldrawMcpError
        ? { code: error.code, message: error.message, details: normalize(error.details) }
        : { code: 'INTERNAL_ERROR', message: errorMessage(error) }
    return {
      content: [{ type: 'text', text: stringify(payload) }],
      structuredContent: { error: payload },
      isError: true,
    }
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(normalize(value), null, 2)
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)))
}
