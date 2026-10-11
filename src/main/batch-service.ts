import { open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BatchRequest, BatchValidationRow, GenerationOptions } from '../shared/queue'
import type { ZimuProjectV1 } from '../shared/types'
import { atomicWrite } from './atomic-file'
import { createProject } from './project-service'
import type { ModelManager } from './model-manager'
import type { TranslationProfileManager } from './translation-profile-manager'
import { resolveBinary } from './sidecars'

export async function assertWritable(directory: string): Promise<void> {
  const probe = join(directory, `.zimu-write-${randomUUID()}.tmp`)
  const file = await open(probe, 'wx', 0o600)
  try { await file.writeFile(''); await file.sync() } finally { await file.close(); await rm(probe, { force: true }) }
}

export async function nextProjectPath(mediaPath: string, occupied = new Set<string>()): Promise<string> {
  const stem = basename(mediaPath, extname(mediaPath))
  for (let suffix = 0; suffix < 10000; suffix++) {
    const candidate = join(dirname(mediaPath), `${stem}${suffix ? ` (${suffix})` : ''}.zimu`)
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (occupied.has(key)) continue
    try { await stat(candidate) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      occupied.add(key)
      return candidate
    }
  }
  throw new Error('无法分配项目文件名')
}

export class BatchService {
  constructor(private models: ModelManager, private profiles: TranslationProfileManager) {}
  async assertOptions(options: GenerationOptions, transcribe = true): Promise<void> {
    if (transcribe) {
      try { await this.models.assertReady([options.transcriptionModelId, 'silero-vad-v6.2']) } catch { throw new Error('识别模型或 VAD 未就绪，请在 AI 引擎中下载或导入') }
      try { await Promise.all([resolveBinary('ffmpeg'), resolveBinary('ffprobe'), resolveBinary('whisper-cli')]) } catch { throw new Error('识别工具不可用，请准备 FFmpeg 与 Whisper') }
    }
    if (options.translate) {
      const resolved = await this.profiles.resolve(options.translationProfileId).catch(() => { throw new Error('翻译配置不可用，请检查服务配置') })
      if (resolved.profile.kind === 'builtin') {
        try {
          await this.models.assertReady(['qwen3-8b-q4-k-m'])
          await resolveBinary('llama-server')
        } catch { throw new Error('本地翻译模型或 llama-server 未就绪，请配置 AI 引擎') }
      }
    }
  }
  async validate(request: BatchRequest): Promise<BatchValidationRow[]> {
    const seen = new Set<string>()
    const occupied = new Set<string>()
    const rows: BatchValidationRow[] = []
    for (const item of request.items) {
      let filePath: string | undefined
      try {
        const path = await realpath(item.mediaPath)
        const key = process.platform === 'win32' ? path.toLowerCase() : path
        if (seen.has(key)) throw new Error('同批次文件重复，请移除重复项')
        seen.add(key)
        if (!(await stat(path)).isFile()) throw new Error('请选择媒体文件')
        if (!['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(extname(path).toLowerCase())) throw new Error('不支持的媒体格式')
        filePath = await nextProjectPath(path, occupied)
        const options = { ...request.options, ...item.overrides }
        await this.assertOptions(options)
        await assertWritable(dirname(path))
        const document = await createProject(path, options.translationProfileId)
        if (!document || !document.project.media.durationMs || !document.project.media.audioCodec) throw new Error('媒体文件无效或没有音轨')
        rows.push({ mediaPath: item.mediaPath, filePath })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const safe = ['同批次文件重复，请移除重复项', '不支持的媒体格式', '请选择媒体文件', '媒体文件无效或没有音轨', '识别模型或 VAD 未就绪，请在 AI 引擎中下载或导入', '识别工具不可用，请准备 FFmpeg 与 Whisper', '翻译配置不可用，请检查服务配置', '本地翻译模型或 llama-server 未就绪，请配置 AI 引擎']
        rows.push({ mediaPath: item.mediaPath, filePath, error: code === 'ENOENT' ? '源文件不存在' : code === 'EACCES' || code === 'EPERM' ? '输出目录不可写' : code === 'MEDIA_NO_AUDIO' ? '媒体文件无效或没有音轨' : safe.includes((error as Error).message) ? (error as Error).message : '文件、模型或翻译配置不可用，请检查后重试' })
      }
    }
    return rows
  }
  async prepare(request: BatchRequest): Promise<{ project: ZimuProjectV1; filePath: string; options: GenerationOptions }[]> {
    const rows = await this.validate(request)
    if (rows.some((row) => row.error)) throw new Error('批次中有无效项目，请重新检查每一行')
    const prepared: { project: ZimuProjectV1; filePath: string; options: GenerationOptions }[] = []
    try {
      for (const item of request.items) {
        const options = { ...request.options, ...item.overrides }
        const document = (await createProject(await realpath(item.mediaPath), options.translationProfileId))!
        document.project.sourceLanguage = options.sourceLanguage
        document.project.settings.transcriptionModelId = options.transcriptionModelId
        const filePath = await this.reserve(document.project)
        prepared.push({ project: document.project, filePath, options })
      }
      return prepared
    } catch (error) {
      for (const item of prepared) await this.release(item.project, item.filePath)
      throw error
    }
  }
  async reserve(project: ZimuProjectV1): Promise<string> {
    for (;;) {
      const filePath = await nextProjectPath(project.media.path)
      let owned = false
      try {
        const file = await open(filePath, 'wx', 0o600)
        owned = true
        await file.close()
        await atomicWrite(filePath, JSON.stringify(project, null, 2))
        return filePath
      } catch (error) {
        if (owned) await rm(filePath, { force: true }).catch(() => undefined)
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }
  async release(project: ZimuProjectV1, filePath: string): Promise<void> {
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as ZimuProjectV1
    if (saved.id === project.id && !saved.segments.length) await rm(filePath)
  }
  async validateTask(project: ZimuProjectV1, options: GenerationOptions, filePath: string, operation = 'generate'): Promise<void> {
    if (operation === 'generate' && !(await stat(project.media.path)).isFile()) throw new Error('源文件不存在')
    await this.assertOptions(options, operation === 'generate')
    await assertWritable(dirname(filePath))
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as ZimuProjectV1
    if (saved.id !== project.id) throw new Error('项目文件已被替换')
  }
  async save(project: ZimuProjectV1, filePath: string): Promise<void> {
    if (resolve(filePath) === resolve(project.media.path)) throw new Error('不能覆盖源文件')
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as ZimuProjectV1
    if (saved.id !== project.id) throw new Error('项目文件已被替换')
    await atomicWrite(filePath, JSON.stringify(project, null, 2))
  }
}
