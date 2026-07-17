import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { AppConfig } from '../config.ts'
import type { CanvasApiClient } from './canvas-api-client.ts'
import { TldrawMcpError } from './errors.ts'

export interface ScreenshotOptions {
  mode?: 'canvas' | 'window'
  size?: 'small' | 'medium' | 'large' | 'full'
  bounds?: { x: number; y: number; w: number; h: number }
}

export interface ScreenshotResult {
  data: string
  mimeType: 'image/jpeg'
  metadata: {
    width: number
    height: number
    pageName?: string
    viewport?: unknown
    bounds?: unknown
    captureMode?: string
    bytes: number
  }
}

interface AppScreenshot {
  filePath: string
  width: number
  height: number
  pageName?: string
  viewport?: unknown
  bounds?: unknown
  captureMode?: string
}

export class ScreenshotService {
  constructor(
    private readonly client: CanvasApiClient,
    private readonly config: AppConfig,
  ) {}

  async capture(documentId: string, options: ScreenshotOptions, signal?: AbortSignal): Promise<ScreenshotResult> {
    const code = `return await api.getScreenshot(${JSON.stringify(documentId)}, ${JSON.stringify(options)})`
    const result = await this.client.search<AppScreenshot>(code, signal)
    if (!result || typeof result.filePath !== 'string') {
      throw new TldrawMcpError('tldraw did not return a screenshot path', 'INVALID_SCREENSHOT_RESPONSE')
    }

    const screenshotRoot = await realpath(join(tmpdir(), 'tldraw-canvas-api'))
    const screenshotPath = await realpath(result.filePath)
    const rel = relative(screenshotRoot, screenshotPath)
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '' || rel.includes(sep) || !screenshotPath.toLowerCase().endsWith('.jpg')) {
      throw new TldrawMcpError('tldraw returned a screenshot outside its approved temp root', 'INVALID_SCREENSHOT_PATH')
    }
    const info = await lstat(screenshotPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new TldrawMcpError('Screenshot is not a regular file', 'INVALID_SCREENSHOT_FILE')
    if (info.size > this.config.maxImageBytes) {
      throw new TldrawMcpError(
        `Screenshot is ${info.size} bytes; limit is ${this.config.maxImageBytes}. Use a smaller size or tighter canvas bounds.`,
        'IMAGE_TOO_LARGE',
      )
    }
    const bytes = new Uint8Array(await readFile(screenshotPath))
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new TldrawMcpError('Screenshot does not have a JPEG signature', 'INVALID_SCREENSHOT_FILE')
    }
    return {
      data: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/jpeg',
      metadata: {
        width: result.width,
        height: result.height,
        pageName: result.pageName,
        viewport: result.viewport,
        bounds: result.bounds,
        captureMode: result.captureMode,
        bytes: bytes.byteLength,
      },
    }
  }
}
