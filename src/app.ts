import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { AppConfig } from "./config.ts";
import { requestLogger } from "./logging/http-logger.ts";
import { createMcpServer } from "./mcp/create-server.ts";
import {
  bearerAuth,
  requestBodyLimit,
  securityMiddleware,
} from "./security/http-security.ts";
import { CanvasApiClient } from "./tldraw/canvas-api-client.ts";
import { DocumentInspectionService } from "./tldraw/document-inspection-service.ts";
import { ScreenshotService } from "./tldraw/screenshot-service.ts";
import { StaticMaterialService } from "./tldraw/static-material-service.ts";
import { WorkspaceService } from "./tldraw/workspace-service.ts";

export function createApp(config: AppConfig): Hono {
  const canvas = new CanvasApiClient(config);
  const documents = new DocumentInspectionService(canvas);
  const workspace = new WorkspaceService(canvas, config);
  const screenshots = new ScreenshotService(canvas, config);
  const staticMaterial = new StaticMaterialService(canvas);
  const services = { canvas, documents, workspace, screenshots, staticMaterial };

  const app = new Hono();
  app.use("*", securityMiddleware(config));
  app.use("/readyz", bearerAuth(config));
  app.use("/mcp", bearerAuth(config));
  app.use("/mcp", requestBodyLimit(config.maxRequestBytes));
  app.use("*", requestLogger());

  app.get("/healthz", (c) =>
    c.json({ status: "ok", service: "tldraw-offline-mcp" }),
  );

  app.get("/readyz", async (c) => {
    try {
      await canvas.search("return true", c.req.raw.signal);
      return c.json({ status: "ready" });
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
