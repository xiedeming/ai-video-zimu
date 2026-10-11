import { createServer } from 'node:net'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
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
  options?: PipelineOptions
}

export interface PipelineOptions {
  jobId?: string
  translate?: boolean
  concurrency?: number
  checkpoint?: (project: ZimuProjectV1) => Promise<void>
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
  private localTranslationTail: Promise<void> = Promise.resolve()
  private localServer?: { child: ChildProcessWithoutNullStreams; controller: AbortController; resolved: ResolvedTranslationProfile }

  constructor(private models: ModelManager, private profiles: TranslationProfileManager) {}

  dispose(): void {
    for (const jobId of this.jobs.keys()) this.cancel(jobId)
    this.localServer?.controller.abort()
    this.localServer?.child.kill()
    this.localServer = undefined
  }

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

  start(projectInput: ZimuProjectV1, options: PipelineOptions = {}): { jobId: string } {
    const project = projectSchema.parse(projectInput)
    const jobId = options.jobId ?? randomUUID()
    this.jobs.set(jobId, { controller: new AbortController(), startedAt: Date.now(), projectId: project.id, options })
    void this.runPipeline(jobId, project)
    return { jobId }
  }

  retranslate(projectInput: ZimuProjectV1, segmentIds?: string[], operation: 'retranslate' | 'continue' = 'retranslate', options: PipelineOptions = {}): { jobId: string } {
    const project = projectSchema.parse(projectInput)
    if (segmentIds !== undefined && !segmentIds.length) {
      throw Object.assign(new Error('没有可翻译的字幕段'), { code: 'TRANSLATION_NO_SEGMENTS' })
    }
    if (segmentIds !== undefined && !project.segments.some((segment) => segmentIds.includes(segment.id))) {
      throw Object.assign(new Error('找不到需要翻译的字幕段，请刷新项目后重试'), { code: 'TRANSLATION_SEGMENTS_NOT_FOUND' })
    }
    const jobId = options.jobId ?? randomUUID()
    this.jobs.set(jobId, { controller: new AbortController(), startedAt: Date.now(), projectId: project.id, options })
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
      const workDir = join(getAppPaths().cache, jobId)
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
        useGpu,
        logicalProcessors: Math.max(1, Math.floor(availableParallelism() / (job.options?.concurrency ?? 1)))
      })
      const processOptions = {
        signal,
        onStderr: (chunk: string) => {
          const matches = [...chunk.matchAll(/(\d{1,3})%/g)]
          const value = Number(matches.at(-1)?.[1])
          if (Number.isFinite(value)) this.emit(jobId, 'transcribing', 18 + value * 0.47, `正在识别语音 · ${value}%`)
        }
      }
      const tracked = spawnTracked(whisper, whisperArgs, processOptions)
      job.process = tracked.child
      try { await tracked.result } catch (error) {
        if (!useGpu || signal.aborted) throw error
        this.emit(jobId, 'transcribing', 18, 'GPU 识别失败，正在使用 CPU 重试')
        const cpu = await resolveBinary('whisper-cli', false)
        const fallback = spawnTracked(cpu, [...whisperArgs, '--no-gpu'], processOptions)
        job.process = fallback.child
        await fallback.result
      }
      job.process = undefined
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
      await job.options?.checkpoint?.(transcribed)
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })
      if (job.options?.translate === false) {
        this.emit(jobId, 'completed', 100, '字幕已生成，可以开始校对', transcribed)
        return
      }
      const transcriptionSeconds = ((Date.now() - transcriptionStartedAt) / 1000).toFixed(1)
      this.emit(jobId, 'translating', 68, `识别完成 · 原始 ${segments.length + normalized.mergedCount} 段，合并 ${normalized.mergedCount} 段，保留 ${segments.length} 段 · ${transcriptionSeconds} 秒；正在翻译`)
      const translated = await this.translateProject(jobId, transcribed, segments, 68, 99, useGpu)
      this.emit(jobId, 'completed', 100, '字幕已生成，可以开始校对', translated)
    } catch (error) {
      if (signal.aborted || (error as { code?: string }).code === 'CANCELED') this.emit(jobId, 'canceled', 0, '任务已取消', job.checkpointProject, undefined, job.remainingSegmentIds)
      else this.emit(jobId, 'failed', 0, (error as Error).message || '任务失败', job.checkpointProject, (error as { code?: string }).code ?? 'JOB_FAILED', job.remainingSegmentIds)
    } finally {
      await rm(join(getAppPaths().cache, jobId), { recursive: true, force: true }).catch(() => undefined)
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
    const resolved = await this.profiles.resolve(project.settings.translationProfileId)
    if (resolved.profile.kind !== 'builtin') return this.translateProjectUnlocked(jobId, project, selected, startProgress, endProgress, useGpu)
    const previous = this.localTranslationTail
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    this.localTranslationTail = previous.then(() => turn)
    try {
      const signal = this.jobs.get(jobId)!.controller.signal
      await new Promise<void>((resolve, reject) => {
        const canceled = () => { signal.removeEventListener('abort', canceled); reject(Object.assign(new Error('任务已取消'), { code: 'CANCELED' })) }
        if (signal.aborted) { canceled(); return }
        signal.addEventListener('abort', canceled, { once: true })
        void previous.then(() => { signal.removeEventListener('abort', canceled); resolve() })
      })
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })
      return await this.translateProjectUnlocked(jobId, project, selected, startProgress, endProgress, useGpu)
    } finally { release() }
  }

  private async translateProjectUnlocked(
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
    if (resolved.profile.kind === 'builtin') {
      await this.models.assertReady(['qwen3-8b-q4-k-m'])
      resolved = await this.localTranslationProfile(resolved, useGpu, controller.signal)
    }
    {
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
    }
  }

  private async localTranslationProfile(resolved: ResolvedTranslationProfile, useGpu: boolean, signal: AbortSignal): Promise<ResolvedTranslationProfile> {
    if (this.localServer) return this.localServer.resolved
    const start = async (gpu: boolean): Promise<ResolvedTranslationProfile> => {
      const port = await availablePort()
      const apiKey = randomBytes(24).toString('hex')
      const controller = new AbortController()
      const llama = await resolveBinary('llama-server', gpu)
      const tracked = spawnTracked(llama, [
        '-m', this.models.pathFor('qwen3-8b-q4-k-m'), '--host', '127.0.0.1', '--port', String(port),
        '--api-key', apiKey, '-ngl', gpu ? '99' : '0', '-c', '8192', '-t', String(Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))), '--jinja'
      ], { signal: controller.signal })
      const profile = { profile: { ...resolved.profile, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey }
      const exited = tracked.result.then(() => { throw new Error('本地翻译进程已退出') })
      try {
        await Promise.race([this.waitForServer(port, apiKey, AbortSignal.any([signal, controller.signal])), exited])
        if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' })
        this.localServer = { child: tracked.child, controller, resolved: profile }
        const clear = () => { if (this.localServer?.child === tracked.child) this.localServer = undefined }
        void tracked.result.then(clear, clear)
        return profile
      } catch (error) {
        controller.abort()
        tracked.child.kill()
        throw error
      }
    }
    try { return await start(useGpu) } catch (error) {
      if (!useGpu || signal.aborted) throw error
      return start(false)
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
