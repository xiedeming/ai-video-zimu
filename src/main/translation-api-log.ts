import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getAppPaths } from './constants'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_TEXT_LENGTH = 500

export type TranslationApiLogEvent = {
  event: 'request_start' | 'response_headers' | 'request_success' | 'request_retry' | 'request_error' | 'request_timeout' | 'request_canceled'
  requestId: string
  endpoint: string
  transport: 'direct' | 'electron-net'
  model: string
  promptVersion?: string
  promptSha256?: string
  language?: 'ja' | 'en'
  temperature?: number
  maxTokens?: number
  correctionApplied?: boolean
  thinkingControl?: 'hard-and-soft' | 'soft'
  attempt?: number
  jsonMode?: boolean
  timeoutMs?: number
  segmentCount?: number
  segmentIds?: string[]
  contextCount?: number
  contextTranslateCount?: number
  contextReferenceCount?: number
  contextCharacters?: number
  existingTranslationCount?: number
  existingTranslationCharacters?: number
  sourceCharacters?: number
  sourceKanaCharacters?: number
  sourceHanCharacters?: number
  sourceLatinCharacters?: number
  sourceDigitCharacters?: number
  sourceLineBreaks?: number
  status?: number
  responseContentType?: string
  responseContentLength?: number
  durationMs?: number
  retryDelayMs?: number
  resultCount?: number
  missingResultCount?: number
  missingResultIds?: string[]
  completionSource?: 'message_content' | 'choice_text' | 'output_text' | 'reasoning_content' | 'empty'
  completionCharacters?: number
  reasoningCharacters?: number
  choiceCount?: number
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  errorName?: string
  errorCode?: string
  errorMessage?: string
}

let writeQueue = Promise.resolve()

export function safeTranslationLogEndpoint(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[invalid-endpoint]'
  }
}

export function redactTranslationLogText(value: string, secrets: Array<string | undefined> = []): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret?.trim()) redacted = redacted.split(secret).join('[REDACTED]')
  }
  redacted = redacted
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
  return redacted.slice(0, MAX_TEXT_LENGTH)
}

export function translationLogError(error: unknown, secrets: Array<string | undefined> = []): {
  errorName: string
  errorCode?: string
  errorMessage: string
} {
  if (!(error instanceof Error)) {
    return { errorName: 'UnknownError', errorMessage: redactTranslationLogText(String(error), secrets) }
  }
  const code = (error as Error & { code?: unknown }).code
  return {
    errorName: redactTranslationLogText(error.name || 'Error'),
    ...(code ? { errorCode: redactTranslationLogText(String(code)) } : {}),
    errorMessage: redactTranslationLogText(error.message, secrets)
  }
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  const size = await stat(filePath).then((value) => value.size).catch(() => 0)
  if (size < MAX_LOG_BYTES) return
  const previous = `${filePath}.1`
  await unlink(previous).catch(() => undefined)
  await rename(filePath, previous)
}

export function writeTranslationApiLog(event: TranslationApiLogEvent): void {
  const safeEvent = {
    timestamp: new Date().toISOString(),
    ...event,
    endpoint: safeTranslationLogEndpoint(event.endpoint),
    model: redactTranslationLogText(event.model),
    ...(event.segmentIds ? { segmentIds: event.segmentIds.slice(0, 50).map((id) => redactTranslationLogText(id)) } : {}),
    ...(event.missingResultIds
      ? { missingResultIds: event.missingResultIds.slice(0, 50).map((id) => redactTranslationLogText(id)) }
      : {}),
    ...(event.errorName ? { errorName: redactTranslationLogText(event.errorName) } : {}),
    ...(event.errorCode ? { errorCode: redactTranslationLogText(event.errorCode) } : {}),
    ...(event.errorMessage ? { errorMessage: redactTranslationLogText(event.errorMessage) } : {})
  }
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const filePath = getAppPaths().translationApiLog
      await mkdir(dirname(filePath), { recursive: true })
      await rotateIfNeeded(filePath)
      await appendFile(filePath, `${JSON.stringify(safeEvent)}\n`, 'utf8')
    })
    .catch(() => {
      console.warn('无法写入翻译 API 诊断日志')
    })
}

export async function flushTranslationApiLogs(): Promise<void> {
  await writeQueue
}
