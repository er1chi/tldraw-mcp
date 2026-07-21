import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { AppConfig } from "./config.ts";
import { requestLogger } from "./logging/http-logger.ts";
import { createMcpServer } from "./mcp/create-server.ts";
import { bearerAuth, securityMiddleware } from "./security/http-security.ts";
import { CanvasApiClient } from "./tldraw/canvas-api-client.ts";
import { ScreenshotService } from "./tldraw/screenshot-service.ts";
import { WorkspaceService } from "./tldraw/workspace-service.ts";

export function createApp(config: AppConfig): Hono {
  const canvas = new CanvasApiClient(config);
  const workspace = new WorkspaceService(canvas, config);
  const screenshots = new ScreenshotService(canvas, config);
  const services = { canvas, workspace, screenshots };

  const app = new Hono();
  app.use("*", requestLogger());
  app.use("*", securityMiddleware(config));

  app.get("/healthz", (c) =>
    c.json({ status: "ok", service: "tldraw-offline-mcp" }),
  );

  app.use("/readyz", bearerAuth(config));
  app.get("/readyz", async (c) => {
    try {
      return c.json({
        status: "ready",
        app: await canvas.readiness(c.req.raw.signal),
      });
    } catch (error) {
      return c.json(
        {
          status: "not-ready",
          reason: error instanceof Error ? error.message : String(error),
        },
        503,
      );
    }
  });

  app.use("/mcp", bearerAuth(config));
  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Tools such as script application may run for several seconds. A single JSON response
      // avoids replaying a long-running POST when an SSE connection is interrupted.
      enableJsonResponse: true,
    });
    const server = createMcpServer(services);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error(
      JSON.stringify({
        level: "error",
        requestId: c.req.header("x-request-id"),
        path: c.req.path,
        message: error.message,
      }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}
