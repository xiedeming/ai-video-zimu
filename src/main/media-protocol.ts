import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

export type MediaByteRange = { start: number; end: number }
export type MediaRangeResult = MediaByteRange | 'invalid' | undefined

const MEDIA_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avi': 'video/x-msvideo',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ts': 'video/mp2t',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv'
}

export function parseMediaRangeHeader(value: string | null, fileSize: number): MediaRangeResult {
  if (!value) return undefined
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 'invalid'
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return 'invalid'

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= fileSize || requestedEnd < start) {
    return 'invalid'
  }
  return { start, end: Math.min(requestedEnd, fileSize - 1) }
}

export async function createMediaFileResponse(filePath: string, request: Request): Promise<Response> {
  const file = await stat(filePath)
  if (!file.isFile()) return new Response('媒体文件不存在', { status: 404 })

  const fileSize = file.size
  const range = parseMediaRangeHeader(request.headers.get('range'), fileSize)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': MEDIA_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  })

  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${fileSize}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, fileSize - 1)
  const contentLength = fileSize ? end - start + 1 : 0
  headers.set('Content-Length', String(contentLength))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${fileSize}`)
  if (request.method === 'HEAD' || !contentLength) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const stream = createReadStream(filePath, { start, end })
  const abort = () => stream.destroy()
  request.signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => request.signal.removeEventListener('abort', abort))
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
  return new Response(body, { status: range ? 206 : 200, headers })
}
