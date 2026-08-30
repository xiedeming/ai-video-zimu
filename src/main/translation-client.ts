import { net } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type { ResolvedLanguage, SubtitleSegment, TranslationProfileTestResult } from '../shared/types'
import { parseTranslationJson, stripModelThinking } from '../shared/translation'
import { translationLogError, writeTranslationApiLog } from './translation-api-log'
import type { ResolvedTranslationProfile } from './translation-profile-manager'
import { isPrivateNetworkUrl } from './translation-network'

interface TranslationResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown }
    text?: unknown
    finish_reason?: unknown
  }>
  output_text?: unknown
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
}

const MISSING_SEGMENT_RETRY_LIMIT = 3
const MISSING_BATCH_RETRY_SIZE = 4
const CONTEXT_RADIUS = 2
const TRANSLATION_REQUEST_TIMEOUT_MS = 10 * 60_000
const CONNECTION_TEST_TIMEOUT_MS = 3 * 60_000
const TRANSLATION_PROMPT_VERSION = '2026-08-29.3'
const TRANSLATION_TEMPERATURE = 0.15
const TRANSLATION_MAX_TOKENS = 4096

interface TranslationPayloadItem {
  id: string
  text: string
}

interface TranslationContextItem extends TranslationPayloadItem {
  kind: 'translate' | 'reference'
  existingTranslation?: string
}

interface TranslationRequestOptions {
  contextSegments?: SubtitleSegment[]
  onMissingSegmentRetry?: (segmentId: string, attempt: number, limit: number) => void
  requestTimeoutMs?: number
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(codedError('任务已取消', 'CANCELED'))
    }, { once: true })
  })
}

function serviceError(status: number): Error {
  if (status === 401 || status === 403) return codedError('翻译 API 鉴权失败，请检查 API Key', 'TRANSLATION_API_AUTH')
  if (status === 404) return codedError('翻译 API 地址或模型不存在，请检查 Base URL 和模型名', 'TRANSLATION_API_NOT_FOUND')
  if (status === 429) return codedError('翻译 API 请求过于频繁，请稍后重试', 'TRANSLATION_API_RATE_LIMIT')
  if (status >= 500) return codedError(`翻译 API 服务暂时不可用（HTTP ${status}）`, 'TRANSLATION_API_SERVER')
  return codedError(`翻译 API 请求失败（HTTP ${status}）`, 'TRANSLATION_API_REQUEST')
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
    const dateDelay = Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(dateDelay, 30_000)
  }
  return 1000 * 2 ** attempt
}

function systemPrompt(language: ResolvedLanguage): string {
  const languageName = language === 'ja' ? '日语' : '英语'
  const languageRules = language === 'ja'
    ? '准确处理日语的主语省略、敬语层级、授受关系、使役被动、否定、反问和句末语气；只能根据上下文补足中文表达必需的信息，不得臆造人物、性别或主语。结合上下文辨别同音词、专名和跨字幕断开的句子。'
    : '准确处理英语中的指代、时态、否定、反问、习语和跨字幕断开的句子；只能根据上下文补足中文表达必需的信息。'
  return [
    `你是专业影视字幕译者。任务是把${languageName}字幕翻译为简体中文。`,
    '先按时间顺序理解 context 中的完整语境，再翻译 kind 为 translate 的条目；kind 为 reference 的条目只用于理解语境，严禁输出。',
    languageRules,
    '忠实保留事实、称谓、人物关系、语气、情绪、笑点和信息强度。人名、地名、作品名及术语在上下文中必须一致；已有邻近译文可作为用词参考，但原文含义优先。',
    '译文应像自然、简洁的中文影视字幕，避免逐字硬译。不要解释、概括、扩写、弱化粗口或添加原文没有的信息。不要合并或拆分条目。',
    '每个待翻译 id 必须原样返回且恰好返回一次。只返回 JSON，不得输出 Markdown 或说明：{"items":[{"id":"原ID","translation":"中文"}]}'
  ].join('\n')
}

function translationContext(
  payload: TranslationPayloadItem[],
  contextSegments: SubtitleSegment[]
): TranslationContextItem[] {
  const targetIds = new Set(payload.map((item) => item.id))
  const indexes = new Map(contextSegments.map((segment, index) => [segment.id, index]))
  const included = new Set<number>()

  for (const item of payload) {
    const index = indexes.get(item.id)
    if (index === undefined) continue
    for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
      const candidate = index + offset
      if (candidate >= 0 && candidate < contextSegments.length) included.add(candidate)
    }
  }

  if (!included.size) {
    return payload.map((item) => ({ ...item, kind: 'translate' }))
  }

  return [...included]
    .sort((left, right) => left - right)
    .map((index) => {
      const segment = contextSegments[index]
      const target = targetIds.has(segment.id)
      return {
        id: segment.id,
        text: segment.sourceText,
        kind: target ? 'translate' : 'reference',
        ...(!target && segment.translatedText.trim()
          ? { existingTranslation: segment.translatedText.trim() }
          : {})
      }
    })
}

function isUntranslatedJapanese(source: string, translation: string): boolean {
  const normalize = (value: string): string => value.normalize('NFKC').replace(/[\s。、！？!?…・「」『』（）()]/g, '')
  const normalizedSource = normalize(source)
  if (normalizedSource !== normalize(translation)) return false
  return (normalizedSource.match(/[\u3040-\u30ff]/g)?.length ?? 0) >= 2
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object') {
      const item = part as Record<string, unknown>
      return contentText(item.text ?? item.content)
    }
    return ''
  }).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return contentText(item.text ?? item.content)
  }
  return ''
}

type CompletionContent = {
  text: string
  allowPlainText: boolean
  source: 'message_content' | 'choice_text' | 'output_text' | 'reasoning_content' | 'empty'
}

function completionContent(response: TranslationResponse): CompletionContent {
  const choice = response.choices?.[0]
  const messageContent = contentText(choice?.message?.content)
  if (messageContent.trim()) return { text: messageContent, allowPlainText: true, source: 'message_content' }
  const choiceText = contentText(choice?.text)
  if (choiceText.trim()) return { text: choiceText, allowPlainText: true, source: 'choice_text' }
  const outputText = contentText(response.output_text)
  if (outputText.trim()) return { text: outputText, allowPlainText: true, source: 'output_text' }
  const reasoningContent = contentText(choice?.message?.reasoning_content)
  if (reasoningContent.trim()) return { text: reasoningContent, allowPlainText: false, source: 'reasoning_content' }
  return { text: '', allowPlainText: false, source: 'empty' }
}

function parseCompletion(response: TranslationResponse, payload: TranslationPayloadItem[], content = completionContent(response)): Map<string, string> {
  try {
    return parseTranslationJson(content.text)
  } catch (error) {
    if ((error as { code?: string }).code !== 'TRANSLATION_JSON_INVALID') throw error
    const plain = stripModelThinking(content.text).trim()
    if (payload.length === 1 && content.allowPlainText && plain && !/^[{[]/.test(plain)) {
      return new Map([[payload[0].id, plain]])
    }
    // A malformed batch is recoverable: the caller will retry every missing item separately.
    return new Map()
  }
}

function networkErrorDetails(error: unknown): string {
  const details: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (!(current instanceof Error)) {
      details.push(String(current))
      break
    }
    details.push(current.message)
    const code = (current as Error & { code?: unknown }).code
    if (code) details.push(String(code))
    current = (current as Error & { cause?: unknown }).cause
  }
  return details.filter(Boolean).join(' · ')
}

export function describeTranslationNetworkError(baseUrl: string, error: unknown): Error {
  const detail = networkErrorDetails(error)
  const endpoint = baseUrl.replace(/\/$/, '')
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(detail)) {
    return codedError(
      `无法连接翻译服务 ${endpoint}：连接被拒绝。请确认服务已启动、监听 0.0.0.0（而非仅 127.0.0.1），并在服务器防火墙中放行该端口。`,
      'TRANSLATION_API_NETWORK'
    )
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(detail)) {
    return codedError(`无法解析翻译服务地址 ${endpoint}，请检查域名或网络连接。`, 'TRANSLATION_API_NETWORK')
  }
  if (/timeout|timed out|aborted/i.test(detail)) {
    const hint = isPrivateNetworkUrl(baseUrl)
      ? '请确认服务监听 0.0.0.0、服务器防火墙已放行端口，并从本机直接访问该地址测试。'
      : '请确认服务正在运行并可访问。'
    return codedError(`连接翻译服务 ${endpoint} 超时。${hint}`, 'TRANSLATION_API_TIMEOUT')
  }
  return codedError(`无法连接翻译 API ${endpoint}：${detail || '网络错误'}`, 'TRANSLATION_API_NETWORK')
}

function fetchTranslationEndpoint(url: string, init: RequestInit): Promise<Response> {
  // Electron's network stack follows the OS proxy. Bypass it for an explicitly configured
  // private endpoint so LAN traffic is sent directly to the translation server.
  return isPrivateNetworkUrl(url) ? globalThis.fetch(url, init) : net.fetch(url, init)
}

function supportsQwenThinkingControl(model: string): boolean {
  return /(?:^|[\/_-])qwen3(?:$|[\/_-])/i.test(model)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function requestCompletion(
  resolved: ResolvedTranslationProfile,
  language: ResolvedLanguage,
  payload: TranslationPayloadItem[],
  context: TranslationContextItem[],
  signal: AbortSignal,
  jsonMode = true,
  correction?: string,
  requestTimeoutMs = TRANSLATION_REQUEST_TIMEOUT_MS,
  requestId = randomUUID(),
  hardDisableThinking = supportsQwenThinkingControl(resolved.profile.model)
): Promise<Map<string, string>> {
  const baseUrl = resolved.profile.baseUrl!
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const transport = isPrivateNetworkUrl(url) ? 'direct' as const : 'electron-net' as const
  const systemMessage = systemPrompt(language)
  const countSourceCharacters = (pattern: RegExp) => payload.reduce((total, item) => total + (item.text.match(pattern)?.length ?? 0), 0)
  const logBase = {
    requestId,
    endpoint: url,
    transport,
    model: resolved.profile.model,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    promptSha256: createHash('sha256').update(systemMessage).digest('hex'),
    language,
    temperature: TRANSLATION_TEMPERATURE,
    maxTokens: TRANSLATION_MAX_TOKENS,
    correctionApplied: Boolean(correction),
    thinkingControl: hardDisableThinking ? 'hard-and-soft' as const : 'soft' as const,
    segmentCount: payload.length,
    segmentIds: payload.map((item) => item.id),
    contextCount: context.length,
    contextTranslateCount: context.filter((item) => item.kind === 'translate').length,
    contextReferenceCount: context.filter((item) => item.kind === 'reference').length,
    contextCharacters: context.reduce((total, item) => total + item.text.length, 0),
    existingTranslationCount: context.filter((item) => Boolean(item.existingTranslation)).length,
    existingTranslationCharacters: context.reduce((total, item) => total + (item.existingTranslation?.length ?? 0), 0),
    sourceCharacters: payload.reduce((total, item) => total + item.text.length, 0),
    sourceKanaCharacters: countSourceCharacters(/[\u3040-\u30ff]/g),
    sourceHanCharacters: countSourceCharacters(/[\u3400-\u9fff]/g),
    sourceLatinCharacters: countSourceCharacters(/[A-Za-z]/g),
    sourceDigitCharacters: countSourceCharacters(/[0-9]/g),
    sourceLineBreaks: countSourceCharacters(/\r?\n/g),
    timeoutMs: requestTimeoutMs
  }
  let lastError: unknown

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw codedError('任务已取消', 'CANCELED')
    const requestController = new AbortController()
    const cancel = () => requestController.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    let requestTimedOut = false
    const timeout = setTimeout(() => {
      requestTimedOut = true
      requestController.abort(new Error('翻译请求超时'))
    }, requestTimeoutMs)
    const startedAt = Date.now()
    writeTranslationApiLog({ ...logBase, event: 'request_start', attempt: attempt + 1, jsonMode })

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`
      const baseInstruction = payload.length === 1
        ? `只翻译 id 为 ${payload[0].id} 的条目，只返回一个 items 元素。`
        : '只翻译 context 中 kind 为 translate 的条目。'
      const userInstruction = [baseInstruction, correction, '/no_think'].filter(Boolean).join('\n')
      const body: Record<string, unknown> = {
        model: resolved.profile.model,
        temperature: TRANSLATION_TEMPERATURE,
        max_tokens: TRANSLATION_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemMessage },
          {
            role: 'user',
            content: JSON.stringify({
              instruction: userInstruction,
              context
            })
          }
        ]
      }
      if (hardDisableThinking) body.chat_template_kwargs = { enable_thinking: false }
      if (jsonMode) body.response_format = { type: 'json_object' }

      const response = await fetchTranslationEndpoint(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: requestController.signal
      })
      writeTranslationApiLog({
        ...logBase,
        event: 'response_headers',
        attempt: attempt + 1,
        jsonMode,
        status: response.status,
        responseContentType: response.headers.get('content-type') ?? undefined,
        responseContentLength: Number(response.headers.get('content-length')) || undefined,
        durationMs: Date.now() - startedAt
      })
      if (response.ok) {
        let data: TranslationResponse
        try {
          data = await response.json() as TranslationResponse
        } catch {
          throw codedError('翻译 API 返回的响应不是有效 JSON，请检查服务的 OpenAI 兼容模式', 'TRANSLATION_API_RESPONSE_INVALID')
        }
        const content = completionContent(data)
        const reasoningCharacters = contentText(data.choices?.[0]?.message?.reasoning_content).length
        const result = parseCompletion(data, payload, content)
        const missingResultIds = payload.filter((item) => !result.has(item.id)).map((item) => item.id)
        writeTranslationApiLog({
          ...logBase,
          event: 'request_success',
          attempt: attempt + 1,
          jsonMode,
          status: response.status,
          durationMs: Date.now() - startedAt,
          resultCount: result.size,
          missingResultCount: missingResultIds.length,
          missingResultIds,
          completionSource: content.source,
          completionCharacters: content.text.length,
          reasoningCharacters,
          choiceCount: data.choices?.length ?? 0,
          finishReason: typeof data.choices?.[0]?.finish_reason === 'string' ? data.choices[0].finish_reason : undefined,
          promptTokens: finiteNumber(data.usage?.prompt_tokens),
          completionTokens: finiteNumber(data.usage?.completion_tokens),
          totalTokens: finiteNumber(data.usage?.total_tokens)
        })
        return result
      }
      if ((response.status === 400 || response.status === 422) && hardDisableThinking) {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_retry',
          attempt: attempt + 1,
          jsonMode,
          status: response.status,
          durationMs: Date.now() - startedAt,
          errorCode: 'THINKING_CONTROL_UNSUPPORTED'
        })
        return requestCompletion(
          resolved, language, payload, context, signal, jsonMode, correction,
          requestTimeoutMs, requestId, false
        )
      }
      if (response.status === 400 && jsonMode) {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_retry',
          attempt: attempt + 1,
          jsonMode,
          status: response.status,
          durationMs: Date.now() - startedAt,
          errorCode: 'JSON_MODE_UNSUPPORTED'
        })
        return requestCompletion(
          resolved, language, payload, context, signal, false, correction,
          requestTimeoutMs, requestId, hardDisableThinking
        )
      }

      const error = serviceError(response.status)
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const delayMs = retryDelay(response.headers.get('retry-after'), attempt)
        lastError = error
        writeTranslationApiLog({
          ...logBase,
          event: 'request_retry',
          attempt: attempt + 1,
          jsonMode,
          status: response.status,
          durationMs: Date.now() - startedAt,
          retryDelayMs: delayMs,
          ...translationLogError(error, [resolved.apiKey])
        })
        await abortableDelay(delayMs, signal)
        continue
      }
      throw error
    } catch (error) {
      if (signal.aborted) {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_canceled',
          attempt: attempt + 1,
          jsonMode,
          durationMs: Date.now() - startedAt
        })
        throw codedError('任务已取消', 'CANCELED')
      }
      if (requestTimedOut) {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_timeout',
          attempt: attempt + 1,
          jsonMode,
          durationMs: Date.now() - startedAt,
          errorCode: 'TRANSLATION_API_TIMEOUT'
        })
        throw codedError(
          `翻译服务 ${baseUrl.replace(/\/$/, '')} 在 ${Math.round(requestTimeoutMs / 1000)} 秒内未返回结果。请检查服务负载或减小单次翻译批量。`,
          'TRANSLATION_API_TIMEOUT'
        )
      }
      lastError = error
      const code = (error as { code?: string }).code
      if (code?.startsWith('TRANSLATION_API_')) {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_error',
          attempt: attempt + 1,
          jsonMode,
          durationMs: Date.now() - startedAt,
          ...translationLogError(error, [resolved.apiKey])
        })
        throw error
      }
      if (attempt < 2) {
        const delayMs = 1000 * 2 ** attempt
        writeTranslationApiLog({
          ...logBase,
          event: 'request_retry',
          attempt: attempt + 1,
          jsonMode,
          durationMs: Date.now() - startedAt,
          retryDelayMs: delayMs,
          ...translationLogError(error, [resolved.apiKey])
        })
        await abortableDelay(delayMs, signal)
      } else {
        writeTranslationApiLog({
          ...logBase,
          event: 'request_error',
          attempt: attempt + 1,
          jsonMode,
          durationMs: Date.now() - startedAt,
          ...translationLogError(error, [resolved.apiKey])
        })
      }
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
    }
  }

  throw describeTranslationNetworkError(baseUrl, lastError)
}

export async function translateWithCompatibleApi(
  resolved: ResolvedTranslationProfile,
  language: ResolvedLanguage,
  segments: SubtitleSegment[],
  signal: AbortSignal,
  options: TranslationRequestOptions = {}
): Promise<Map<string, string>> {
  const payload = segments.map(({ id, sourceText }) => ({ id, text: sourceText }))
  const context = translationContext(payload, options.contextSegments ?? segments)
  const requestTimeoutMs = options.requestTimeoutMs ?? TRANSLATION_REQUEST_TIMEOUT_MS
  const rawResult = await requestCompletion(resolved, language, payload, context, signal, true, undefined, requestTimeoutMs)
  const batchMissing = segments.filter((segment) => !rawResult.has(segment.id))
  if (batchMissing.length > 1) {
    for (let index = 0; index < batchMissing.length; index += MISSING_BATCH_RETRY_SIZE) {
      const retrySegments = batchMissing.slice(index, index + MISSING_BATCH_RETRY_SIZE)
      const retryPayload = retrySegments.map(({ id, sourceText }) => ({ id, text: sourceText }))
      const retryContext = translationContext(retryPayload, options.contextSegments ?? segments)
      const retry = await requestCompletion(
        resolved,
        language,
        retryPayload,
        retryContext,
        signal,
        true,
        '上一次批量响应漏掉了这些条目。禁止思考和解释，必须返回每个 id 的 JSON 译文。',
        requestTimeoutMs
      )
      for (const [id, translation] of retry) {
        if (retrySegments.some((segment) => segment.id === id)) rawResult.set(id, translation)
      }
    }
  }
  const result = new Map<string, string>()
  for (const segment of segments) {
    const translation = rawResult.get(segment.id)
    if (translation && !(language === 'ja' && isUntranslatedJapanese(segment.sourceText, translation))) {
      result.set(segment.id, translation)
    }
  }

  for (const segment of segments.filter((item) => !result.has(item.id))) {
    let recovered: string | undefined
    const untranslated = language === 'ja' && Boolean(rawResult.get(segment.id))
    for (let attempt = 1; attempt <= MISSING_SEGMENT_RETRY_LIMIT && !recovered; attempt += 1) {
      options.onMissingSegmentRetry?.(segment.id, attempt, MISSING_SEGMENT_RETRY_LIMIT)
      const retryPayload = [{ id: segment.id, text: segment.sourceText }]
      const retryContext = translationContext(retryPayload, options.contextSegments ?? segments)
      const retry = await requestCompletion(
        resolved,
        language,
        retryPayload,
        retryContext,
        signal,
        true,
        untranslated ? '上一版与日语原文相同，属于漏译；请结合语境改为自然的简体中文。' : undefined,
        requestTimeoutMs
      )
      recovered = retry.get(segment.id)
      // A single-item retry is unambiguous even when the model accidentally rewrites the ID.
      if (!recovered && retry.size === 1) recovered = retry.values().next().value
      if (recovered && language === 'ja' && isUntranslatedJapanese(segment.sourceText, recovered)) recovered = undefined
    }
    if (!recovered) {
      throw codedError(
        `翻译结果缺少字幕段 ${segment.id}，单段补偿已自动重试 ${MISSING_SEGMENT_RETRY_LIMIT} 次`,
        'TRANSLATION_RESULT_INCOMPLETE'
      )
    }
    result.set(segment.id, recovered)
  }
  return result
}

export async function testCompatibleApi(resolved: ResolvedTranslationProfile): Promise<TranslationProfileTestResult> {
  const startedAt = Date.now()
  const segment: SubtitleSegment = {
    id: 'connection-test', startMs: 0, endMs: 1000, sourceText: 'Hello.', translatedText: '', words: [], confidence: 1, status: 'generated'
  }
  try {
    await translateWithCompatibleApi(resolved, 'en', [segment], new AbortController().signal, {
      requestTimeoutMs: CONNECTION_TEST_TIMEOUT_MS
    })
    return { ok: true, latencyMs: Date.now() - startedAt, model: resolved.profile.model, message: '连接成功' }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: resolved.profile.model,
      message: error instanceof Error ? error.message : '翻译服务测试失败',
      errorCode: (error as { code?: string }).code ?? 'TRANSLATION_API_TEST_FAILED'
    }
  }
}
