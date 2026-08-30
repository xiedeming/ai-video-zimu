import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMediaFileResponse, parseMediaRangeHeader } from './media-protocol'

let temporaryDirectory = ''
let mediaPath = ''

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'zimu-media-range-'))
  mediaPath = join(temporaryDirectory, '媒体 测试.mp4')
  await writeFile(mediaPath, Buffer.from('0123456789'))
})

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('media protocol byte ranges', () => {
  it('parses explicit, open-ended and suffix byte ranges', () => {
    expect(parseMediaRangeHeader('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseMediaRangeHeader('bytes=7-', 10)).toEqual({ start: 7, end: 9 })
    expect(parseMediaRangeHeader('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  })

  it('rejects malformed and unsatisfiable ranges', () => {
    expect(parseMediaRangeHeader('bytes=10-12', 10)).toBe('invalid')
    expect(parseMediaRangeHeader('bytes=7-2', 10)).toBe('invalid')
    expect(parseMediaRangeHeader('items=0-1', 10)).toBe('invalid')
  })

  it('returns real 206 partial content for media seeking', async () => {
    const response = await createMediaFileResponse(mediaPath, new Request('zimu-media://local/video', {
      headers: { Range: 'bytes=3-6' }
    }))

    expect(response.status).toBe(206)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBe('bytes 3-6/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('3456')
  })

  it('returns 416 with the file size for an invalid seek range', async () => {
    const response = await createMediaFileResponse(mediaPath, new Request('zimu-media://local/video', {
      headers: { Range: 'bytes=20-' }
    }))

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })
})
