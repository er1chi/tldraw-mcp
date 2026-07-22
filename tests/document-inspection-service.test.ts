import { describe, expect, test } from "bun:test";
import type { CanvasApiClient } from "../src/tldraw/canvas-api-client.ts";
import { DocumentInspectionService } from "../src/tldraw/document-inspection-service.ts";

interface FakeCanvasApi {
  getFocusedDoc(): Promise<unknown>;
  getDocs(): Promise<unknown[]>;
  getShapes(documentId: string): Promise<unknown>;
  getBindings(documentId: string): Promise<unknown[]>;
}

function createService(api: FakeCanvasApi, onSignal?: (signal: AbortSignal | undefined) => void): DocumentInspectionService {
  const canvas: Pick<CanvasApiClient, "search"> = {
    async search<T>(code: string, signal?: AbortSignal): Promise<T> {
      onSignal?.(signal);
      const execute = new Function("api", `return (async () => {${code}})()`) as (
        value: FakeCanvasApi,
      ) => Promise<unknown>;
      const result = await execute(api);
      return JSON.parse(JSON.stringify(result)) as T;
    },
  };
  return new DocumentInspectionService(canvas);
}

describe("DocumentInspectionService", () => {
  test("uses the focused document and preserves full paginated shapes", async () => {
    const calls: string[] = [];
    const api: FakeCanvasApi = {
      getFocusedDoc: async () => ({ id: "doc:focused", name: "Focused" }),
      getDocs: async () => {
        throw new Error("getDocs should not be used for focused selection");
      },
      getShapes: async (documentId) => {
        calls.push(`shapes:${documentId}`);
        return {
          page: { id: "page:1" },
          viewport: { x: 10, y: 20 },
          shapes: [
            { id: "shape:1", type: "geo", custom: "first" },
            { id: "shape:2", type: "text", custom: "preserved" },
            { id: "shape:3", type: "arrow", custom: "third" },
          ],
        };
      },
      getBindings: async () => {
        throw new Error("bindings should not be loaded");
      },
    };
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const service = createService(api, (signal) => {
      receivedSignal = signal;
    });

    const result = await service.inspect(
      { offset: 1, limit: 1, detail: "full", includeBindings: false },
      controller.signal,
    );

    expect(result).toEqual({
      document: { id: "doc:focused", name: "Focused" },
      page: { id: "page:1" },
      viewport: { x: 10, y: 20 },
      total: 3,
      offset: 1,
      limit: 1,
      shapes: [{ id: "shape:2", type: "text", custom: "preserved" }],
    });
    expect(calls).toEqual(["shapes:doc:focused"]);
    expect(receivedSignal).toBe(controller.signal);
  });

  test("selects an explicit document and filters bindings in summary mode", async () => {
    const api: FakeCanvasApi = {
      getFocusedDoc: async () => {
        throw new Error("focused lookup should not be used");
      },
      getDocs: async () => [
        { id: "doc:first", name: "First" },
        { id: "doc:target", name: "Target" },
      ],
      getShapes: async () => ({
        shapes: [
          {
            id: "shape:target",
            type: "geo",
            x: 1,
            y: 2,
            rotation: 0,
            parentId: "page:1",
            props: { color: "blue" },
            meta: { source: "test" },
            custom: "discarded",
          },
        ],
      }),
      getBindings: async () => [
        { id: "binding:1", fromId: "shape:target", toId: "shape:other" },
        { id: "binding:2", fromId: "shape:other", toId: "shape:target" },
        { id: "binding:3", fromId: "shape:a", toId: "shape:b" },
      ],
    };
    const service = createService(api);

    const result = await service.inspect({
      documentId: "doc:target",
      offset: 0,
      limit: 10,
      detail: "summary",
      includeBindings: false,
      bindingShapeId: "shape:target",
    });

    expect(result?.document).toEqual({ id: "doc:target", name: "Target" });
    expect(result?.shapes).toEqual([
      {
        id: "shape:target",
        type: "geo",
        x: 1,
        y: 2,
        rotation: 0,
        parentId: "page:1",
        props: { color: "blue" },
        meta: { source: "test" },
      },
    ]);
    expect(result?.bindings?.map((binding) => binding.id)).toEqual(["binding:1", "binding:2"]);
  });

  test("returns all bindings when requested without a shape filter", async () => {
    const api: FakeCanvasApi = {
      getFocusedDoc: async () => ({ id: "doc:focused" }),
      getDocs: async () => [],
      getShapes: async () => ({ shapes: [] }),
      getBindings: async () => [{ id: "binding:1" }, { id: "binding:2" }],
    };
    const service = createService(api);

    const result = await service.inspect({
      offset: 0,
      limit: 10,
      detail: "full",
      includeBindings: true,
    });

    expect(result?.bindings?.map((binding) => binding.id)).toEqual(["binding:1", "binding:2"]);
  });

  test("returns null without loading canvas records when an explicit document is missing", async () => {
    let recordRequests = 0;
    const api: FakeCanvasApi = {
      getFocusedDoc: async () => null,
      getDocs: async () => [{ id: "doc:other" }],
      getShapes: async () => {
        recordRequests += 1;
        return { shapes: [] };
      },
      getBindings: async () => {
        recordRequests += 1;
        return [];
      },
    };
    const service = createService(api);

    const result = await service.inspect({
      documentId: "doc:missing",
      offset: 0,
      limit: 10,
      detail: "full",
      includeBindings: true,
    });

    expect(result).toBeNull();
    expect(recordRequests).toBe(0);
  });
});
