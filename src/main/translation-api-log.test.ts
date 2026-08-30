import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn()
}))

vi.mock('node:fs/promises', () => mocks)
vi.mock('./constants', () => ({ getAppPaths: () => ({ translationApiLog: 'D:\\logs\\translation-api.ndjson' }) }))

import {
  flushTranslationApiLogs,
  redactTranslationLogText,
  safeTranslationLogEndpoint,
  translationLogError,
  writeTranslationApiLog
} from './translation-api-log'

describe('translation API diagnostic log', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.appendFile.mockResolvedValue(undefined)
  })

  it('removes credentials, query strings and fragments from endpoints', () => {
    expect(safeTranslationLogEndpoint('http://user:password@192.168.1.8:8000/v1?api_key=secret#debug'))
      .toBe('http://192.168.1.8:8000/v1')
  })

  it('redacts authorization values and explicitly supplied secrets', () => {
    const text = redactTranslationLogText(
      'Authorization: Bearer abcdef api_key=secret-value internal-secret',
      ['internal-secret']
    )

    expect(text).not.toContain('abcdef')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('internal-secret')
  })

  it('extracts only sanitized error metadata', () => {
    const error = Object.assign(new Error('fetch failed for Bearer top-secret'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    expect(translationLogError(error, ['top-secret'])).toEqual({
      errorName: 'Error',
      errorCode: 'UND_ERR_CONNECT_TIMEOUT',
      errorMessage: 'fetch failed for Bearer [REDACTED]'
    })
  })

  it('writes one-line structured metadata without request or response content', async () => {
    writeTranslationApiLog({
      event: 'request_start',
      requestId: 'request-1',
      endpoint: 'http://192.168.1.8:8000/v1/chat/completions?token=secret',
      transport: 'direct',
      model: 'qwen',
      promptVersion: '2026-08-29.3',
      promptSha256: 'a'.repeat(64),
      language: 'en',
      temperature: 0.15,
      maxTokens: 4096,
      segmentCount: 2,
      segmentIds: ['segment-1', 'segment-2'],
      contextCount: 5,
      contextTranslateCount: 2,
      contextReferenceCount: 3,
      contextCharacters: 240,
      existingTranslationCount: 2,
      existingTranslationCharacters: 80,
      sourceCharacters: 120,
      sourceLatinCharacters: 100,
      attempt: 1
    })
    await flushTranslationApiLogs()

    const line = mocks.appendFile.mock.calls[0][1] as string
    const parsed = JSON.parse(line)
    expect(parsed).toMatchObject({
      event: 'request_start', requestId: 'request-1', transport: 'direct',
      promptVersion: '2026-08-29.3', language: 'en', maxTokens: 4096,
      segmentCount: 2, segmentIds: ['segment-1', 'segment-2'], contextCount: 5, contextReferenceCount: 3,
      existingTranslationCharacters: 80, sourceCharacters: 120, sourceLatinCharacters: 100
    })
    expect(line).not.toContain('token=secret')
    expect(parsed).not.toHaveProperty('body')
    expect(parsed).not.toHaveProperty('headers')
  })
})
