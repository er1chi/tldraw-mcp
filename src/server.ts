import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()
const app = createApp(config)

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: config.idleTimeoutSeconds,
  fetch: app.fetch,
})

console.log(
  JSON.stringify({
    level: 'info',
    message: 'tldraw-offline MCP server listening',
    url: server.url.toString(),
    mcp: new URL('/mcp', server.url).toString(),
    idleTimeoutSeconds: config.idleTimeoutSeconds,
  }),
)

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }))
  void server.stop(true).then(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
