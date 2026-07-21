import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage, TldrawMcpError } from '../tldraw/errors.ts'

/**
 * MCP hosts do not consistently expose structuredContent to the model. Keep one canonical,
 * portable representation in text content rather than duplicating large results across both fields.
 */
export function ok(data: unknown, summary?: string): CallToolResult {
  const text = stringify(data)
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n${text}` : text }],
  }
}

export function image(data: string, mimeType: string, metadata: unknown): CallToolResult {
  return {
    content: [
      { type: 'text', text: stringify(metadata) },
      { type: 'image', data, mimeType },
    ],
  }
}

export async function safely(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    const payload =
      error instanceof TldrawMcpError
        ? { code: error.code, message: error.message, details: error.details }
        : { code: 'INTERNAL_ERROR', message: errorMessage(error) }
    return {
      content: [{ type: 'text', text: stringify(payload) }],
      isError: true,
    }
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return 'null'
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2) ?? 'null'
}
