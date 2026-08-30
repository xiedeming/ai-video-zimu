import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { exportRequestSchema, modelIdSchema, projectSchema, subtitleSegmentIdListSchema, translationProfileIdSchema, translationProfileInputSchema, translationProfileTestIdSchema } from '../shared/schemas'
import { serializeSubtitles, validateSegments } from '../shared/subtitles'
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

  models.onProgress((progress) => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('models:progress', progress))
  })
  jobs.onEvent((jobEvent) => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('jobs:event', jobEvent))
  })

  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, paths: getAppPaths() }))

  handle('project:create', async (mediaPath?: string) => createProject(mediaPath, await profiles.defaultId()))
  handle('project:open', () => openProject())
  handle('project:open-recent', (filePath: string) => openProject(filePath))
  handle('project:save', (project: ZimuProjectV1, filePath?: string) => saveProject(projectSchema.parse(project), filePath))
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
  handle('translation-profiles:update', (id: string, input: TranslationProfileInput) => profiles.update(translationProfileIdSchema.parse(id), translationProfileInputSchema.parse(input)))
  handle('translation-profiles:remove', (id: string, activeProfileId?: string) => profiles.remove(translationProfileIdSchema.parse(id), activeProfileId ? translationProfileIdSchema.parse(activeProfileId) : undefined))
  handle('translation-profiles:set-default', (id: string) => profiles.setDefault(translationProfileIdSchema.parse(id)))
  handle('translation-profiles:test', async (id: string, input?: TranslationProfileInput) => {
    const resolved = await profiles.resolve(translationProfileTestIdSchema.parse(id), input ? translationProfileInputSchema.parse(input) : undefined)
    if (resolved.profile.kind === 'builtin') {
      await models.assertReady(['qwen3-8b-q4-k-m'])
      return { ok: true, latencyMs: 0, model: resolved.profile.model, message: '本地模型文件已就绪' }
    }
    return testCompatibleApi(resolved)
  })

  handle('jobs:start', async (project: ZimuProjectV1) => jobs.start(projectSchema.parse(project)))
  handle('jobs:cancel', async (jobId: string) => jobs.cancel(jobId))
  handle('jobs:retranslate', async (project: ZimuProjectV1, segmentIds?: string[]) => jobs.retranslate(
    projectSchema.parse(project),
    segmentIds === undefined ? undefined : subtitleSegmentIdListSchema.parse(segmentIds)
  ))
  handle('jobs:continue-translation', async (project: ZimuProjectV1) => jobs.continueTranslation(projectSchema.parse(project)))

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
