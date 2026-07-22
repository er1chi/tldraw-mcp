import type { CanvasApiClient } from "./canvas-api-client.ts";

export interface DocumentInspectionOptions {
  documentId?: string;
  offset: number;
  limit: number;
  detail: "full" | "summary";
  includeBindings: boolean;
  bindingShapeId?: string;
}

export interface DocumentRecord {
  id: string;
  [key: string]: unknown;
}

export interface ShapeRecord {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface BindingRecord {
  fromId?: string;
  toId?: string;
  [key: string]: unknown;
}

export interface DocumentInspectionResult {
  document: DocumentRecord;
  page?: unknown;
  viewport?: unknown;
  total: number;
  offset: number;
  limit: number;
  shapes: ShapeRecord[];
  bindings?: BindingRecord[];
}

export interface DocumentInspector {
  inspect(options: DocumentInspectionOptions, signal?: AbortSignal): Promise<DocumentInspectionResult | null>;
}

const INSPECT_DOCUMENT_PROGRAM = `
const document = input.documentId
  ? (await api.getDocs()).find(document => document.id === input.documentId) ?? null
  : await api.getFocusedDoc()
if (!document) return null

const needsBindings = input.includeBindings || Boolean(input.bindingShapeId)
const [data, rawBindings] = await Promise.all([
  api.getShapes(document.id),
  needsBindings ? api.getBindings(document.id) : Promise.resolve(null),
])
const allShapes = data.shapes ?? []
const pageShapes = allShapes.slice(input.offset, input.offset + input.limit)
const shapes = input.detail === "full"
  ? pageShapes
  : pageShapes.map(shape => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      rotation: shape.rotation,
      parentId: shape.parentId,
      props: shape.props,
      meta: shape.meta,
    }))
const result = {
  document,
  page: data.page,
  viewport: data.viewport,
  total: allShapes.length,
  offset: input.offset,
  limit: input.limit,
  shapes,
}
if (rawBindings !== null) {
  result.bindings = input.bindingShapeId
    ? rawBindings.filter(binding => binding.fromId === input.bindingShapeId || binding.toId === input.bindingShapeId)
    : rawBindings
}
return result
`;

export class DocumentInspectionService implements DocumentInspector {
  constructor(private readonly canvas: Pick<CanvasApiClient, "search">) {}

  async inspect(
    options: DocumentInspectionOptions,
    signal?: AbortSignal,
  ): Promise<DocumentInspectionResult | null> {
    const input = JSON.stringify(options);
    return this.canvas.search<DocumentInspectionResult | null>(
      `const input = ${input}\n${INSPECT_DOCUMENT_PROGRAM}`,
      signal,
    );
  }
}
