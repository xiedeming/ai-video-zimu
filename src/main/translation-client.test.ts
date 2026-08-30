import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), log: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./translation-api-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./translation-api-log')>()
  return { ...actual, writeTranslationApiLog: mocks.log }
})

import { describeTranslationNetworkError, testCompatibleApi, translateWithCompatibleApi } from './translation-client'
import type { ResolvedTranslationProfile } from './translation-profile-manager'
import type { SubtitleSegment } from '../shared/types'

const resolved: ResolvedTranslationProfile = {
  profile: { id: 'api', name: 'Test', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'qwen', hasApiKey: true, isDefault: false },
  apiKey: 'secret-key'
}
const lanResolved: ResolvedTranslationProfile = {
  profile: { id: 'lan-api', name: 'LAN', kind: 'openai-compatible', baseUrl: 'http://192.168.1.80:8000/v1', model: 'qwen', hasApiKey: false, isDefault: false }
}
const qwen3Resolved: ResolvedTranslationProfile = {
  profile: { ...resolved.profile, id: 'qwen3-api', model: 'qwen3-27b' },
  apiKey: resolved.apiKey
}
const segment = (id: string): SubtitleSegment => ({ id, startMs: 0, endMs: 1000, sourceText: 'Hello', translatedText: '', words: [], confidence: 1, status: 'generated' })
const japaneseSegment = (id: string, sourceText: string, translatedText = ''): SubtitleSegment => ({
  id, startMs: 0, endMs: 1000, sourceText, translatedText, words: [], confidence: 1, status: 'generated'
})
const completion = (items: Array<{ id: string; translation: string }>) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const textCompletion = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const reasoningOnlyCompletion = () => new Response(JSON.stringify({
  choices: [{ message: { content: null, reasoning_content: '只有思考过程' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196 }
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('OpenAI-compatible translation client', () => {
  beforeEach(() => {
    mocks.fetch.mockReset()
    mocks.log.mockReset()
  })

  it('uses Bearer auth and returns translations', async () => {
    mocks.fetch.mockResolvedValue(completion([{ id: 'a', translation: '你好' }]))
    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a')], new AbortController().signal)
    expect(result.get('a')).toBe('你好')
    const [, request] = mocks.fetch.mock.calls[0]
    expect(request.headers.Authorization).toBe('Bearer secret-key')
    expect(JSON.parse(request.body).response_format).toEqual({ type: 'json_object' })
    const events = mocks.log.mock.calls.map(([event]) => event)
    expect(events.map((event) => event.event)).toEqual(['request_start', 'response_headers', 'request_success'])
    expect(events[0]).toMatchObject({
      promptVersion: '2026-08-29.3',
      language: 'en',
      temperature: 0.15,
      maxTokens: 4096,
      correctionApplied: false,
      thinkingControl: 'soft',
      segmentCount: 1,
      segmentIds: ['a'],
      contextCount: 1,
      contextTranslateCount: 1,
      contextReferenceCount: 0,
      contextCharacters: 5,
      sourceCharacters: 5,
      sourceLatinCharacters: 5
    })
    expect(events[0].promptSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(events[1]).toMatchObject({
      status: 200,
      responseContentType: 'application/json'
    })
    expect(events[2]).toMatchObject({
      resultCount: 1,
      missingResultCount: 0,
      missingResultIds: [],
      completionSource: 'message_content',
      choiceCount: 1
    })
    expect(events[2].completionCharacters).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain('secret-key')
    expect(JSON.stringify(events)).not.toContain('Hello')
    expect(JSON.stringify(events)).not.toContain('你好')
  })

  it('sends Japanese-specific instructions and neighboring context in timeline order', async () => {
    mocks.fetch.mockResolvedValue(completion([{ id: 'b', translation: '已经没事了。' }]))
    const context = [
      japaneseSegment('a', '先生が来てくれた。', '老师赶来了。'),
      japaneseSegment('b', 'もう大丈夫です。'),
      japaneseSegment('c', '本当にありがとう。')
    ]

    await translateWithCompatibleApi(resolved, 'ja', [context[1]], new AbortController().signal, { contextSegments: context })

    const requestBody = JSON.parse(mocks.fetch.mock.calls[0][1].body)
    expect(requestBody.messages[0].content).toContain('主语省略')
    expect(requestBody.messages[0].content).toContain('敬语层级')
    const userMessage = JSON.parse(requestBody.messages[1].content)
    expect(userMessage.context.map((item: { id: string }) => item.id)).toEqual(['a', 'b', 'c'])
    expect(userMessage.context[0]).toMatchObject({ kind: 'reference', existingTranslation: '老师赶来了。' })
    expect(userMessage.context[1]).toMatchObject({ kind: 'translate', text: 'もう大丈夫です。' })
  })

  it('retries Japanese output that merely copies the source text', async () => {
    mocks.fetch
      .mockResolvedValueOnce(completion([{ id: 'a', translation: 'ありがとうございます。' }]))
      .mockResolvedValueOnce(completion([{ id: 'a', translation: '非常感谢。' }]))

    const result = await translateWithCompatibleApi(
      resolved,
      'ja',
      [japaneseSegment('a', 'ありがとうございます。')],
      new AbortController().signal
    )

    expect(result.get('a')).toBe('非常感谢。')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(retryBody.messages[1].content).toContain('属于漏译')
  })

  it('retries without response_format after a compatibility error', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 400 })).mockResolvedValueOnce(completion([{ id: 'a', translation: '你好' }]))
    await translateWithCompatibleApi(resolved, 'en', [segment('a')], new AbortController().signal)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).response_format).toBeUndefined()
  })

  it('hard-disables Qwen3 thinking while retaining the user-level soft switch', async () => {
    mocks.fetch.mockResolvedValue(completion([{ id: 'a', translation: '你好' }]))

    await translateWithCompatibleApi(qwen3Resolved, 'en', [segment('a')], new AbortController().signal)

    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body)
    const userMessage = JSON.parse(body.messages[1].content)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(userMessage.instruction).toContain('/no_think')
    expect(mocks.log.mock.calls[0][0].thinkingControl).toBe('hard-and-soft')
  })

  it('falls back to the soft switch when a server rejects Qwen3 thinking control', async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response('', { status: 422 }))
      .mockResolvedValueOnce(completion([{ id: 'a', translation: '你好' }]))

    const result = await translateWithCompatibleApi(qwen3Resolved, 'en', [segment('a')], new AbortController().signal)

    expect(result.get('a')).toBe('你好')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).chat_template_kwargs).toBeUndefined()
    expect(mocks.log.mock.calls.map(([event]) => event.errorCode).filter(Boolean))
      .toContain('THINKING_CONTROL_UNSUPPORTED')
  })

  it('recovers a reasoning-only batch in small batches before per-segment retries', async () => {
    mocks.fetch
      .mockResolvedValueOnce(reasoningOnlyCompletion())
      .mockResolvedValueOnce(completion([
        { id: 'a', translation: '甲' },
        { id: 'b', translation: '乙' }
      ]))
    const onMissingSegmentRetry = vi.fn()

    const result = await translateWithCompatibleApi(
      resolved,
      'en',
      [segment('a'), segment('b')],
      new AbortController().signal,
      { onMissingSegmentRetry }
    )

    expect([...result.entries()]).toEqual([['a', '甲'], ['b', '乙']])
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(onMissingSegmentRetry).not.toHaveBeenCalled()
    const recoveryBody = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(JSON.parse(recoveryBody.messages[1].content).instruction).toContain('上一次批量响应漏掉')
    const firstSuccess = mocks.log.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === 'request_success')
    expect(firstSuccess).toMatchObject({
      completionSource: 'reasoning_content',
      missingResultIds: ['a', 'b'],
      finishReason: 'length',
      completionTokens: 4096
    })
  })

  it('compensates a missing segment with a single-segment request', async () => {
    mocks.fetch.mockResolvedValueOnce(completion([{ id: 'a', translation: '甲' }])).mockResolvedValueOnce(completion([{ id: 'b', translation: '乙' }]))
    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a'), segment('b')], new AbortController().signal)
    expect(result.get('b')).toBe('乙')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('automatically retries a missing segment up to a successful third compensation', async () => {
    mocks.fetch
      .mockResolvedValueOnce(completion([{ id: 'a', translation: '甲' }]))
      .mockResolvedValueOnce(completion([]))
      .mockResolvedValueOnce(completion([]))
      .mockResolvedValueOnce(completion([{ id: 'b', translation: '乙' }]))

    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a'), segment('b')], new AbortController().signal)

    expect(result.get('b')).toBe('乙')
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
  })

  it('accepts the only translation from a single-item retry when the model rewrites its ID', async () => {
    mocks.fetch
      .mockResolvedValueOnce(completion([{ id: 'a', translation: '甲' }]))
      .mockResolvedValueOnce(completion([{ id: 'wrong-id', translation: '乙' }]))

    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a'), segment('b')], new AbortController().signal)

    expect(result.get('b')).toBe('乙')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back from malformed batch output to unambiguous single-item plain text', async () => {
    mocks.fetch
      .mockResolvedValueOnce(textCompletion('Here are the translations without JSON'))
      .mockResolvedValueOnce(completion([]))
      .mockResolvedValueOnce(textCompletion('甲'))
      .mockResolvedValueOnce(textCompletion('乙'))

    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a'), segment('b')], new AbortController().signal)

    expect(result.get('a')).toBe('甲')
    expect(result.get('b')).toBe('乙')
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
    const firstSuccess = mocks.log.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === 'request_success')
    expect(firstSuccess).toMatchObject({
      resultCount: 0,
      missingResultCount: 2,
      completionSource: 'message_content'
    })
  })

  it('accepts OpenAI content-part arrays containing fenced JSON', async () => {
    mocks.fetch.mockResolvedValue(textCompletion([{ type: 'text', text: '```json\n{"items":[{"id":"a","translation":"你好"}]}\n```' }]))

    const result = await translateWithCompatibleApi(resolved, 'en', [segment('a')], new AbortController().signal)

    expect(result.get('a')).toBe('你好')
  })

  it('reports the retry count only after all missing-segment compensations fail', async () => {
    mocks.fetch.mockImplementation(async () => completion([]))

    await expect(translateWithCompatibleApi(resolved, 'en', [segment('b')], new AbortController().signal))
      .rejects.toThrow('自动重试 3 次')
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
  })

  it('returns a failure result instead of throwing from a connection test', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 401 }))
    const result = await testCompatibleApi(resolved)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('TRANSLATION_API_AUTH')
    expect(result.message).toContain('API Key')
  })

  it('bypasses the Chromium system proxy for a private-network service', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(completion([{ id: 'a', translation: '你好' }]))
    try {
      const result = await translateWithCompatibleApi(lanResolved, 'en', [segment('a')], new AbortController().signal)

      expect(result.get('a')).toBe('你好')
      expect(directFetch).toHaveBeenCalledWith(
        'http://192.168.1.80:8000/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      )
      expect(mocks.fetch).not.toHaveBeenCalled()
    } finally {
      directFetch.mockRestore()
    }
  })

  it('explains how to recover from a refused local connection', () => {
    const error = describeTranslationNetworkError('http://127.0.0.1:11434/v1', new Error('net::ERR_CONNECTION_REFUSED')) as Error & { code?: string }
    expect(error.code).toBe('TRANSLATION_API_NETWORK')
    expect(error.message).toContain('0.0.0.0')
    expect(error.message).toContain('防火墙')
  })

  it('reads nested Node fetch error codes', () => {
    const cause = Object.assign(new Error('connection failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const error = describeTranslationNetworkError(lanResolved.profile.baseUrl!, Object.assign(new Error('fetch failed'), { cause })) as Error & { code?: string }

    expect(error.code).toBe('TRANSLATION_API_TIMEOUT')
    expect(error.message).toContain('0.0.0.0')
  })
})
