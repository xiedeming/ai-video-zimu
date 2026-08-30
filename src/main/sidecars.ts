import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import type { MediaReference } from '../shared/types'
import { getAppPaths } from './constants'
import { parseFfmpegEncoders, previewVideoArgs, selectPreviewVideoProfile } from './ffmpeg-proxy'
import { waveformAudioArguments } from './audio-extraction'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.ts'])
type BinaryName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'llama-server'
const ffmpegEncoderCache = new Map<string, Promise<Set<string>>>()
const waveformBufferRequests = new Map<string, Promise<Buffer>>()

function binaryRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'win32-x64')
    : resolve(app.getAppPath(), 'resources', 'bin', 'win32-x64')
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false)
}

function pathCandidates(exe: string): string[] {
  return (process.env.PATH ?? '').split(';').map((folder) => folder.trim().replace(/^"|"$/g, '')).filter(Boolean).map((folder) => join(folder, exe))
}

export async function resolveBinary(name: BinaryName, preferGpu = true): Promise<string> {
  const root = binaryRoot()
  const exe = `${name}.exe`
  const cpuExe = `${name}-cpu.exe`
  const folder = name === 'ffmpeg' || name === 'ffprobe' ? 'ffmpeg' : name === 'whisper-cli' ? 'whisper' : 'llama'
  const bundled = preferGpu
    ? [join(root, folder, exe), join(root, exe), join(root, folder, cpuExe), join(root, cpuExe)]
    : [join(root, folder, cpuExe), join(root, cpuExe), join(root, folder, exe), join(root, exe)]
  const configured = name === 'ffmpeg' ? process.env.ZIMU_FFMPEG_PATH : name === 'ffprobe' ? process.env.ZIMU_FFPROBE_PATH : undefined
  const candidates = [...(configured ? [resolve(configured)] : []), ...bundled, ...pathCandidates(exe)]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  const label = name === 'ffmpeg' || name === 'ffprobe' ? 'FFmpeg' : name
  const hint = name === 'ffmpeg' || name === 'ffprobe'
    ? '请运行 npm run prepare:ffmpeg，或通过 ZIMU_FFMPEG_PATH / ZIMU_FFPROBE_PATH 指定现有程序。'
    : '请运行 npm run prepare:sidecars 后重试。'
  throw Object.assign(new Error(`缺少 ${label} 可执行文件。${hint}`), { code: 'SIDECAR_MISSING', binary: name })
}

export interface ProcessOptions {
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  cwd?: string
}

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function spawnTracked(command: string, args: string[], options: ProcessOptions = {}): {
  child: ChildProcessWithoutNullStreams
  result: Promise<ProcessResult>
} {
  const child = spawn(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    options.onStdout?.(chunk)
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    options.onStderr?.(chunk)
  })
  const abort = () => child.kill()
  options.signal?.addEventListener('abort', abort, { once: true })
  const result = new Promise<ProcessResult>((resolvePromise, reject) => {
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort)
      const exitCode = code ?? -1
      if (exitCode === 0) resolvePromise({ stdout, stderr, exitCode })
      else reject(Object.assign(new Error(stderr.trim() || `${command} 退出，代码 ${exitCode}`), { exitCode, stdout, stderr }))
    })
  })
  return { child, result }
}

export async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return spawnTracked(command, args, options).result
}

async function availableFfmpegEncoders(ffmpeg: string): Promise<Set<string>> {
  let pending = ffmpegEncoderCache.get(ffmpeg)
  if (!pending) {
    pending = runProcess(ffmpeg, ['-hide_banner', '-encoders'])
      .then(({ stdout, stderr }) => parseFfmpegEncoders(`${stdout}\n${stderr}`))
      .catch((error) => {
        ffmpegEncoderCache.delete(ffmpeg)
        throw error
      })
    ffmpegEncoderCache.set(ffmpeg, pending)
  }
  return pending
}

export async function hasNvidiaGpu(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    const result = await runProcess('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])
    return Boolean(result.stdout.trim())
  } catch {
    return false
  }
}

export async function inspectMedia(filePath: string): Promise<MediaReference> {
  const fileStat = await stat(filePath)
  const extension = extname(filePath).toLowerCase()
  const fallback: MediaReference = {
    path: filePath,
    name: basename(filePath),
    size: fileStat.size,
    durationMs: 0,
    kind: VIDEO_EXTENSIONS.has(extension) ? 'video' : 'audio',
    fingerprint: `${fileStat.size}-${Math.round(fileStat.mtimeMs)}`
  }
  try {
    const ffprobe = await resolveBinary('ffprobe')
    const { stdout } = await runProcess(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height',
      '-of', 'json', filePath
    ])
    const data = JSON.parse(stdout) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
    }
    const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
    const video = data.streams?.find((stream) => stream.codec_type === 'video')
    if (!audio) throw Object.assign(new Error('媒体文件中没有可识别的音轨'), { code: 'MEDIA_NO_AUDIO' })
    return {
      ...fallback,
      durationMs: Math.max(0, Math.round(Number(data.format?.duration ?? 0) * 1000)),
      kind: video ? 'video' : 'audio',
      audioCodec: audio.codec_name,
      videoCodec: video?.codec_name,
      width: video?.width,
      height: video?.height
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'MEDIA_NO_AUDIO') throw error
    return fallback
  }
}

export function waveformTemporaryPath(waveformDir: string, requestId: string = randomUUID()): string {
  return join(waveformDir, `waveform-${process.pid}-${requestId}.partial.s16le`)
}

export function waveformPeaks(buffer: Buffer, requestedPoints = 120): number[] {
  const points = Math.max(32, Math.min(2000, Math.round(requestedPoints)))
  const sampleCount = Math.floor(buffer.length / 2)
  if (!sampleCount) return []
  const bucketSize = Math.max(1, Math.ceil(sampleCount / points))
  const peaks: number[] = []
  for (let bucket = 0; bucket < points; bucket += 1) {
    let peak = 0
    const start = bucket * bucketSize
    const end = Math.min(sampleCount, start + bucketSize)
    for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(buffer.readInt16LE(index * 2)))
    peaks.push(Math.max(0.06, peak / 32768))
  }
  return peaks
}

async function createWaveformBuffer(ffmpeg: string, filePath: string, waveformDir: string): Promise<Buffer> {
  const rawPath = waveformTemporaryPath(waveformDir)
  try {
    await runProcess(ffmpeg, waveformAudioArguments(filePath, rawPath))
    try {
      return await readFile(rawPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
      throw error
    }
  } finally {
    await unlink(rawPath).catch(() => undefined)
  }
}

export async function extractWaveform(filePath: string, requestedPoints = 120): Promise<number[]> {
  const waveformDir = join(getAppPaths().cache, 'waveforms')
  await mkdir(waveformDir, { recursive: true })
  let ffmpeg: string
  try { ffmpeg = await resolveBinary('ffmpeg') }
  catch (error) {
    if ((error as { code?: string }).code === 'SIDECAR_MISSING') return []
    throw error
  }

  let pending = waveformBufferRequests.get(filePath)
  if (!pending) {
    pending = createWaveformBuffer(ffmpeg, filePath, waveformDir)
    waveformBufferRequests.set(filePath, pending)
    const release = () => {
      if (waveformBufferRequests.get(filePath) === pending) waveformBufferRequests.delete(filePath)
    }
    pending.then(release, release)
  }
  return waveformPeaks(await pending, requestedPoints)
}

export async function createPreviewProxy(filePath: string, projectId: string, kind: 'video' | 'audio'): Promise<string> {
  const projectCache = join(getAppPaths().cache, projectId)
  await mkdir(projectCache, { recursive: true })
  const ffmpeg = await resolveBinary('ffmpeg')
  let output: string
  let args: string[]
  if (kind === 'video') {
    const profile = selectPreviewVideoProfile(await availableFfmpegEncoders(ffmpeg))
    if (!profile) {
      throw Object.assign(new Error('当前 FFmpeg 缺少可用于预览的编码器（需要 H.264/AAC 或 VP8/VP9/Opus），请运行 npm run prepare:ffmpeg 后重试。'), {
        code: 'FFMPEG_PROXY_ENCODER_MISSING'
      })
    }
    output = join(projectCache, `preview.${profile.extension}`)
    if (await exists(output)) {
      if ((await stat(output)).size > 0) return output
      await unlink(output)
    }
    const temporary = join(projectCache, `preview-${process.pid}-${Date.now()}.partial.${profile.extension}`)
    try {
      await runProcess(ffmpeg, previewVideoArgs(filePath, temporary, profile))
      await rename(temporary, output)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return output
  }

  output = join(projectCache, 'preview.m4a')
  if (await exists(output)) {
    if ((await stat(output)).size > 0) return output
    await unlink(output)
  }
  const temporary = join(projectCache, `preview-${process.pid}-${Date.now()}.partial.m4a`)
  args = ['-y', '-hide_banner', '-i', filePath, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '128k', temporary]
  try {
    await runProcess(ffmpeg, args)
    await rename(temporary, output)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return output
}
