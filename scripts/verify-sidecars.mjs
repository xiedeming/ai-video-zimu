import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('resources/bin/win32-x64')
const required = [['ffmpeg/ffmpeg.exe', 'ffmpeg.exe'], ['ffmpeg/ffprobe.exe', 'ffprobe.exe']]
const alternatives = [
  ['whisper/whisper-cli.exe', 'whisper/whisper-cli-cpu.exe', 'whisper-cli.exe', 'whisper-cli-cpu.exe'],
  ['llama/llama-server.exe', 'llama/llama-server-cpu.exe', 'llama-server.exe', 'llama-server-cpu.exe']
]
const exists = (path) => access(path).then(() => true).catch(() => false)
const missing = []

async function commandOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolvePromise(output)
      : reject(new Error(`${command} 退出，代码 ${code}`)))
  })
}

for (const group of required) {
  if (!(await Promise.all(group.map((name) => exists(resolve(root, name))))).some(Boolean)) missing.push(group[0])
}
for (const group of alternatives) {
  if (!(await Promise.all(group.map((name) => exists(resolve(root, name))))).some(Boolean)) missing.push(group.join(' 或 '))
}

if (missing.length) {
  console.error(`缺少本地推理二进制：\n- ${missing.join('\n- ')}\n请参阅 resources/bin/README.md。`)
  process.exit(1)
}

const ffmpegPath = (await Promise.all(required[0].map(async (name) => ({
  path: resolve(root, name),
  present: await exists(resolve(root, name))
})))).find((candidate) => candidate.present)?.path
const encoders = await commandOutput(ffmpegPath, ['-hide_banner', '-encoders'])
const hasMp4Profile = /\blibx264\b|\blibopenh264\b/.test(encoders) && /\baac\b/.test(encoders)
const hasWebmProfile = /\blibvpx(?:-vp9)?\b/.test(encoders) && /\b(?:lib)?opus\b/.test(encoders)
if (!hasMp4Profile && !hasWebmProfile) {
  console.error('FFmpeg 缺少预览代理所需编码器：需要 H.264/AAC 或 VP8/VP9/Opus。')
  process.exit(1)
}

console.log('本地推理二进制检查通过。')
