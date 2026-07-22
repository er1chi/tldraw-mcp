import type { CanvasApiClient } from "./canvas-api-client.ts";

interface ReferenceMember {
  name: string;
  category?: string;
  [key: string]: unknown;
}

interface ReferenceCatalog {
  memberCount: number;
  categories: string[];
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
  references: ReferenceCatalog;
  imports: ImportCatalog;
  helpers: HelperCatalog;
  recipes: Record<string, Recipe>;
}

type StaticMaterialKey = keyof StaticMaterials;

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
 * Owns the five immutable Canvas API catalogs. Values live for exactly one tldraw
 * per-launch session; checking sessionKey before every read prevents stale data from
 * surviving a removed or replaced server.json. Live canvas state never enters this cache.
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

  async referenceSearch(options: ReferenceSearchOptions, signal?: AbortSignal): Promise<{
    memberCount: number;
    categories: string[];
    total: number;
    offset: number;
    members: ReferenceMember[];
  }> {
    const catalog = await this.get("references", () =>
      this.canvas.search<ReferenceCatalog>(
        "return { memberCount: api.memberCount, categories: api.categories, members: api.members }",
        signal,
      ),
    );
    const query = options.query.toLowerCase();
    const matches = catalog.members.filter(
      (member) =>
        (!options.exactName || member.name === options.exactName) &&
        (!options.category || member.category === options.category) &&
        (!query || JSON.stringify(member).toLowerCase().includes(query)),
    );
    return {
      memberCount: catalog.memberCount,
      categories: catalog.categories,
      total: matches.length,
      offset: options.offset,
      members: matches.slice(options.offset, options.offset + options.limit),
    };
  }

  async importsSearch(options: ImportSearchOptions, signal?: AbortSignal): Promise<ImportCatalog> {
    const catalog = await this.get("imports", () =>
      this.canvas.search<ImportCatalog>(
        "return { importCount: api.importCount, modules: api.imports }",
        signal,
      ),
    );
    const query = options.query.toLowerCase();
    return {
      importCount: catalog.importCount,
      modules: catalog.modules
        .filter((entry) => !options.module || entry.module === options.module)
        .map((entry) => ({
          ...entry,
          exports: (entry.exports ?? [])
            .filter(
              (item) =>
                (!options.kind || item.kind === options.kind) &&
                (!query || item.name.toLowerCase().includes(query)),
            )
            .slice(0, options.limit),
        })),
    };
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
