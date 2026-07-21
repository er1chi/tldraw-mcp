import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../src/config.ts'
import type { CanvasApiClient, ScriptWorkspaceResult } from '../src/tldraw/canvas-api-client.ts'
import { applyExactEdits, WorkspaceService } from '../src/tldraw/workspace-service.ts'

let root: string
let workspace: ScriptWorkspaceResult
let service: WorkspaceService
let scriptWorkspaceCalls: number

const config: AppConfig = {
  host: '127.0.0.1',
  port: 7237,
  mcpToken: 'x'.repeat(32),
  allowedHosts: ['127.0.0.1'],
  tldrawServerJson: '',
  requestTimeoutMs: 1000,
  idleTimeoutSeconds: 255,
  maxRequestBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxImageBytes: 1024 * 1024,
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tldraw-mcp-test-'))
  await mkdir(join(root, 'script'))
  await mkdir(join(root, 'assets'))
  await mkdir(join(root, '.script-workspace'))
  await writeFile(join(root, 'script/main.js'), 'export default function main() {}\n')
  await writeFile(join(root, '.script-workspace/script-context.d.ts'), 'declare const editor: unknown\n')
  await writeFile(join(root, '.script-workspace/package.json'), '{}\n')
  await writeFile(join(root, 'jsconfig.json'), '{}\n')
  workspace = {
    scriptDir: join(root, 'script'),
    mainJsPath: join(root, 'script/main.js'),
    isDefaultScript: false,
    toolingDir: join(root, '.script-workspace'),
    envTypesPath: join(root, '.script-workspace/script-context.d.ts'),
    jsConfigPath: join(root, 'jsconfig.json'),
    packageJsonPath: join(root, '.script-workspace/package.json'),
    errorLogPath: join(root, '.script-workspace/error.log'),
    assetsDir: join(root, 'assets'),
    editable: ['**/*', '../assets/**'],
    appOwned: [],
    manifest: null,
    name: 'Test',
  }
  scriptWorkspaceCalls = 0
  const client = {
    sessionKey: async () => 'session:1',
    scriptWorkspace: async () => {
      scriptWorkspaceCalls += 1
      return workspace
    },
    scriptStatus: async () => ({ state: 'applied' }),
  } as unknown as CanvasApiClient
  service = new WorkspaceService(client, config)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('applyExactEdits', () => {
  test('applies multiple non-overlapping edits against the original text', () => {
    expect(
      applyExactEdits('alpha beta gamma', [
        { oldText: 'alpha', newText: 'A' },
        { oldText: 'gamma', newText: 'G' },
      ]),
    ).toBe('A beta G')
  })

  test('rejects ambiguous and overlapping edits', () => {
    expect(() => applyExactEdits('x x', [{ oldText: 'x', newText: 'y' }])).toThrow('not unique')
    expect(() =>
      applyExactEdits('abcdef', [
        { oldText: 'abcd', newText: 'x' },
        { oldText: 'cdef', newText: 'y' },
      ]),
    ).toThrow('overlap')
  })
})

describe('WorkspaceService', () => {
  test('returns virtual paths without leaking absolute paths', async () => {
    const result = await service.open('doc:test')
    expect(result.virtualPaths.mainJsPath).toBe('script/main.js')
    expect(JSON.stringify(result)).not.toContain(root)
    expect(result.files.some((file) => file.path === 'script/main.js')).toBe(true)
  })

  test('reuses workspace metadata for reads within the same app session', async () => {
    await service.open('doc:test')
    await service.list('doc:test')
    await service.read('doc:test', 'script/main.js')
    expect(scriptWorkspaceCalls).toBe(1)
  })

  test('requires and enforces SHA preconditions for existing scripts', async () => {
    const original = await readFile(join(root, 'script/main.js'), 'utf8')
    const hash = createHash('sha256').update(original).digest('hex')
    const result = await service.apply('doc:test', [
      {
        op: 'edit_text',
        path: 'script/main.js',
        expectedSha256: hash,
        edits: [{ oldText: 'function main()', newText: 'function run()' }],
      },
    ])
    expect(await readFile(join(root, 'script/main.js'), 'utf8')).toContain('function run()')
    expect(result.status).toEqual({ state: 'applied' })

    await expect(
      service.apply('doc:test', [{ op: 'write_text', path: 'script/main.js', content: 'bad', expectedSha256: hash }]),
    ).rejects.toThrow('SHA-256 conflict')
  })

  test('waits briefly for a pending script apply to settle', async () => {
    let statusCalls = 0
    const client = {
      sessionKey: async () => 'session:1',
      scriptWorkspace: async () => workspace,
      scriptStatus: async () => ({ state: ++statusCalls < 3 ? 'pending' : 'applied' }),
    } as unknown as CanvasApiClient
    const waitingService = new WorkspaceService(client, config, { applyWaitMs: 100, applyPollMs: 1 })

    const result = await waitingService.apply('doc:test', [
      { op: 'write_text', path: 'script/module.js', content: 'export const settled = true\n' },
    ])

    expect(result.status).toEqual({ state: 'applied' })
    expect(statusCalls).toBe(3)
  })

  test('writes text and binary assets in a batch', async () => {
    await service.apply('doc:test', [
      { op: 'write_text', path: 'script/module.js', content: 'export const n = 1\n' },
      { op: 'write_base64', path: 'assets/pixel.bin', data: Buffer.from([0, 1, 2, 255]).toString('base64') },
    ])
    expect(await readFile(join(root, 'script/module.js'), 'utf8')).toBe('export const n = 1\n')
    expect(new Uint8Array(await readFile(join(root, 'assets/pixel.bin')))).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  test('rejects traversal and symlinks', async () => {
    await expect(service.read('doc:test', '../outside')).rejects.toThrow('Invalid workspace path')
    await symlink(join(root, 'jsconfig.json'), join(root, 'script/link.js'))
    await expect(service.read('doc:test', 'script/link.js')).rejects.toThrow('Symlinks are not allowed')
  })
})
