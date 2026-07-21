import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.TLDRAW_MCP_URL ?? 'http://127.0.0.1:7237/mcp'
const token = process.env.TLDRAW_MCP_TOKEN
if (!token) throw new Error('TLDRAW_MCP_TOKEN is required')

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
})
const client = new Client({ name: 'tldraw-offline-smoke', version: '1.0.0' })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const health = await client.callTool({ name: 'tldraw_health', arguments: {} })
  const inspected = await client.callTool({ name: 'tldraw_doc_inspect', arguments: { detail: 'summary', limit: 10 } })
  console.log(JSON.stringify({ url, toolCount: tools.tools.length, health: health.content, inspected: inspected.content }, null, 2))
} finally {
  await client.close()
}
