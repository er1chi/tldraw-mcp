import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import { CanvasApiClient } from "../src/tldraw/canvas-api-client.ts";
import { StaticMaterialService } from "../src/tldraw/static-material-service.ts";

function config(tldrawServerJson: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 7237,
    mcpToken: "secret-token-that-is-at-least-32-characters",
    allowedHosts: ["localhost", "127.0.0.1"],
    tldrawServerJson,
    requestTimeoutMs: 1000,
    idleTimeoutSeconds: 255,
    maxRequestBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    maxImageBytes: 1024 * 1024,
  };
}

describe("StaticMaterialService", () => {
  test("loads each static catalog once and filters cached catalogs locally", async () => {
    const calls = { readme: 0, references: 0, imports: 0, helpers: 0, recipes: 0 };
    const canvas = {
      sessionKey: async () => "session:1",
      readme: async () => {
        calls.readme += 1;
        return "readme";
      },
      search: async (code: string) => {
        if (code.includes("api.members")) {
          calls.references += 1;
          return {
            memberCount: 2,
            categories: ["shapes", "camera"],
            members: [
              { name: "createShape", category: "shapes", description: "Create a shape" },
              { name: "zoomIn", category: "camera", description: "Zoom in" },
            ],
          };
        }
        if (code.includes("api.imports")) {
          calls.imports += 1;
          return {
            importCount: 2,
            modules: [{ module: "tldraw", exports: [{ name: "createShapeId", kind: "function" }, { name: "ShapeUtil", kind: "class" }] }],
          };
        }
        if (code.includes("api.helpers")) {
          calls.helpers += 1;
          return { helperCount: 1, helpers: [{ name: "boxShapes" }] };
        }
        if (code.includes("api.recipes")) {
          calls.recipes += 1;
          return { stack: { id: "stack", title: "Stack", whenToUse: "Arrange shapes", body: "Steps" } };
        }
        throw new Error(`Unexpected search: ${code}`);
      },
    } as unknown as CanvasApiClient;
    const material = new StaticMaterialService(canvas);

    await material.readme();
    await material.readme();
    expect((await material.referenceSearch({ query: "shape", offset: 0, limit: 10 })).members).toHaveLength(1);
    expect((await material.referenceSearch({ query: "zoom", offset: 0, limit: 10 })).members).toHaveLength(1);
    expect((await material.importsSearch({ query: "shape", limit: 10 })).modules[0]?.exports).toHaveLength(2);
    expect((await material.importsSearch({ query: "shape", kind: "class", limit: 10 })).modules[0]?.exports).toHaveLength(1);
    await material.helpers();
    await material.helpers();
    expect(await material.recipesList()).toEqual([{ id: "stack", title: "Stack", whenToUse: "Arrange shapes" }]);
    expect(await material.recipe("stack")).toMatchObject({ body: "Steps" });

    expect(calls).toEqual({ readme: 1, references: 1, imports: 1, helpers: 1, recipes: 1 });
  });

  test("invalidates static values after server.json is removed or replaced without caching live searches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "static-material-test-"));
    const serverJson = join(directory, "server.json");
    const token = "static-material-token";
    let helperRequests = 0;
    let liveRequests = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { code } = (await request.json()) as { code: string };
        if (code.includes("api.helpers")) {
          helperRequests += 1;
          return Response.json({ success: true, result: { helperCount: helperRequests, helpers: [] } });
        }
        liveRequests += 1;
        return Response.json({ success: true, result: [] });
      },
    });
    const upstreamPort = upstream.port;
    if (upstreamPort === undefined) throw new Error("Test server did not bind a port");

    try {
      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token, pid: 10, startedAt: 20 }));
      const canvas = new CanvasApiClient(config(serverJson), () => {});
      const material = new StaticMaterialService(canvas);

      await material.helpers();
      await material.helpers();
      expect(helperRequests).toBe(1);

      await canvas.search("return await api.getDocs()");
      await canvas.search("return await api.getDocs()");
      expect(liveRequests).toBe(2);

      await rm(serverJson);
      await expect(material.helpers()).rejects.toMatchObject({ code: "APP_NOT_RUNNING" });

      await writeFile(serverJson, JSON.stringify({ port: upstreamPort, token, pid: 11, startedAt: 21 }));
      await material.helpers();
      expect(helperRequests).toBe(2);
    } finally {
      await upstream.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
