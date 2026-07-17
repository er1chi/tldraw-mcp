import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AppConfig } from '../config.ts'
import type { CanvasApiClient, ScriptWorkspaceResult } from './canvas-api-client.ts'
import { TldrawMcpError } from './errors.ts'

export type WorkspaceChange =
  | { op: 'write_text'; path: string; content: string; expectedSha256?: string }
  | { op: 'edit_text'; path: string; edits: Array<{ oldText: string; newText: string }>; expectedSha256: string }
  | { op: 'write_base64'; path: string; data: string; expectedSha256?: string }
  | { op: 'delete'; path: string; expectedSha256: string }

export interface WorkspaceFile {
  path: string
  kind: 'text' | 'binary'
  writable: boolean
  size: number
  sha256: string
  modifiedAt: string
}

interface ResolvedPath {
  virtualPath: string
  absolutePath: string
  basePath: string
  writable: boolean
}

interface PreparedWrite {
  operation: Exclude<WorkspaceChange, { op: 'delete' }>
  target: ResolvedPath
  bytes: Uint8Array
  beforeSha256: string | null
}

interface PreparedDelete {
  operation: Extract<WorkspaceChange, { op: 'delete' }>
  target: ResolvedPath
  beforeSha256: string
}

const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.txt', '.md', '.css', '.svg', '.html', '.csv'])

export class WorkspaceService {
  constructor(
    private readonly client: CanvasApiClient,
    private readonly config: AppConfig,
  ) {}

  async open(documentId: string, signal?: AbortSignal): Promise<{
    documentId: string
    name?: string
    isDefaultScript: boolean
    files: WorkspaceFile[]
    virtualPaths: Record<string, string>
  }> {
    const workspace = await this.client.scriptWorkspace(documentId, signal)
    return {
      documentId,
      name: workspace.name,
      isDefaultScript: workspace.isDefaultScript,
      files: await this.listFromWorkspace(workspace),
      virtualPaths: {
        scriptDir: 'script/',
        mainJsPath: 'script/main.js',
        assetsDir: 'assets/',
        envTypesPath: '.tooling/script-context.d.ts',
        jsConfigPath: '.tooling/jsconfig.json',
        packageJsonPath: '.tooling/package.json',
        errorLogPath: '.tooling/error.log',
      },
    }
  }

  async list(documentId: string, signal?: AbortSignal): Promise<WorkspaceFile[]> {
    return this.listFromWorkspace(await this.client.scriptWorkspace(documentId, signal))
  }

  async read(
    documentId: string,
    virtualPath: string,
    options: { encoding?: 'utf8' | 'base64'; offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ path: string; encoding: 'utf8' | 'base64'; content: string; size: number; sha256: string; truncated: boolean }> {
    const workspace = await this.client.scriptWorkspace(documentId, signal)
    const target = await this.resolvePath(workspace, virtualPath, false)
    const bytes = new Uint8Array(await readFile(target.absolutePath))
    if (bytes.byteLength > this.config.maxFileBytes) {
      throw new TldrawMcpError(`File is ${bytes.byteLength} bytes; limit is ${this.config.maxFileBytes}`, 'FILE_TOO_LARGE')
    }
    const offset = options.offset ?? 0
    const limit = options.limit ?? bytes.byteLength
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new TldrawMcpError('offset must be >= 0 and limit must be > 0', 'INVALID_RANGE')
    }
    const encoding = options.encoding ?? (looksText(target.virtualPath) ? 'utf8' : 'base64')
    let content: string
    let truncated: boolean
    if (encoding === 'utf8') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      content = text.slice(offset, Math.min(text.length, offset + limit))
      truncated = offset > 0 || offset + content.length < text.length
    } else {
      const sliced = bytes.slice(offset, Math.min(bytes.byteLength, offset + limit))
      content = Buffer.from(sliced).toString('base64')
      truncated = offset > 0 || offset + sliced.byteLength < bytes.byteLength
    }
    return {
      path: target.virtualPath,
      encoding,
      content,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      truncated,
    }
  }

  async errorLog(documentId: string, signal?: AbortSignal): Promise<{ exists: boolean; content?: string; sha256?: string }> {
    try {
      const result = await this.read(documentId, '.tooling/error.log', { encoding: 'utf8' }, signal)
      return { exists: true, content: result.content, sha256: result.sha256 }
    } catch (error) {
      if (isMissing(error)) return { exists: false }
      throw error
    }
  }

  async apply(
    documentId: string,
    changes: WorkspaceChange[],
    signal?: AbortSignal,
  ): Promise<{ changed: Array<{ path: string; op: WorkspaceChange['op']; beforeSha256: string | null; sha256: string | null }>; status: Record<string, unknown> }> {
    if (changes.length === 0) throw new TldrawMcpError('At least one change is required', 'NO_CHANGES')
    if (changes.length > 100) throw new TldrawMcpError('A batch may contain at most 100 changes', 'TOO_MANY_CHANGES')

    const workspace = await this.client.scriptWorkspace(documentId, signal)
    const paths = new Set<string>()
    const writes: PreparedWrite[] = []
    const deletes: PreparedDelete[] = []

    for (const operation of changes) {
      const virtualPath = normalizeVirtualPath(operation.path)
      if (paths.has(virtualPath)) throw new TldrawMcpError(`Duplicate batch path: ${virtualPath}`, 'DUPLICATE_PATH')
      paths.add(virtualPath)
      const target = await this.resolvePath(workspace, virtualPath, true, true)
      const existing = await readExisting(target.absolutePath)
      const beforeSha256 = existing ? sha256(existing) : null

      if (operation.op === 'delete') {
        if (!existing) throw new TldrawMcpError(`Cannot delete missing file: ${virtualPath}`, 'FILE_NOT_FOUND')
        assertExpected(virtualPath, operation.expectedSha256, beforeSha256)
        deletes.push({ operation: { ...operation, path: virtualPath }, target, beforeSha256: beforeSha256! })
        continue
      }

      let bytes: Uint8Array
      if (operation.op === 'edit_text') {
        if (!existing) throw new TldrawMcpError(`Cannot edit missing file: ${virtualPath}`, 'FILE_NOT_FOUND')
        assertExpected(virtualPath, operation.expectedSha256, beforeSha256)
        const original = new TextDecoder('utf-8', { fatal: true }).decode(existing)
        bytes = new TextEncoder().encode(applyExactEdits(original, operation.edits, virtualPath))
      } else {
        if (existing && !(workspace.isDefaultScript && virtualPath === 'script/main.js')) {
          if (!operation.expectedSha256) {
            throw new TldrawMcpError(`expectedSha256 is required when replacing ${virtualPath}`, 'PRECONDITION_REQUIRED')
          }
          assertExpected(virtualPath, operation.expectedSha256, beforeSha256)
        } else if (operation.expectedSha256) {
          assertExpected(virtualPath, operation.expectedSha256, beforeSha256)
        }
        bytes = operation.op === 'write_text' ? new TextEncoder().encode(operation.content) : decodeBase64(operation.data)
      }
      if (bytes.byteLength > this.config.maxFileBytes) {
        throw new TldrawMcpError(`${virtualPath} is ${bytes.byteLength} bytes; limit is ${this.config.maxFileBytes}`, 'FILE_TOO_LARGE')
      }
      writes.push({ operation: { ...operation, path: virtualPath } as PreparedWrite['operation'], target, bytes, beforeSha256 })
    }

    for (const item of writes) await ensureSafeParent(item.target)

    // The tldraw watcher intentionally follows normal editor writes and can miss atomic renames
    // from outside its watched tree. Write complete buffers directly, with dependencies/assets
    // first and editor entrypoints last so every observable intermediate state remains valid.
    writes.sort((a, b) => commitRank(a.target.virtualPath) - commitRank(b.target.virtualPath))
    for (const item of writes) await writeFile(item.target.absolutePath, item.bytes, { mode: 0o600 })
    for (const item of deletes) await rm(item.target.absolutePath)
    if (deletes.length > 0 && !writes.some((item) => item.target.virtualPath === 'script/main.js')) {
      const mainBytes = await readFile(workspace.mainJsPath)
      await writeFile(workspace.mainJsPath, mainBytes, { mode: 0o600 })
    }

    const changed = [
      ...writes.map((item) => ({
        path: item.target.virtualPath,
        op: item.operation.op,
        beforeSha256: item.beforeSha256,
        sha256: sha256(item.bytes),
      })),
      ...deletes.map((item) => ({ path: item.target.virtualPath, op: item.operation.op, beforeSha256: item.beforeSha256, sha256: null })),
    ]

    return { changed, status: await this.status(documentId, signal) }
  }

  async status(documentId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return sanitizeStatus(await this.client.scriptStatus<Record<string, unknown>>(documentId, signal))
  }

  private async listFromWorkspace(workspace: ScriptWorkspaceResult): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = []
    await this.walk(workspace.scriptDir, 'script', true, files)
    await this.walk(workspace.assetsDir, 'assets', true, files)
    const tooling: Array<[string, string]> = [
      ['.tooling/script-context.d.ts', workspace.envTypesPath],
      ['.tooling/jsconfig.json', workspace.jsConfigPath],
      ['.tooling/package.json', workspace.packageJsonPath],
      ['.tooling/error.log', workspace.errorLogPath],
    ]
    for (const [virtualPath, absolutePath] of tooling) {
      try {
        files.push(await describeFile(virtualPath, absolutePath, false))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async walk(base: string, prefix: string, writable: boolean, output: WorkspaceFile[]): Promise<void> {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolutePath = join(base, entry.name)
      const virtualPath = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await this.walk(absolutePath, virtualPath, writable, output)
      else if (entry.isFile()) output.push(await describeFile(virtualPath, absolutePath, writable))
    }
  }

  private async resolvePath(
    workspace: ScriptWorkspaceResult,
    suppliedPath: string,
    requireWritable: boolean,
    allowMissing = false,
  ): Promise<ResolvedPath> {
    const virtualPath = normalizeVirtualPath(suppliedPath)
    let absolutePath: string
    let basePath: string
    let writable = false

    if (virtualPath.startsWith('script/')) {
      basePath = workspace.scriptDir
      absolutePath = resolve(basePath, virtualPath.slice('script/'.length))
      writable = true
    } else if (virtualPath.startsWith('assets/')) {
      basePath = workspace.assetsDir
      absolutePath = resolve(basePath, virtualPath.slice('assets/'.length))
      writable = true
    } else {
      const readOnly: Record<string, string> = {
        '.tooling/script-context.d.ts': workspace.envTypesPath,
        '.tooling/jsconfig.json': workspace.jsConfigPath,
        '.tooling/package.json': workspace.packageJsonPath,
        '.tooling/error.log': workspace.errorLogPath,
      }
      absolutePath = readOnly[virtualPath] ?? ''
      basePath = absolutePath ? dirname(absolutePath) : ''
    }

    if (!absolutePath || !basePath || !inside(basePath, absolutePath)) {
      throw new TldrawMcpError(`Path is outside the virtual workspace: ${virtualPath}`, 'PATH_NOT_ALLOWED')
    }
    if (requireWritable && !writable) throw new TldrawMcpError(`Path is read-only: ${virtualPath}`, 'PATH_READ_ONLY')

    await assertNoSymlink(basePath, absolutePath, allowMissing)
    return { virtualPath, absolutePath, basePath, writable }
  }
}

function normalizeVirtualPath(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (!path || isAbsolute(path) || path.startsWith('/') || path.includes('\0')) {
    throw new TldrawMcpError(`Invalid workspace path: ${value}`, 'INVALID_PATH')
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TldrawMcpError(`Invalid workspace path: ${value}`, 'INVALID_PATH')
  }
  return parts.join('/')
}

function inside(base: string, target: string): boolean {
  const value = relative(resolve(base), resolve(target))
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

async function assertNoSymlink(base: string, target: string, allowMissing: boolean): Promise<void> {
  const resolvedBase = await realpath(base)
  const rel = relative(resolve(base), resolve(target))
  const canonicalTarget = resolve(resolvedBase, rel)
  if (!inside(resolvedBase, canonicalTarget)) throw new TldrawMcpError('Resolved path escapes its workspace root', 'PATH_NOT_ALLOWED')
  let current = resolvedBase
  const parts = rel ? rel.split(sep) : []
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new TldrawMcpError('Symlinks are not allowed in workspace paths', 'SYMLINK_NOT_ALLOWED')
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new TldrawMcpError('A parent path is not a directory', 'INVALID_PATH')
      }
    } catch (error) {
      if (isMissing(error) && allowMissing) return
      throw error
    }
  }
}

async function ensureSafeParent(target: ResolvedPath): Promise<void> {
  const rel = relative(target.basePath, dirname(target.absolutePath))
  let current = target.basePath
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TldrawMcpError(`Unsafe parent directory for ${target.virtualPath}`, 'INVALID_PATH')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
}

async function readExisting(path: string): Promise<Uint8Array | null> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new TldrawMcpError('Target must be a regular file', 'INVALID_FILE_TYPE')
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function assertExpected(path: string, expected: string | undefined, actual: string | null): void {
  if (!expected || expected !== actual) {
    throw new TldrawMcpError(`SHA-256 conflict for ${path}; expected ${expected ?? '(missing)'}, current ${actual ?? '(missing)'}`, 'SHA_CONFLICT', {
      expected,
      actual,
    })
  }
}

export function applyExactEdits(original: string, edits: Array<{ oldText: string; newText: string }>, path = 'file'): string {
  if (edits.length === 0) throw new TldrawMcpError('edit_text requires at least one replacement', 'NO_EDITS')
  const matches = edits.map((edit, index) => {
    if (!edit.oldText) throw new TldrawMcpError(`Replacement ${index} has empty oldText`, 'INVALID_EDIT')
    const first = original.indexOf(edit.oldText)
    const second = first < 0 ? -1 : original.indexOf(edit.oldText, first + 1)
    if (first < 0) throw new TldrawMcpError(`oldText for replacement ${index} was not found in ${path}`, 'EDIT_NOT_FOUND')
    if (second >= 0) throw new TldrawMcpError(`oldText for replacement ${index} is not unique in ${path}`, 'EDIT_NOT_UNIQUE')
    return { start: first, end: first + edit.oldText.length, newText: edit.newText }
  })
  matches.sort((a, b) => a.start - b.start)
  for (let index = 1; index < matches.length; index++) {
    if (matches[index]!.start < matches[index - 1]!.end) {
      throw new TldrawMcpError(`Replacements overlap in ${path}`, 'EDIT_OVERLAP')
    }
  }
  let result = original
  for (const match of matches.reverse()) result = result.slice(0, match.start) + match.newText + result.slice(match.end)
  return result
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replaceAll(/\s/g, '')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new TldrawMcpError('Invalid base64 data', 'INVALID_BASE64')
  }
  return new Uint8Array(Buffer.from(compact, 'base64'))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function describeFile(virtualPath: string, absolutePath: string, writable: boolean): Promise<WorkspaceFile> {
  const info = await stat(absolutePath)
  const bytes = new Uint8Array(await readFile(absolutePath))
  return {
    path: virtualPath,
    kind: looksText(virtualPath) ? 'text' : 'binary',
    writable,
    size: info.size,
    sha256: sha256(bytes),
    modifiedAt: info.mtime.toISOString(),
  }
}

function looksText(path: string): boolean {
  const index = path.lastIndexOf('.')
  return index >= 0 && TEXT_EXTENSIONS.has(path.slice(index).toLowerCase())
}

function commitRank(path: string): number {
  if (path === 'script/main.js') return 2
  if (path === 'script/config.js') return 1
  return 0
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

function sanitizeStatus(status: Record<string, unknown>): Record<string, unknown> {
  const { scriptDir: _scriptDir, errorLogPath: _errorLogPath, ...safe } = status
  return safe
}
