import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { batchRequestSchema, queueControlSchema, type GenerationOptions, type QueueTask } from '../shared/queue'
import { GenerationQueue } from './generation-queue'
import { BatchService } from './batch-service'
import { atomicWrite } from './atomic-file'
import { exportRequestSchema, modelIdSchema, projectSchema, subtitleSegmentIdListSchema, translationProfileIdSchema, translationProfileInputSchema, translationProfileTestIdSchema } from '../shared/schemas'
import { serializeSubtitles, validateSegments } from '../shared/subtitles'
import { untranslatedSegmentIds } from '../shared/subtitles'
import type { ExportFormat, ModelManifestItem, TranslationProfileInput, ZimuProjectV1 } from '../shared/types'
import { getAppPaths, MEDIA_FILTERS } from './constants'
import { JobManager } from './job-manager'
import { ModelManager } from './model-manager'
import { TranslationProfileManager } from './translation-profile-manager'
import { testCompatibleApi } from './translation-client'
import {
  autosaveProject, createProject, getRecentProjects, openProject, relinkMedia, saveProject, toMediaUrl
} from './project-service'
import { createPreviewProxy, extractWaveform, inspectMedia } from './sidecars'

function assertTrustedSender(url: string): void {
  const trusted = url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')
  if (!trusted) throw new Error('拒绝不受信任的 IPC 调用')
}

function handle<T extends unknown[], R>(channel: string, handler: (...args: T) => Promise<R> | R): void {
  ipcMain.handle(channel, (event, ...args: T) => {
    assertTrustedSender(event.senderFrame?.url ?? event.sender.getURL())
    return handler(...args)
  })
}

export function registerIpc(): void {
  const models = new ModelManager()
  const profiles = new TranslationProfileManager()
  const jobs = new JobManager(models, profiles)
  app.on('before-quit', () => jobs.dispose())
  const batches = new BatchService(models, profiles)
  const queuePath = join(app.getPath('userData'), 'generation-queue.json')
  const queue = new GenerationQueue({
    readProject: async (filePath) => projectSchema.parse(JSON.parse(await readFile(filePath, 'utf8'))),
    validate: (project, options, filePath, operation) => batches.validateTask(project, options, filePath, operation),
    save: (project, filePath) => batches.save(project, filePath),
    persist: async (snapshot) => { await mkdir(dirname(queuePath), { recursive: true }); await atomicWrite(queuePath, JSON.stringify(snapshot)) },
    start: (task, checkpoint, concurrency) => {
      const project = { ...task.project, sourceLanguage: task.options.sourceLanguage, settings: { ...task.project.settings, transcriptionModelId: task.options.transcriptionModelId, translationProfileId: task.options.translationProfileId } }
      if (task.operation === 'generate') jobs.start(project, { jobId: task.jobId, translate: task.options.translate, concurrency: Math.max(2, concurrency), checkpoint })
      else jobs.retranslate(project, task.segmentIds, task.operation, { jobId: task.jobId })
    },
    cancel: (jobId) => jobs.cancel(jobId)
  })
  const ready = (async () => {
    let raw: string
    try { raw = await readFile(queuePath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('无法读取任务队列，请检查应用数据目录')
    }
    await queue.restore(JSON.parse(raw))
  })()
  // Initialization errors are returned by queue IPC; avoid an unhandled rejection at startup.
  void ready.catch(() => undefined)
  let submissionTail: Promise<unknown> = Promise.resolve()
  const serializeSubmission = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = submissionTail.then(work)
    submissionTail = next.catch(() => undefined)
    return next
  }

  models.onProgress((progress) => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('models:progress', progress))
  })
  jobs.onEvent((jobEvent) => {
    void queue.acceptEvent(jobEvent)
  })
  queue.onEvent((jobEvent) => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('jobs:event', jobEvent))
  })
  queue.onUpdate((snapshot) => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('queue:update', snapshot))
  })
  handle('queue:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS, title: '批量添加视频' })
    return result.canceled ? [] : result.filePaths
  })
  handle('queue:validate', async (request: unknown) => { await ready; return batches.validate(batchRequestSchema.parse(request)) })
  handle('queue:submit', (input: unknown) => serializeSubmission(async () => {
    const request = batchRequestSchema.parse(input)
    await ready
    const prepared = await batches.prepare(request)
    try { await queue.enqueue(prepared, request.concurrency) } catch (error) {
      for (const item of prepared) await batches.release(item.project, item.filePath)
      throw error
    }
    return queue.snapshot()
  }))
  handle('queue:snapshot', async () => { await ready; return queue.snapshot() })
  handle('queue:control', async (request: unknown) => { await ready; return queue.control(queueControlSchema.parse(request)) })
  const enqueueProject = (input: ZimuProjectV1, operation: QueueTask['operation'] = 'generate', segmentIds?: string[], existingPath?: string) => serializeSubmission(async () => {
    await ready
    const project = projectSchema.parse(input)
    if (queue.snapshot().tasks.some((task) => task.projectId === project.id && ['waiting', 'running', 'interrupted'].includes(task.state))) throw new Error('此项目已有未结束任务')
    if (operation === 'continue') segmentIds = untranslatedSegmentIds(project.segments)
    if (operation !== 'generate' && (segmentIds?.length === 0 || !project.segments.length)) throw new Error('没有可翻译的字幕段')
    const options: GenerationOptions = { sourceLanguage: project.sourceLanguage, transcriptionModelId: project.settings.transcriptionModelId, translationProfileId: project.settings.translationProfileId, translate: true }
    await batches.assertOptions(options, operation === 'generate')
    const previous = queue.snapshot().tasks.find((task) => task.projectId === project.id)
    const filePath = existingPath ? z.string().min(1).max(32768).parse(existingPath) : previous?.filePath ?? await batches.reserve(project)
    await batches.validateTask(project, options, filePath, operation)
    return (await queue.enqueue([{ project, filePath, options, operation, segmentIds }]))[0]
  })

  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, paths: getAppPaths() }))

  handle('project:create', async (mediaPath?: string) => createProject(mediaPath, await profiles.defaultId()))
  handle('project:open', () => openProject())
  handle('project:open-recent', (filePath: string) => openProject(filePath))
  handle('project:save', async (project: ZimuProjectV1, filePath?: string) => {
    await ready
    const parsed = projectSchema.parse(project)
    if (queue.snapshot().tasks.some((task) => task.projectId === parsed.id && ['waiting', 'running', 'interrupted'].includes(task.state))) throw new Error('生成中的项目暂时只读')
    const saved = await saveProject(parsed, filePath)
    if (saved?.filePath) await queue.recordSavedProject(saved.project, saved.filePath)
    return saved
  })
  handle('project:autosave', (project: ZimuProjectV1) => autosaveProject(projectSchema.parse(project)))
  handle('project:recent', () => getRecentProjects())
  handle('project:relink', (project: ZimuProjectV1) => relinkMedia(projectSchema.parse(project)))

  handle('media:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: MEDIA_FILTERS, title: '选择视频或音频' })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('media:inspect', (filePath: string) => inspectMedia(filePath))
  handle('media:url', async (filePath: string) => toMediaUrl(filePath))
  handle('media:waveform', (filePath: string, points?: number) => extractWaveform(filePath, points))
  handle('media:proxy', async (filePath: string, projectId: string, kind: 'video' | 'audio') => {
    const proxyPath = await createPreviewProxy(filePath, projectId, kind)
    return { filePath: proxyPath, url: toMediaUrl(proxyPath) }
  })

  handle('models:list', () => models.list())
  handle('models:download', async (id: ModelManifestItem['id']) => models.download(modelIdSchema.parse(id)))
  handle('models:cancel', async (id: ModelManifestItem['id']) => models.cancel(modelIdSchema.parse(id)))
  handle('models:remove', async (id: ModelManifestItem['id']) => models.remove(modelIdSchema.parse(id)))
  handle('models:import', (id: ModelManifestItem['id']) => models.import(modelIdSchema.parse(id)))

  handle('translation-profiles:list', () => profiles.list())
  handle('translation-profiles:create', (input: TranslationProfileInput) => profiles.create(translationProfileInputSchema.parse(input)))
  const assertProfileUnusedByQueue = (id: string) => {
    if (queue.snapshot().tasks.some((task) => task.options.translate && task.options.translationProfileId === id && task.state !== 'succeeded')) throw new Error('任务队列仍在使用该翻译配置，请完成或清除相关任务后修改')
  }
  handle('translation-profiles:update', async (id: string, input: TranslationProfileInput) => {
    await ready
    const parsed = translationProfileIdSchema.parse(id)
    assertProfileUnusedByQueue(parsed)
    return profiles.update(parsed, translationProfileInputSchema.parse(input))
  })
  handle('translation-profiles:remove', async (id: string, activeProfileId?: string) => {
    await ready
    const parsed = translationProfileIdSchema.parse(id)
    assertProfileUnusedByQueue(parsed)
    return profiles.remove(parsed, activeProfileId ? translationProfileIdSchema.parse(activeProfileId) : undefined)
  })
  handle('translation-profiles:set-default', (id: string) => profiles.setDefault(translationProfileIdSchema.parse(id)))
  handle('translation-profiles:test', async (id: string, input?: TranslationProfileInput) => {
    const resolved = await profiles.resolve(translationProfileTestIdSchema.parse(id), input ? translationProfileInputSchema.parse(input) : undefined)
    if (resolved.profile.kind === 'builtin') {
      await models.assertReady(['qwen3-8b-q4-k-m'])
      return { ok: true, latencyMs: 0, model: resolved.profile.model, message: '本地模型文件已就绪' }
    }
    return testCompatibleApi(resolved)
  })

  handle('jobs:start', async (project: ZimuProjectV1, filePath?: string) => enqueueProject(project, 'generate', undefined, filePath))
  handle('jobs:cancel', async (jobId: string) => { await ready; await queue.control({ action: 'cancel', jobId: z.string().uuid().parse(jobId) }) })
  handle('jobs:retranslate', async (project: ZimuProjectV1, segmentIds?: string[], filePath?: string) => enqueueProject(
    projectSchema.parse(project),
    'retranslate',
    segmentIds === undefined ? undefined : subtitleSegmentIdListSchema.parse(segmentIds),
    filePath
  ))
  handle('jobs:continue-translation', async (project: ZimuProjectV1, filePath?: string) => enqueueProject(projectSchema.parse(project), 'continue', undefined, filePath))

  handle('subtitles:export', async (requestInput: unknown) => {
    const request = exportRequestSchema.parse(requestInput)
    const issues = validateSegments(request.project.segments)
    if (issues.length) throw Object.assign(new Error(`导出前请修复 ${issues.length} 个字幕问题`), { code: 'SUBTITLE_INVALID', issues })
    const extension: Record<ExportFormat, string> = { srt: 'srt', vtt: 'vtt', ass: 'ass' }
    let filePath = request.filePath
    if (!filePath) {
      const result = await dialog.showSaveDialog({
        title: '导出字幕', defaultPath: `${request.project.title}.${extension[request.format]}`,
        filters: [{ name: request.format.toUpperCase(), extensions: [extension[request.format]] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      filePath = result.filePath
    }
    await mkdir(dirname(filePath), { recursive: true })
    const content = serializeSubtitles(request.project.segments, request.format, request.content)
    await writeFile(filePath, content, 'utf8')
    return { canceled: false, filePath }
  })
}
