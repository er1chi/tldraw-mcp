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
  test("caches bounded material while filtering large catalogs upstream", async () => {
    const calls = { readme: 0, references: 0, imports: 0, helpers: 0, recipes: 0 };
    const searchPrograms: string[] = [];
    const api = {
      memberCount: 2,
      categories: ["shapes", "camera"],
      members: [
        { name: "createShape", category: "shapes", description: "Create a shape" },
        { name: "zoomIn", category: "camera", description: "Zoom in" },
      ],
      importCount: 2,
      imports: [
        {
          module: "tldraw",
          exports: [
            { name: "createShapeId", kind: "function" },
            { name: "ShapeUtil", kind: "class" },
          ],
        },
      ],
      helperCount: 1,
      helpers: [{ name: "boxShapes" }],
      recipes: { stack: { id: "stack", title: "Stack", whenToUse: "Arrange shapes", body: "Steps" } },
    };
    const canvas = {
      sessionKey: async () => "session:1",
      readme: async () => {
        calls.readme += 1;
        return "readme";
      },
      search: async (code: string) => {
        searchPrograms.push(code);
        if (code.includes("api.members")) calls.references += 1;
        else if (code.includes("api.imports")) calls.imports += 1;
        else if (code.includes("api.helpers")) calls.helpers += 1;
        else if (code.includes("api.recipes")) calls.recipes += 1;
        else throw new Error(`Unexpected search: ${code}`);
        const execute = new Function("api", `return (async () => {${code}})()`) as (value: unknown) => Promise<unknown>;
        return execute(api);
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

    expect(calls).toEqual({ readme: 1, references: 2, imports: 2, helpers: 1, recipes: 1 });
    expect(
      searchPrograms
        .filter((code) => code.includes("api.members"))
        .every((code) => code.includes("matches.slice(input.offset, input.offset + input.limit)")),
    ).toBe(true);
    expect(
      searchPrograms
        .filter((code) => code.includes("api.imports"))
        .every((code) => code.includes(".slice(0, input.limit)")),
    ).toBe(true);
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
