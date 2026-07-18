import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.ts";
import { TldrawMcpError } from "./errors.ts";

export interface TldrawServerInfo {
  port: number;
  token: string;
  pid?: number;
  startedAt?: number;
}

interface AppEnvelope<T> {
  success: boolean;
  result?: T;
  error?: unknown;
  message?: string;
}

export interface ScriptWorkspaceResult {
  scriptDir: string;
  mainJsPath: string;
  isDefaultScript: boolean;
  toolingDir: string;
  envTypesPath: string;
  jsConfigPath: string;
  packageJsonPath: string;
  errorLogPath: string;
  assetsDir: string;
  editable: string[];
  appOwned: string[];
  manifest: unknown;
  filePath?: string | null;
  name?: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function mergedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function assertDocId(docId: string): string {
  // The app's router does not match percent-encoded ':' characters. Keep known tldraw ids literal.
  if (!/^[A-Za-z0-9:_-]+$/.test(docId))
    throw new TldrawMcpError("Invalid document id", "INVALID_DOCUMENT_ID");
  return docId;
}

export class CanvasApiClient {
  constructor(private readonly config: AppConfig) {}

  async serverInfo(): Promise<TldrawServerInfo> {
    let text: string;
    try {
      text = await readFile(this.config.tldrawServerJson, "utf8");
    } catch (error) {
      throw new TldrawMcpError(
        "tldraw is not running: server.json was not found",
        "APP_NOT_RUNNING",
        error,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TldrawMcpError(
        "tldraw server.json is invalid JSON",
        "INVALID_SERVER_FILE",
        error,
      );
    }

    const info = parsed as Partial<TldrawServerInfo>;
    if (
      !Number.isInteger(info.port) ||
      (info.port ?? 0) <= 0 ||
      typeof info.token !== "string" ||
      !info.token
    ) {
      throw new TldrawMcpError(
        "tldraw server.json is missing a valid port or token",
        "INVALID_SERVER_FILE",
      );
    }
    return info as TldrawServerInfo;
  }

  async readiness(signal?: AbortSignal): Promise<{
    running: true;
    pid?: number;
    startedAt?: number;
    port: number;
  }> {
    const info = await this.serverInfo();
    await this.requestText("/", { method: "GET", signal });
    return {
      running: true,
      pid: info.pid,
      startedAt: info.startedAt,
      port: info.port,
    };
  }

  async readme(signal?: AbortSignal): Promise<string> {
    return this.requestText("/readme", { method: "GET", signal });
  }

  async search<T = unknown>(code: string, signal?: AbortSignal): Promise<T> {
    return this.requestEnvelope<T>("/api/search", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json" },
      signal,
    });
  }

  async exec<T = unknown>(
    documentId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestEnvelope<T>(`/api/doc/${assertDocId(documentId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json" },
      signal,
    });
  }

  async scriptWorkspace(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ScriptWorkspaceResult> {
    return this.requestEnvelope<ScriptWorkspaceResult>(
      `/api/doc/${assertDocId(documentId)}/script-workspace`,
      {
        method: "POST",
        signal,
      },
    );
  }

  async scriptStatus<T = unknown>(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestEnvelope<T>(
      `/api/doc/${assertDocId(documentId)}/script-status`,
      {
        method: "GET",
        signal,
      },
    );
  }

  private async requestEnvelope<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchWithRefresh(path, init);
    const raw = await response.text();
    this.assertSize(raw.length);

    let payload: AppEnvelope<T>;
    try {
      payload = JSON.parse(raw) as AppEnvelope<T>;
    } catch {
      throw new TldrawMcpError(
        `tldraw returned invalid JSON (${response.status})`,
        "INVALID_UPSTREAM_RESPONSE",
      );
    }

    if (!response.ok || !payload.success) {
      const detail = payload.error ?? payload.message ?? raw;
      throw new TldrawMcpError(
        `tldraw request failed (${response.status}): ${formatDetail(detail)}`,
        "UPSTREAM_ERROR",
        detail,
      );
    }
    return payload.result as T;
  }

  private async requestText(path: string, init: RequestInit): Promise<string> {
    const response = await this.fetchWithRefresh(path, init);
    const text = await response.text();
    this.assertSize(text.length);
    if (!response.ok)
      throw new TldrawMcpError(
        `tldraw request failed (${response.status})`,
        "UPSTREAM_ERROR",
        text,
      );
    return text;
  }

  private assertSize(length: number): void {
    if (length > this.config.maxResultBytes) {
      throw new TldrawMcpError(
        `tldraw response is ${length} bytes; limit is ${this.config.maxResultBytes}. Narrow or paginate the query.`,
        "RESULT_TOO_LARGE",
      );
    }
  }

  private async fetchWithRefresh(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let info = await this.serverInfo();
    let response = await this.fetchOnce(info, path, init);
    if (response.status === 401) {
      info = await this.serverInfo();
      response = await this.fetchOnce(info, path, init);
    }
    return response;
  }

  private async fetchOnce(
    info: TldrawServerInfo,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${info.token}`);
    try {
      return await fetch(`http://127.0.0.1:${info.port}${path}`, {
        ...init,
        headers,
        signal: mergedSignal(
          init.signal ?? undefined,
          this.config.requestTimeoutMs,
        ),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new TldrawMcpError(
        "Could not reach the tldraw Canvas API; the app may not be running",
        "APP_UNREACHABLE",
        error,
      );
    }
  }
}

function formatDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
