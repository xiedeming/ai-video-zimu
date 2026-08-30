import { dialog, net } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getAppPaths, MODEL_MANIFEST } from './constants'
import { downloadSourceLabel, getModelDownloadSources } from './download-sources'
import type { ModelManifestItem, ModelProgressEvent, ModelState } from '../shared/types'

type ProgressListener = (event: ModelProgressEvent) => void

interface SourceDownloadResult {
  downloaded: number
  sourceUrl: string
}

function networkErrorMessage(error: unknown): string {
  const value = error as { message?: string; code?: string; cause?: { code?: string } }
  const code = value.cause?.code ?? value.code
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return '连接超时'
  if (code === 'ENOTFOUND') return '域名解析失败'
  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (value.message?.toLowerCase().includes('aborted')) return '连接超时'
  return value.message || '网络连接失败'
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export class ModelManager {
  private controllers = new Map<ModelManifestItem['id'], AbortController>()
  private listeners = new Set<ProgressListener>()

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ModelProgressEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }

  pathFor(id: ModelManifestItem['id']): string {
    const item = MODEL_MANIFEST.find((model) => model.id === id)
    if (!item) throw new Error(`未知模型：${id}`)
    return join(getAppPaths().models, item.fileName)
  }

  private metaPath(id: ModelManifestItem['id']): string {
    return `${this.pathFor(id)}.meta.json`
  }

  async list(): Promise<ModelState[]> {
    await mkdir(getAppPaths().models, { recursive: true })
    return Promise.all(MODEL_MANIFEST.map(async (item): Promise<ModelState> => {
      const filePath = this.pathFor(item.id)
      try {
        const fileStat = await stat(filePath)
        let sha256: string | undefined
        try {
          const meta = JSON.parse(await readFile(this.metaPath(item.id), 'utf8')) as { sha256?: string; size?: number }
          if (meta.size === fileStat.size) sha256 = meta.sha256
        } catch { /* calculate only after import/download */ }
        const invalidSize = item.size > 0 && Math.abs(fileStat.size - item.size) > Math.max(1_048_576, item.size * 0.02)
        const invalidHash = Boolean(item.expectedSha256 && sha256 && item.expectedSha256 !== sha256)
        return {
          ...item,
          status: invalidSize || invalidHash ? 'invalid' : 'ready',
          downloadedBytes: fileStat.size,
          sha256
        }
      } catch {
        return { ...item, status: this.controllers.has(item.id) ? 'downloading' : 'missing', downloadedBytes: 0 }
      }
    }))
  }

  async assertReady(ids?: ModelManifestItem['id'][]): Promise<void> {
    const requested = ids ? new Set(ids) : undefined
    const missing = (await this.list()).filter((model) => (requested ? requested.has(model.id) : model.required) && model.status !== 'ready')
    if (missing.length) {
      throw Object.assign(new Error(`请先下载模型：${missing.map((model) => model.name).join('、')}`), { code: 'MODELS_MISSING' })
    }
  }

  async download(id: ModelManifestItem['id']): Promise<void> {
    const item = MODEL_MANIFEST.find((model) => model.id === id)
    if (!item) throw new Error(`未知模型：${id}`)
    if (this.controllers.has(id)) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const target = this.pathFor(id)
    const partial = `${target}.part`
    try {
      await mkdir(dirname(target), { recursive: true })
      const sources = getModelDownloadSources(item)
      const failures: string[] = []
      let result: SourceDownloadResult | undefined
      for (let index = 0; index < sources.length && !result; index += 1) {
        const sourceUrl = sources[index]
        const label = downloadSourceLabel(sourceUrl)
        this.emit({
          id, status: 'downloading',
          downloadedBytes: await stat(partial).then((value) => value.size).catch(() => 0),
          totalBytes: item.size,
          message: `正在连接${label}（${index + 1}/${sources.length}）`
        })
        try {
          result = await this.downloadFromSource(item, sourceUrl, partial, controller)
        } catch (error) {
          if (controller.signal.aborted) throw error
          failures.push(`${label}：${networkErrorMessage(error)}`)
          if (index < sources.length - 1) {
            this.emit({
              id, status: 'downloading',
              downloadedBytes: await stat(partial).then((value) => value.size).catch(() => 0),
              totalBytes: item.size,
              message: `${label}不可用，正在切换备用源`
            })
          }
        }
      }
      if (!result) {
        throw Object.assign(
          new Error(`所有模型下载源均不可用。${failures.join('；')}。请检查系统代理，或设置 ZIMU_MODEL_ENDPOINT 后重试。`),
          { code: 'MODEL_DOWNLOAD_UNAVAILABLE' }
        )
      }
      const downloaded = result.downloaded
      this.emit({ id, status: 'downloading', downloadedBytes: downloaded, totalBytes: downloaded || item.size, message: '正在校验 SHA-256' })
      const sha256 = await hashFile(partial)
      if (item.expectedSha256 && sha256 !== item.expectedSha256) {
        await unlink(partial).catch(() => undefined)
        throw Object.assign(new Error('模型校验失败，请重试或手动导入'), { code: 'MODEL_HASH_MISMATCH' })
      }
      await unlink(target).catch(() => undefined)
      await rename(partial, target)
      await writeFile(this.metaPath(id), JSON.stringify({ sha256, size: downloaded, version: item.version, sourceUrl: result.sourceUrl, verifiedAt: new Date().toISOString() }, null, 2), 'utf8')
      this.emit({ id, status: 'ready', downloadedBytes: downloaded, totalBytes: downloaded, message: '模型已就绪' })
    } catch (error) {
      const canceled = controller.signal.aborted
      const partialSize = await stat(partial).then((value) => value.size).catch(() => 0)
      this.emit({
        id,
        status: canceled ? 'missing' : 'error',
        downloadedBytes: partialSize,
        totalBytes: item.size,
        message: canceled ? '下载已暂停，可继续下载' : (error as Error).message
      })
      if (!canceled) throw error
    } finally {
      this.controllers.delete(id)
    }
  }

  private async downloadFromSource(
    item: ModelManifestItem,
    sourceUrl: string,
    partial: string,
    controller: AbortController
  ): Promise<SourceDownloadResult> {
    const existing = await stat(partial).then((value) => value.size).catch(() => 0)
    const requestController = new AbortController()
    const cancelRequest = () => requestController.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', cancelRequest, { once: true })
    const connectionTimer = setTimeout(() => requestController.abort(new Error('连接超时')), 20_000)
    try {
      const response = await net.fetch(sourceUrl, {
        signal: requestController.signal,
        headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined,
        redirect: 'follow',
        bypassCustomProtocolHandlers: true
      })
      clearTimeout(connectionTimer)
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('下载响应没有数据')
      const append = existing > 0 && response.status === 206
      let downloaded = append ? existing : 0
      const totalFromHeader = Number(response.headers.get('content-length') ?? 0)
      const total = append ? existing + totalFromHeader : totalFromHeader || item.size
      const label = downloadSourceLabel(sourceUrl)
      let lastProgressAt = 0
      this.emit({ id: item.id, status: 'downloading', downloadedBytes: downloaded, totalBytes: total, message: `正在从${label}下载` })
      const readable = Readable.fromWeb(response.body as never)
      readable.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        const now = Date.now()
        if (now - lastProgressAt >= 120) {
          lastProgressAt = now
          this.emit({ id: item.id, status: 'downloading', downloadedBytes: downloaded, totalBytes: total, message: `正在从${label}下载` })
        }
      })
      await pipeline(readable, createWriteStream(partial, { flags: append ? 'a' : 'w' }))
      return { downloaded, sourceUrl }
    } finally {
      clearTimeout(connectionTimer)
      controller.signal.removeEventListener('abort', cancelRequest)
    }
  }

  cancel(id: ModelManifestItem['id']): void {
    this.controllers.get(id)?.abort()
  }

  async remove(id: ModelManifestItem['id']): Promise<void> {
    const modelsRoot = resolve(getAppPaths().models)
    const target = resolve(this.pathFor(id))
    if (!target.startsWith(`${modelsRoot}\\`) && target !== modelsRoot) throw new Error('模型路径越界')
    this.cancel(id)
    await Promise.all([
      unlink(target).catch(() => undefined),
      unlink(`${target}.part`).catch(() => undefined),
      unlink(this.metaPath(id)).catch(() => undefined)
    ])
  }

  async import(id: ModelManifestItem['id']): Promise<ModelState | null> {
    const item = MODEL_MANIFEST.find((model) => model.id === id)
    if (!item) throw new Error(`未知模型：${id}`)
    const result = await dialog.showOpenDialog({
      title: `导入 ${item.name}`,
      properties: ['openFile'],
      filters: [{ name: basename(item.fileName), extensions: [item.fileName.split('.').pop() ?? '*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const source = result.filePaths[0]
    const target = this.pathFor(id)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    const [sha256, fileStat] = await Promise.all([hashFile(target), stat(target)])
    if (item.expectedSha256 && sha256 !== item.expectedSha256) {
      await unlink(target).catch(() => undefined)
      throw new Error('导入文件的 SHA-256 与模型清单不一致')
    }
    await writeFile(this.metaPath(id), JSON.stringify({ sha256, size: fileStat.size, version: item.version, verifiedAt: new Date().toISOString() }, null, 2), 'utf8')
    return (await this.list()).find((model) => model.id === id) ?? null
  }
}
