import { describe, expect, it } from 'vitest'
import { batchRequestSchema, queueControlSchema } from './queue'

const request = { items: [{ mediaPath: 'D:\\字幕🎬\\视频.mp4' }], options: { sourceLanguage: 'auto', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: true }, concurrency: 1 }

describe('queue IPC validation', () => {
  it('accepts Unicode paths and per-video option overrides', () => {
    const parsed = batchRequestSchema.parse({ ...request, items: [{ mediaPath: 'D:\\字幕🎬\\视频.mp4', overrides: { sourceLanguage: 'ja', translate: false } }] })
    expect(parsed.items[0].overrides).toEqual({ sourceLanguage: 'ja', translate: false })
  })
  it.each([
    { ...request, items: [] }, { ...request, concurrency: 3 },
    { ...request, options: { ...request.options, apiKey: 'secret' } },
    { ...request, items: [{ mediaPath: '', overrides: { translate: 'false' } }] },
    { ...request, options: { ...request.options, sourceLanguage: 'unknown' } },
    { ...request, items: Array.from({ length: 101 }, () => ({ mediaPath: 'x' })) }
  ])('rejects malformed batches without coercion', (input) => {
    expect(batchRequestSchema.safeParse(input).success).toBe(false)
  })
  it.each([{ action: 'cancel', jobId: '../path' }, { action: 'concurrency', value: 0 }, { action: 'resume', apiKey: 'secret' }, { action: 'unknown' }])('rejects malformed controls', (input) => {
    expect(queueControlSchema.safeParse(input).success).toBe(false)
  })
})
