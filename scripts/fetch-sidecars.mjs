import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const outputRoot = resolve('resources/bin/win32-x64')
const workRoot = await mkdtemp(join(tmpdir(), 'zimu-sidecars-'))
const ffmpegOnly = process.argv.includes('--ffmpeg-only')
const whisperOnly = process.argv.includes('--whisper-only')
const force = process.argv.includes('--force')

const exists = (path) => access(path).then(() => true).catch(() => false)

async function installationIsComplete(folder, requiredFiles) {
  if (force) return false
  return (await Promise.all(requiredFiles.map((name) => exists(join(outputRoot, folder, name))))).every(Boolean)
}

async function githubAsset(repo, matcher) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Zimu-Studio-Build' }
  })
  if (!response.ok) throw new Error(`无法读取 ${repo} 发布信息（${response.status}）`)
  const release = await response.json()
  const asset = release.assets.find((item) => matcher.test(item.name))
  if (!asset) throw new Error(`${repo} 最新发布中没有匹配 ${matcher} 的 Windows x64 文件`)
  return asset.browser_download_url
}

async function download(url, destination) {
  console.log(`下载 ${basename(destination)} …`)
  if (process.platform === 'win32') {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('curl.exe', [
        '-L', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '600',
        '--output', destination, url
      ], { windowsHide: true, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`curl 下载失败，代码 ${code}`)))
    })
    return
  }
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
      return
    } catch (error) {
      lastError = error
      if (attempt < 3) {
        console.warn(`下载失败，正在重试（${attempt}/3）…`)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1500))
      }
    }
  }
  throw new Error(`下载失败：${url}（${lastError instanceof Error ? lastError.message : '网络错误'}）`)
}

async function expand(zip, destination) {
  await mkdir(destination, { recursive: true })
  await new Promise((resolvePromise, reject) => {
    const child = spawn('tar.exe', ['-xf', zip, '-C', destination], { windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`解压失败，代码 ${code}`)))
  })
}

async function filesRecursively(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await filesRecursively(path))
    else result.push(path)
  }
  return result
}

async function installArchive(name, url, targetFolder, keep) {
  const zip = join(workRoot, `${name}.zip`)
  const extracted = join(workRoot, name)
  await download(url, zip)
  await expand(zip, extracted)
  const target = join(outputRoot, targetFolder)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const files = await filesRecursively(extracted)
  for (const file of files.filter((path) => keep(basename(path).toLowerCase()))) {
    await cp(file, join(target, basename(file)), { force: true })
  }
}

async function installFfmpegFromWinget() {
  const downloadRoot = join(workRoot, 'ffmpeg-winget')
  await mkdir(downloadRoot, { recursive: true })
  console.log('通过 Windows Package Manager 下载 BtbN FFmpeg LGPL Shared …')
  await new Promise((resolvePromise, reject) => {
    const child = spawn('winget.exe', [
      'download', '--id', 'BtbN.FFmpeg.LGPL.Shared', '--exact', '--download-directory', downloadRoot,
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
    ], { windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`winget 下载失败，代码 ${code}`)))
  })
  const archives = (await filesRecursively(downloadRoot)).filter((path) => path.toLowerCase().endsWith('.zip'))
  if (!archives.length) throw new Error('winget 没有生成 FFmpeg ZIP 文件')
  const extracted = join(workRoot, 'ffmpeg-winget-extracted')
  await expand(archives[0], extracted)
  const target = join(outputRoot, 'ffmpeg')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const file of (await filesRecursively(extracted)).filter((path) => {
    const name = basename(path).toLowerCase()
    return name === 'ffmpeg.exe' || name === 'ffprobe.exe' || name.endsWith('.dll')
  })) await cp(file, join(target, basename(file)), { force: true })
}

async function installFfmpeg(url) {
  if (process.platform === 'win32') {
    try { await installFfmpegFromWinget(); return }
    catch (error) { console.warn(`winget 不可用，切换官方 Release：${error instanceof Error ? error.message : error}`) }
  }
  await installArchive('ffmpeg', url, 'ffmpeg', (name) => name === 'ffmpeg.exe' || name === 'ffprobe.exe' || name.endsWith('.dll'))
}

try {
  const ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip'
  if (!whisperOnly) {
    if (await installationIsComplete('ffmpeg', ['ffmpeg.exe', 'ffprobe.exe'])) {
      console.log('FFmpeg 已存在，跳过下载。')
    } else {
      await installFfmpeg(ffmpegUrl)
    }
  }
  if (!ffmpegOnly) {
    if (await installationIsComplete('whisper', ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll'])) {
      console.log('Whisper 已存在且文件完整，跳过下载。')
    } else {
      const whisperUrl = await githubAsset('ggml-org/whisper.cpp', /whisper-cublas-12\.4\.0-bin-x64\.zip$/i)
        .catch(() => githubAsset('ggml-org/whisper.cpp', /whisper-(?:cublas|cuda)-.*-bin-x64\.zip$/i))
        .catch(() => githubAsset('ggml-org/whisper.cpp', /whisper-bin-x64\.zip$/i))
      await installArchive('whisper', whisperUrl, 'whisper', (name) => name === 'whisper-cli.exe' || name.endsWith('.dll'))
    }

    if (!whisperOnly && await installationIsComplete('llama', ['llama-server.exe', 'ggml.dll', 'ggml-base.dll'])) {
      console.log('llama.cpp 已存在且文件完整，跳过下载。')
    } else if (!whisperOnly) {
      const llamaUrl = await githubAsset('ggml-org/llama.cpp', /llama-.*-bin-win-cuda-12\.[0-9]+-x64\.zip$/i)
      const llamaCudaUrl = await githubAsset('ggml-org/llama.cpp', /cudart-llama-bin-win-cuda-12\.[0-9]+-x64\.zip$/i).catch(() => null)
      await installArchive('llama', llamaUrl, 'llama', (name) => name === 'llama-server.exe' || name.endsWith('.dll'))
      if (llamaCudaUrl) {
        const zip = join(workRoot, 'llama-cudart.zip')
        const extracted = join(workRoot, 'llama-cudart')
        await download(llamaCudaUrl, zip)
        await expand(zip, extracted)
        for (const file of (await filesRecursively(extracted)).filter((path) => path.toLowerCase().endsWith('.dll'))) {
          await cp(file, join(outputRoot, 'llama', basename(file)), { force: true })
        }
      }
    }
  }
  console.log(ffmpegOnly ? 'FFmpeg 准备完成。' : whisperOnly ? 'Whisper 准备完成。' : '本地推理二进制准备完成。运行 npm run verify:sidecars 检查。')
} finally {
  await rm(workRoot, { recursive: true, force: true })
}
