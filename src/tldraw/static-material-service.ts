import type { CanvasApiClient } from "./canvas-api-client.ts";

interface ReferenceMember {
  name: string;
  category?: string;
  [key: string]: unknown;
}

interface ReferenceSearchResult {
  memberCount: number;
  categories: string[];
  total: number;
  offset: number;
  members: ReferenceMember[];
}

interface ImportExport {
  name: string;
  kind?: string;
  [key: string]: unknown;
}

interface ImportModule {
  module: string;
  exports?: ImportExport[];
  [key: string]: unknown;
}

interface ImportCatalog {
  importCount: number;
  modules: ImportModule[];
}

interface HelperCatalog {
  helperCount: number;
  helpers: unknown;
}

interface Recipe {
  id: string;
  title: string;
  whenToUse: string;
  body?: string;
  [key: string]: unknown;
}

interface StaticMaterials {
  readme: string;
  helpers: HelperCatalog;
  recipes: Record<string, Recipe>;
}

type StaticMaterialKey = keyof StaticMaterials;

const REFERENCE_SEARCH_PROGRAM = `
const query = input.query.toLowerCase()
const matches = api.members.filter(member =>
  (!input.exactName || member.name === input.exactName) &&
  (!input.category || member.category === input.category) &&
  (!query || JSON.stringify(member).toLowerCase().includes(query))
)
return {
  memberCount: api.memberCount,
  categories: api.categories,
  total: matches.length,
  offset: input.offset,
  members: matches.slice(input.offset, input.offset + input.limit),
}
`;

const IMPORT_SEARCH_PROGRAM = `
const query = input.query.toLowerCase()
const modules = api.imports
  .filter(entry => !input.module || entry.module === input.module)
  .map(entry => ({
    ...entry,
    exports: (entry.exports ?? [])
      .filter(item =>
        (!input.kind || item.kind === input.kind) &&
        (!query || item.name.toLowerCase().includes(query))
      )
      .slice(0, input.limit),
  }))
return { importCount: api.importCount, modules }
`;

export interface ReferenceSearchOptions {
  query: string;
  category?: string;
  exactName?: string;
  offset: number;
  limit: number;
}

export interface ImportSearchOptions {
  query: string;
  module?: string;
  kind?: string;
  limit: number;
}

/**
 * Caches bounded, immutable Canvas API material for one tldraw launch. Large searchable
 * catalogs stay upstream so filtering and pagination happen before transport limits apply.
 * Checking sessionKey before cached reads prevents values surviving an app restart.
 */
export class StaticMaterialService {
  private sessionKey: string | undefined;
  private readonly values = new Map<StaticMaterialKey, StaticMaterials[StaticMaterialKey]>();

  constructor(private readonly canvas: CanvasApiClient) {}

  async readme(signal?: AbortSignal): Promise<string> {
    return this.get("readme", () => this.canvas.readme(signal));
  }

  async helpers(signal?: AbortSignal): Promise<HelperCatalog> {
    return this.get("helpers", () =>
      this.canvas.search<HelperCatalog>(
        "return { helperCount: api.helperCount, helpers: api.helpers }",
        signal,
      ),
    );
  }

  async recipesList(signal?: AbortSignal): Promise<Array<Pick<Recipe, "id" | "title" | "whenToUse">>> {
    const recipes = await this.recipes(signal);
    return Object.values(recipes).map(({ id, title, whenToUse }) => ({ id, title, whenToUse }));
  }

  async recipe(id: string, signal?: AbortSignal): Promise<Recipe | null> {
    return (await this.recipes(signal))[id] ?? null;
  }

  async referenceSearch(options: ReferenceSearchOptions, signal?: AbortSignal): Promise<ReferenceSearchResult> {
    const input = JSON.stringify(options);
    return this.canvas.search<ReferenceSearchResult>(`const input = ${input}\n${REFERENCE_SEARCH_PROGRAM}`, signal);
  }

  async importsSearch(options: ImportSearchOptions, signal?: AbortSignal): Promise<ImportCatalog> {
    const input = JSON.stringify(options);
    return this.canvas.search<ImportCatalog>(`const input = ${input}\n${IMPORT_SEARCH_PROGRAM}`, signal);
  }

  private async recipes(signal?: AbortSignal): Promise<Record<string, Recipe>> {
    return this.get("recipes", () =>
      this.canvas.search<Record<string, Recipe>>("return api.recipes", signal),
    );
  }

  private async get<K extends StaticMaterialKey>(
    key: K,
    load: () => Promise<StaticMaterials[K]>,
  ): Promise<StaticMaterials[K]> {
    const sessionKey = await this.requireSession();
    const cached = this.values.get(key) as StaticMaterials[K] | undefined;
    if (cached !== undefined) return cached;

    const value = await load();
    const currentSessionKey = await this.requireSession();
    if (currentSessionKey === sessionKey) this.values.set(key, value);
    return value;
  }

  private async requireSession(): Promise<string> {
    try {
      const sessionKey = await this.canvas.sessionKey();
      if (sessionKey !== this.sessionKey) {
        this.values.clear();
        this.sessionKey = sessionKey;
      }
      return sessionKey;
    } catch (error) {
      this.values.clear();
      this.sessionKey = undefined;
      throw error;
    }
  }
}
