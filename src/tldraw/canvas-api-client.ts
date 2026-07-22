import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../config.ts";
import { writeLog } from "../logging/log.ts";
import { TldrawMcpError } from "./errors.ts";

export interface TldrawServerInfo {
  port: number;
  token: string;
  pid?: number;
  startedAt?: number;
}

type ServerState =
  | { info: TldrawServerInfo; error?: never }
  | { info?: never; error: TldrawMcpError };

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

const MAX_REQUEST_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 2_000;

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

function parseServerInfo(text: string): TldrawServerInfo {
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

function serverFileNotFound(error: unknown): TldrawMcpError {
  return new TldrawMcpError(
    "tldraw is not running: server.json was not found",
    "APP_NOT_RUNNING",
    error,
  );
}

function retryDelayMs(retry: number): number {
  const ceiling = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * 2 ** retry,
  );
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

function serverSessionKey(info: TldrawServerInfo): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        info.port,
        info.pid ?? null,
        info.startedAt ?? null,
        info.token,
      ]),
    )
    .digest("base64url");
}

function sessionSummary(
  info: TldrawServerInfo | undefined,
): Record<string, unknown> | null {
  if (!info) return null;
  return { port: info.port, pid: info.pid, startedAt: info.startedAt };
}

function errorSummary(error: unknown): Record<string, unknown> {
  return {
    code: error instanceof TldrawMcpError ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

function requestPath(path: string): string {
  return path.replace(/^\/api\/doc\/[^/]+/, "/api/doc/:documentId");
}

export class CanvasApiClient {
  private serverState: ServerState;
  private lastKnownServerInfo: TldrawServerInfo | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly log: typeof writeLog = writeLog,
  ) {
    this.serverState = this.readServerJsonFileSync();
    this.lastKnownServerInfo = this.serverState.info;
    if (this.serverState.error) {
      this.log({
        level: "warn",
        event: "canvas.session.unavailable",
        message: "Canvas API session was unavailable during initialization",
        reason: errorSummary(this.serverState.error),
      });
    }
  }

  async serverInfo(): Promise<TldrawServerInfo> {
    if (this.serverState.error) throw this.serverState.error;
    return this.serverState.info;
  }

  /**
   * Return an opaque identity for the current per-launch Canvas API session.
   * Unlike normal requests, this re-reads server.json so caches cannot survive an app restart.
   */
  async sessionKey(): Promise<string> {
    let text: string;
    try {
      text = await readFile(this.config.tldrawServerJson, "utf8");
    } catch (error) {
      const unavailable = serverFileNotFound(error);
      this.serverState = { error: unavailable };
      throw unavailable;
    }

    let info: TldrawServerInfo;
    try {
      info = parseServerInfo(text);
    } catch (error) {
      this.serverState = { error: error as TldrawMcpError };
      throw error;
    }
    const previous = this.lastKnownServerInfo;
    const changed =
      !previous || serverSessionKey(previous) !== serverSessionKey(info);
    this.serverState = { info };
    this.lastKnownServerInfo = info;
    if (changed) this.logSessionRefresh(previous, info);
    return serverSessionKey(info);
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
    const response = await this.fetchWithRetry(path, init);
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
    const response = await this.fetchWithRetry(path, init);
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

  private readServerJsonFileSync(): ServerState {
    let text: string;
    try {
      text = readFileSync(this.config.tldrawServerJson, "utf8");
    } catch (error) {
      return { error: serverFileNotFound(error) };
    }

    try {
      return { info: parseServerInfo(text) };
    } catch (error) {
      return { error: error as TldrawMcpError };
    }
  }

  private async readServerJsonFile(): Promise<TldrawServerInfo> {
    const previous = this.lastKnownServerInfo;
    let text: string;
    try {
      text = await readFile(this.config.tldrawServerJson, "utf8");
    } catch (error) {
      const unavailable = serverFileNotFound(error);
      this.serverState = { error: unavailable };
      this.log({
        level: "warn",
        event: "canvas.session.refresh_failed",
        message: "Could not refresh the Canvas API session from server.json",
        reason: errorSummary(unavailable),
      });
      throw unavailable;
    }

    try {
      const info = parseServerInfo(text);
      this.serverState = { info };
      this.lastKnownServerInfo = info;
      this.logSessionRefresh(previous, info);
      return info;
    } catch (error) {
      const invalid = error as TldrawMcpError;
      this.serverState = { error: invalid };
      this.log({
        level: "warn",
        event: "canvas.session.refresh_failed",
        message: "Could not refresh the Canvas API session from server.json",
        reason: errorSummary(invalid),
      });
      throw error;
    }
  }

  private logSessionRefresh(
    previous: TldrawServerInfo | undefined,
    info: TldrawServerInfo,
  ): void {
    this.log({
      level: "info",
      event: "canvas.session.refreshed",
      message: "Refreshed the Canvas API session from server.json",
      previousSession: sessionSummary(previous),
      currentSession: sessionSummary(info),
      portChanged: previous ? previous.port !== info.port : undefined,
      pidChanged: previous ? previous.pid !== info.pid : undefined,
      startedAtChanged: previous
        ? previous.startedAt !== info.startedAt
        : undefined,
      tokenChanged: previous ? previous.token !== info.token : undefined,
    });
  }

  private async fetchWithRetry(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const backoffMs = retryDelayMs(attempt - 1);
        this.log({
          level: "warn",
          event: "canvas.request.retry",
          message:
            "Retrying the Canvas API request after refreshing server.json",
          method: init.method,
          path: requestPath(path),
          attempt: attempt + 1,
          maxAttempts: MAX_REQUEST_ATTEMPTS,
          backoffMs,
          reason: errorSummary(lastError),
        });
        await delay(backoffMs, undefined, {
          signal: init.signal ?? undefined,
        });
        try {
          await this.readServerJsonFile();
        } catch (error) {
          lastError = error;
          continue;
        }
      }

      let info: TldrawServerInfo;
      try {
        info = await this.serverInfo();
      } catch (error) {
        lastError = error;
        continue;
      }

      try {
        const response = await this.fetchOnce(info, path, init);
        if (response.status !== 401) {
          if (!response.ok) {
            this.log({
              level: "warn",
              event: "canvas.request.upstream_error",
              message: "Canvas API returned an error response",
              method: init.method,
              path: requestPath(path),
              status: response.status,
              session: sessionSummary(info),
            });
          }
          return response;
        }

        const unauthorized = new TldrawMcpError(
          "Canvas API rejected the cached server.json token",
          "UPSTREAM_UNAUTHORIZED",
        );
        lastError = unauthorized;
        this.log({
          level: attempt === MAX_REQUEST_ATTEMPTS - 1 ? "error" : "warn",
          event: "canvas.request.unauthorized",
          message: unauthorized.message,
          method: init.method,
          path: requestPath(path),
          status: response.status,
          attempt: attempt + 1,
          maxAttempts: MAX_REQUEST_ATTEMPTS,
          willRetry: attempt < MAX_REQUEST_ATTEMPTS - 1,
          session: sessionSummary(info),
        });
        if (attempt === MAX_REQUEST_ATTEMPTS - 1) return response;
        await response.body?.cancel();
      } catch (error) {
        if (init.signal?.aborted) throw error;
        const stale = new TldrawMcpError(
          "tldraw is not running: the server.json session is stale",
          "APP_NOT_RUNNING",
          {
            pid: info.pid,
            startedAt: info.startedAt,
            port: info.port,
            cause: error,
          },
        );
        this.serverState = { error: stale };
        lastError = stale;
        this.log({
          level: attempt === MAX_REQUEST_ATTEMPTS - 1 ? "error" : "warn",
          event: "canvas.session.unreachable",
          message: stale.message,
          method: init.method,
          path: requestPath(path),
          attempt: attempt + 1,
          maxAttempts: MAX_REQUEST_ATTEMPTS,
          willRetry: attempt < MAX_REQUEST_ATTEMPTS - 1,
          session: sessionSummary(info),
        });
      }
    }

    this.log({
      level: "error",
      event: "canvas.request.failed",
      message: "Canvas API request failed after session refresh retries",
      method: init.method,
      path: requestPath(path),
      attempts: MAX_REQUEST_ATTEMPTS,
      reason: errorSummary(lastError),
    });
    throw lastError;
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
