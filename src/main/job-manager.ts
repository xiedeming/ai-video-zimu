import { createServer } from 'node:net'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { getAppPaths } from './constants'
import { ModelManager } from './model-manager'
import { TranslationProfileManager, type ResolvedTranslationProfile } from './translation-profile-manager'
import { translateWithCompatibleApi } from './translation-client'
import { hasNvidiaGpu, resolveBinary, runProcess, spawnTracked } from './sidecars'
import { normalizeAndMergeWhisperSegments, synchronizeSubtitleTimings, untranslatedSegmentIds } from '../shared/subtitles'
import { projectSchema } from '../shared/schemas'
import type { JobEvent, ResolvedLanguage, SubtitleSegment, ZimuProjectV1 } from '../shared/types'
import { buildWhisperArguments } from './whisper-options'
import { transcriptionAudioArguments } from './audio-extraction'

type JobListener = (event: JobEvent) => void

interface ActiveJob {
  controller: AbortController
  startedAt: number
  projectId: string
  process?: ChildProcessWithoutNullStreams
  checkpointProject?: ZimuProjectV1
  remainingSegmentIds?: string[]
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配本地端口'))
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

function languageFromWhisper(raw: Record<string, unknown>, requested: ZimuProjectV1['sourceLanguage']): ResolvedLanguage {
  if (requested === 'ja' || requested === 'en') return requested
  const result = raw.result as { language?: string } | undefined
  const language = String(result?.language ?? raw.language ?? '').toLowerCase()
  if (['ja', 'japanese'].includes(language)) return 'ja'
  if (['en', 'english'].includes(language)) return 'en'
  throw Object.assign(new Error(`检测到暂不支持的语言：${language || '未知'}，请选择日语或英语后重试`), { code: 'LANGUAGE_UNSUPPORTED' })
}

export class JobManager {
  private jobs = new Map<string, ActiveJob>()
  private listeners = new Set<JobListener>()

  constructor(private models: ModelManager, private profiles: TranslationProfileManager) {}

  onEvent(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(jobId: string, stage: JobEvent['stage'], progress: number, message: string, project?: ZimuProjectV1, errorCode?: string, remainingSegmentIds?: string[]): void {
    const job = this.jobs.get(jobId)
    const event: JobEvent = {
      jobId,
      projectId: job?.projectId ?? project?.id ?? '',
      stage,
      progress: Math.max(0, Math.min(100, progress)),
      message,
      elapsedMs: job ? Date.now() - job.startedAt : 0,
      project,
      errorCode,
      remainingSegmentIds
    }
    this.listeners.forEach((listener) => listener(event))
  }

  start(projectInput: ZimuProjectV1): { jobId: string } {
    const project = projectSchema.parse(projectInput)
    const jobId = randomUUID()
    this.jobs.set(jobId, { controller: new AbortController(), startedAt: Date.now(), projectId: project.id })
    void this.runPipeline(jobId, project)
    return { jobId }
  }

  retranslate(projectInput: ZimuProjectV1, segmentIds?: string[], operation: 'retranslate' | 'continue' = 'retranslate'): { jobId: string } {
    const project = projectSchema.parse(projectInput)
    if (segmentIds !== undefined && !segmentIds.length) {
      throw Object.assign(new Error('没有可翻译的字幕段'), { code: 'TRANSLATION_NO_SEGMENTS' })
    }
    if (segmentIds !== undefined && !project.segments.some((segment) => segmentIds.includes(segment.id))) {
      throw Object.assign(new Error('找不到需要翻译的字幕段，请刷新项目后重试'), { code: 'TRANSLATION_SEGMENTS_NOT_FOUND' })
    }
    const jobId = randomUUID()
    this.jobs.set(jobId, { controller: new AbortController(), startedAt: Date.now(), projectId: project.id })
    void this.runTranslationOnly(jobId, project, segmentIds, operation)
    return { jobId }
  }

  continueTranslation(projectInput: ZimuProjectV1): { jobId: string } {
    const project = projectSchema.parse(projectInput)
    return this.retranslate(project, untranslatedSegmentIds(project.segments), 'continue')
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.controller.abort()
    job.process?.kill()
  }

  private async runPipeline(jobId: string, project: ZimuProjectV1): Promise<void> {
    const job = this.jobs.get(jobId)!
    const signal = job.controller.signal
    try {
      this.emit(jobId, 'queued', 1, '正在检查本地模型')
      const transcriptionModelId = project.settings.transcriptionModelId
      await this.models.assertReady([transcriptionModelId, 'silero-vad-v6.2'])
      this.emit(jobId, 'probing', 5, '正在读取媒体信息')
      const workDir = join(getAppPaths().cache, project.id)
      await mkdir(workDir, { recursive: true })
      const useGpu = await hasNvidiaGpu()
      const audioPath = join(workDir, 'audio-16k.wav')
      const ffmpeg = await resolveBinary('ffmpeg')
      this.emit(jobId, 'preparing', 10, '正在提取 16kHz 单声道音轨')
      await runProcess(ffmpeg, transcriptionAudioArguments(project.media.path, audioPath), { signal })
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })

      const whisper = await resolveBinary('whisper-cli', true)
      const outputBase = join(workDir, 'transcript')
      const language = project.sourceLanguage === 'auto' ? 'auto' : project.sourceLanguage
      this.emit(jobId, 'transcribing', 18, '正在识别语音')
      const transcriptionStartedAt = Date.now()
      const whisperArgs = buildWhisperArguments({
        modelPath: this.models.pathFor(transcriptionModelId),
        audioPath,
        language,
        outputBase,
        vadModelPath: this.models.pathFor('silero-vad-v6.2'),
        useGpu
      })
      const tracked = spawnTracked(whisper, whisperArgs, {
        signal,
        onStderr: (chunk) => {
          const matches = [...chunk.matchAll(/(\d{1,3})%/g)]
          const value = Number(matches.at(-1)?.[1])
          if (Number.isFinite(value)) this.emit(jobId, 'transcribing', 18 + value * 0.47, `正在识别语音 · ${value}%`)
        }
      })
      job.process = tracked.child
      await tracked.result
      const whisperRaw = JSON.parse(await readFile(`${outputBase}.json`, 'utf8')) as Record<string, unknown>
      const detectedLanguage = languageFromWhisper(whisperRaw, project.sourceLanguage)
      const transcription = (whisperRaw.transcription ?? whisperRaw.segments ?? []) as Parameters<typeof normalizeAndMergeWhisperSegments>[0]
      const normalized = normalizeAndMergeWhisperSegments(transcription)
      const segments = synchronizeSubtitleTimings(normalized.segments, {
        mediaDurationMs: project.media.durationMs
      })
      if (!segments.length) throw Object.assign(new Error('没有识别到有效语音，请检查音轨或语言设置'), { code: 'TRANSCRIPT_EMPTY' })
      const transcribed = projectSchema.parse({
        ...project,
        detectedLanguage,
        segments,
        modelVersions: { ...project.modelVersions, whisper: transcriptionModelId.replace('whisper-', '') },
        updatedAt: new Date().toISOString()
      })
      job.checkpointProject = transcribed
      job.remainingSegmentIds = segments.map((segment) => segment.id)
      const transcriptionSeconds = ((Date.now() - transcriptionStartedAt) / 1000).toFixed(1)
      this.emit(jobId, 'translating', 68, `识别完成 · 原始 ${segments.length + normalized.mergedCount} 段，合并 ${normalized.mergedCount} 段，保留 ${segments.length} 段 · ${transcriptionSeconds} 秒；正在翻译`)
      const translated = await this.translateProject(jobId, transcribed, segments, 68, 99, useGpu)
      this.emit(jobId, 'completed', 100, '字幕已生成，可以开始校对', translated)
    } catch (error) {
      if (signal.aborted || (error as { code?: string }).code === 'CANCELED') this.emit(jobId, 'canceled', 0, '任务已取消', job.checkpointProject, undefined, job.remainingSegmentIds)
      else this.emit(jobId, 'failed', 0, (error as Error).message || '任务失败', job.checkpointProject, (error as { code?: string }).code ?? 'JOB_FAILED', job.remainingSegmentIds)
    } finally {
      this.jobs.delete(jobId)
    }
  }

  private async runTranslationOnly(
    jobId: string,
    project: ZimuProjectV1,
    segmentIds?: string[],
    operation: 'retranslate' | 'continue' = 'retranslate'
  ): Promise<void> {
    const signal = this.jobs.get(jobId)!.controller.signal
    try {
      const selected = segmentIds === undefined
        ? project.segments
        : project.segments.filter((segment) => segmentIds.includes(segment.id))
      const job = this.jobs.get(jobId)!
      job.checkpointProject = project
      job.remainingSegmentIds = selected.map((segment) => segment.id)
      this.emit(jobId, 'translating', 2, `${operation === 'continue' ? '正在继续翻译' : '正在重新翻译'} ${selected.length} 段字幕`)
      const translated = await this.translateProject(jobId, project, selected, 2, 99, await hasNvidiaGpu())
      this.emit(jobId, 'completed', 100, operation === 'continue' ? '未翻译字幕已补全' : '翻译已更新', translated)
    } catch (error) {
      const job = this.jobs.get(jobId)!
      if (signal.aborted) this.emit(jobId, 'canceled', 0, '任务已取消', job.checkpointProject, undefined, job.remainingSegmentIds)
      else this.emit(jobId, 'failed', 0, (error as Error).message || '翻译失败', job.checkpointProject, (error as { code?: string }).code ?? 'TRANSLATION_FAILED', job.remainingSegmentIds)
    } finally {
      this.jobs.delete(jobId)
    }
  }

  private async translateProject(
    jobId: string,
    project: ZimuProjectV1,
    selected: SubtitleSegment[],
    startProgress: number,
    endProgress: number,
    useGpu: boolean
  ): Promise<ZimuProjectV1> {
    const job = this.jobs.get(jobId)!
    const { controller } = job
    let resolved = await this.profiles.resolve(project.settings.translationProfileId)
    let localProcess: ChildProcessWithoutNullStreams | undefined
    if (resolved.profile.kind === 'builtin') {
      await this.models.assertReady(['qwen3-8b-q4-k-m'])
      const port = await availablePort()
      const apiKey = randomBytes(24).toString('hex')
      let llama: string
      try {
        llama = await resolveBinary('llama-server', true)
      } catch (error) {
        if ((error as { code?: string }).code === 'SIDECAR_MISSING') {
          throw Object.assign(new Error('当前项目选择的是“本地 Qwen3”，因此需要 llama-server。若要使用远程 API，请在工作区的“翻译服务”下拉框中选择已配置的远程服务。'), {
            code: 'LLAMA_SIDECAR_REQUIRED_FOR_BUILTIN'
          })
        }
        throw error
      }
      const tracked = spawnTracked(llama, [
        '-m', this.models.pathFor('qwen3-8b-q4-k-m'), '--host', '127.0.0.1', '--port', String(port),
        '--api-key', apiKey, '-ngl', useGpu ? '99' : '0', '-c', '8192', '--jinja'
      ], { signal: controller.signal })
      localProcess = tracked.child
      job.process = tracked.child
      tracked.result.catch(() => undefined)
      await this.waitForServer(port, apiKey, controller.signal)
      resolved = { profile: { ...resolved.profile, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey }
    }
    try {
      const batches: SubtitleSegment[][] = []
      let current: SubtitleSegment[] = []
      let characters = 0
      for (const segment of selected) {
        if (current.length >= 12 || (current.length > 0 && characters + segment.sourceText.length > 6000)) {
          batches.push(current); current = []; characters = 0
        }
        current.push(segment); characters += segment.sourceText.length
      }
      if (current.length) batches.push(current)
      let completed = 0
      let currentProject = project
      const language = project.detectedLanguage ?? (project.sourceLanguage === 'en' ? 'en' : 'ja')
      for (const batch of batches) {
        if (controller.signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })
        const result = await translateWithCompatibleApi(resolved as ResolvedTranslationProfile, language, batch, controller.signal, {
          contextSegments: currentProject.segments,
          onMissingSegmentRetry: (segmentId, attempt, limit) => {
            const ratio = Math.min(1, completed / Math.max(1, selected.length))
            this.emit(
              jobId,
              'translating',
              startProgress + ratio * (endProgress - startProgress),
              `翻译结果缺少 ${segmentId}，正在自动重试 ${attempt}/${limit}`,
              currentProject,
              undefined,
              job.remainingSegmentIds
            )
          }
        })
        const batchIds = new Set(batch.map((segment) => segment.id))
        const segments = currentProject.segments.map((segment) => batchIds.has(segment.id)
          ? { ...segment, translatedText: result.get(segment.id)!, status: segment.status === 'reviewed' ? 'edited' as const : segment.status }
          : segment)
        completed += batch.length
        currentProject = projectSchema.parse({
          ...currentProject,
          segments,
          modelVersions: { ...currentProject.modelVersions, translator: resolved.profile.model },
          updatedAt: new Date().toISOString()
        })
        job.checkpointProject = currentProject
        job.remainingSegmentIds = selected.slice(completed).map((segment) => segment.id)
        const ratio = Math.min(1, completed / Math.max(1, selected.length))
        this.emit(jobId, 'translating', startProgress + ratio * (endProgress - startProgress), `正在翻译 · ${completed}/${selected.length}`, currentProject, undefined, job.remainingSegmentIds)
      }
      return currentProject
    } finally {
      localProcess?.kill()
    }
  }

  private async waitForServer(port: number, apiKey: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
        if (response.ok) return
      } catch { /* model is still loading */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
    }
    throw Object.assign(new Error('翻译模型启动超时，请检查显存或切换 CPU 版本'), { code: 'LLAMA_START_TIMEOUT' })
  }

}
