import type { ExportContent, ExportFormat, SubtitleSegment, WordTiming } from './types'

export interface SubtitleValidationIssue {
  segmentId: string
  type: 'negative' | 'invalid-range' | 'overlap' | 'empty'
  message: string
}

export interface MergeAdjacentDuplicateOptions {
  maxGapMs?: number
  protectEdited?: boolean
}

export interface MergeAdjacentDuplicateResult {
  segments: SubtitleSegment[]
  mergedCount: number
  skippedConflictCount: number
}

export interface SynchronizeSubtitleTimingOptions {
  leadInMs?: number
  tailPaddingMs?: number
  mediaDurationMs?: number
}

export function untranslatedSegmentIds(segments: SubtitleSegment[]): string[] {
  return segments
    .filter((segment) => segment.sourceText.trim() && !segment.translatedText.trim())
    .map((segment) => segment.id)
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

export function formatTimecode(ms: number, separator = '.'): string {
  const safe = Math.max(0, Math.round(ms))
  const hours = Math.floor(safe / 3_600_000)
  const minutes = Math.floor((safe % 3_600_000) / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const millis = safe % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`
}

export function parseTimecode(value: string): number | null {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[.,:](\d{1,3})$/)
  if (!match) return null
  const [, h, m, s, fraction] = match
  const minutes = Number(m)
  const seconds = Number(s)
  if (minutes > 59 || seconds > 59) return null
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3))
  return Number(h) * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis
}

export function validateSegments(segments: SubtitleSegment[]): SubtitleValidationIssue[] {
  const issues: SubtitleValidationIssue[] = []
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  sorted.forEach((segment, index) => {
    if (segment.startMs < 0 || segment.endMs < 0) {
      issues.push({ segmentId: segment.id, type: 'negative', message: '时间码不能为负数' })
    }
    if (segment.endMs <= segment.startMs) {
      issues.push({ segmentId: segment.id, type: 'invalid-range', message: '结束时间必须晚于开始时间' })
    }
    if (!segment.sourceText.trim() && !segment.translatedText.trim()) {
      issues.push({ segmentId: segment.id, type: 'empty', message: '字幕内容不能为空' })
    }
    if (index > 0 && sorted[index - 1].endMs > segment.startMs) {
      issues.push({ segmentId: segment.id, type: 'overlap', message: '时间码与上一段重叠' })
    }
  })
  return issues
}

/**
 * Removes overlaps without moving the following subtitle in the common case:
 * the previous subtitle is shortened to the next subtitle's start time.
 * For equal starts, a minimal positive boundary is created when possible.
 */
export function repairSegmentOverlaps(segments: SubtitleSegment[], segmentIds?: Iterable<string>): SubtitleSegment[] {
  const targets = segmentIds ? new Set(segmentIds) : undefined
  const cloned = segments.map((segment) => ({ ...segment, words: [...segment.words] }))
  const sorted = [...cloned].sort((a, b) => a.startMs - b.startMs)

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    if (previous.endMs <= current.startMs || (targets && !targets.has(current.id))) continue

    if (current.startMs > previous.startMs) {
      previous.endMs = current.startMs
      previous.status = 'edited'
      continue
    }

    const boundary = previous.startMs + 1
    if (boundary < current.endMs) {
      previous.endMs = boundary
      current.startMs = boundary
      previous.status = 'edited'
      current.status = 'edited'
    }
  }

  return cloned
}

/**
 * Adds a small, gap-aware display margin around generated speech timings.
 * Adjacent cues meet at a shared boundary so the margins never create an
 * overlap, while longer silences remain subtitle-free.
 */
export function synchronizeSubtitleTimings(
  input: SubtitleSegment[],
  options: SynchronizeSubtitleTimingOptions = {}
): SubtitleSegment[] {
  const leadInMs = Math.max(0, Math.round(options.leadInMs ?? 100))
  const tailPaddingMs = Math.max(0, Math.round(options.tailPaddingMs ?? 200))
  const mediaDurationMs = Number.isFinite(options.mediaDurationMs) && (options.mediaDurationMs ?? 0) > 0
    ? Math.round(options.mediaDurationMs!)
    : Number.POSITIVE_INFINITY
  const original = input
    .map((segment) => ({ ...segment, words: segment.words.map((word) => ({ ...word })) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const synchronized = original.map((segment) => {
    const latestStartMs = Number.isFinite(mediaDurationMs) ? Math.max(0, mediaDurationMs - 1) : segment.startMs
    const startMs = Math.min(latestStartMs, Math.max(0, segment.startMs - leadInMs))
    const paddedEndMs = Math.min(mediaDurationMs, segment.endMs + tailPaddingMs)
    const endMs = Math.max(startMs + 1, paddedEndMs)
    return { ...segment, startMs, endMs }
  })

  for (let index = 0; index < synchronized.length - 1; index += 1) {
    const current = synchronized[index]
    const next = synchronized[index + 1]
    if (current.endMs <= next.startMs) continue

    const earliestBoundary = Math.max(current.startMs + 1, next.startMs)
    const latestBoundary = Math.min(current.endMs, next.endMs - 1)
    if (earliestBoundary <= latestBoundary) {
      const speechGapMidpoint = Math.round((original[index].endMs + original[index + 1].startMs) / 2)
      const boundary = Math.max(earliestBoundary, Math.min(latestBoundary, speechGapMidpoint))
      current.endMs = boundary
      next.startMs = boundary
    }
  }

  return synchronized
}

function normalizedDuplicateText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

function mergeWords(left: WordTiming[], right: WordTiming[]): WordTiming[] {
  const unique = new Map<string, WordTiming>()
  for (const word of [...left, ...right]) {
    const key = `${word.text}\u0000${word.startMs}\u0000${word.endMs}`
    if (!unique.has(key)) unique.set(key, { ...word })
  }
  return [...unique.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

function confidenceWeight(segment: SubtitleSegment): number {
  return Math.max(1, segment.words.length)
}

function hasProtectedEdit(segment: SubtitleSegment): boolean {
  return segment.status === 'edited' || segment.status === 'reviewed'
}

export function mergeAdjacentDuplicateSegments(
  input: SubtitleSegment[],
  options: MergeAdjacentDuplicateOptions = {}
): MergeAdjacentDuplicateResult {
  const maxGapMs = Math.max(0, options.maxGapMs ?? 1000)
  const protectEdited = options.protectEdited ?? false
  const sorted = input.map((segment) => ({ ...segment, words: segment.words.map((word) => ({ ...word })) }))
    .sort((a, b) => a.startMs - b.startMs)
  const segments: SubtitleSegment[] = []
  let mergedCount = 0
  let skippedConflictCount = 0

  for (const current of sorted) {
    const previous = segments.at(-1)
    if (!previous) { segments.push(current); continue }
    const previousText = normalizedDuplicateText(previous.sourceText)
    const currentText = normalizedDuplicateText(current.sourceText)
    const gapMs = current.startMs - previous.endMs
    if (!previousText || previousText !== currentText || gapMs > maxGapMs) {
      segments.push(current)
      continue
    }

    const previousTranslation = normalizedDuplicateText(previous.translatedText)
    const currentTranslation = normalizedDuplicateText(current.translatedText)
    const translationConflict = Boolean(previousTranslation && currentTranslation && previousTranslation !== currentTranslation)
    if ((protectEdited && (hasProtectedEdit(previous) || hasProtectedEdit(current))) || translationConflict) {
      skippedConflictCount += 1
      segments.push(current)
      continue
    }

    const previousWeight = confidenceWeight(previous)
    const currentWeight = confidenceWeight(current)
    const confidence = (previous.confidence * previousWeight + current.confidence * currentWeight) / (previousWeight + currentWeight)
    const words = mergeWords(previous.words, current.words)
    segments[segments.length - 1] = {
      ...previous,
      startMs: Math.min(previous.startMs, current.startMs),
      endMs: Math.max(previous.endMs, current.endMs),
      translatedText: previous.translatedText.trim() ? previous.translatedText : current.translatedText,
      words,
      confidence,
      status: confidence < 0.65 ? 'warning' : 'generated'
    }
    mergedCount += 1
  }

  return { segments, mergedCount, skippedConflictCount }
}

function contentFor(segment: SubtitleSegment, content: ExportContent): string {
  if (content === 'source') return segment.sourceText.trim()
  if (content === 'translation') return segment.translatedText.trim()
  return [segment.sourceText.trim(), segment.translatedText.trim()].filter(Boolean).join('\n')
}

function escapeAss(text: string): string {
  return text.replace(/\r?\n/g, '\\N').replace(/[{}]/g, '')
}

export function serializeSubtitles(
  segments: SubtitleSegment[],
  format: ExportFormat,
  content: ExportContent
): string {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  if (format === 'srt') {
    return sorted
      .map((segment, index) =>
        `${index + 1}\n${formatTimecode(segment.startMs, ',')} --> ${formatTimecode(segment.endMs, ',')}\n${contentFor(segment, content)}`
      )
      .join('\n\n') + '\n'
  }
  if (format === 'vtt') {
    return `WEBVTT\n\n${sorted
      .map((segment) => `${formatTimecode(segment.startMs)} --> ${formatTimecode(segment.endMs)}\n${contentFor(segment, content)}`)
      .join('\n\n')}\n`
  }
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei UI,52,&H00FFFFFF,&H000000FF,&H00101824,&H98000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,64,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const assTime = (ms: number, roundUp = false) => {
    const centiseconds = Math.max(0, roundUp ? Math.ceil(ms / 10) : Math.floor(ms / 10))
    const hours = Math.floor(centiseconds / 360_000)
    const minutes = Math.floor((centiseconds % 360_000) / 6000)
    const seconds = Math.floor((centiseconds % 6000) / 100)
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds % 100)}`
  }
  const body = sorted.map((segment) =>
    `Dialogue: 0,${assTime(segment.startMs)},${assTime(segment.endMs, true)},Default,,0,0,0,,${escapeAss(contentFor(segment, content))}`
  )
  return `${header}\n${body.join('\n')}\n`
}

export interface WhisperTokenLike {
  text?: string
  word?: string
  timestamps?: { from?: string; to?: string }
  offsets?: { from?: number; to?: number }
  p?: number
  probability?: number
}

export interface WhisperSegmentLike {
  text?: string
  timestamps?: { from?: string; to?: string }
  offsets?: { from?: number; to?: number }
  tokens?: WhisperTokenLike[]
}

function tokenToWord(token: WhisperTokenLike): WordTiming | null {
  const text = (token.text ?? token.word ?? '').trim()
  if (!text || /^\[_.*\]$/u.test(text) || /^<\|.*\|>$/u.test(text)) return null
  const startMs = token.offsets?.from ?? (token.timestamps?.from ? parseTimecode(token.timestamps.from) : null)
  const endMs = token.offsets?.to ?? (token.timestamps?.to ? parseTimecode(token.timestamps.to) : null)
  if (
    startMs === null || endMs === null || startMs === undefined || endMs === undefined ||
    !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs
  ) return null
  return { text, startMs, endMs, probability: token.p ?? token.probability }
}

export function normalizeWhisperSegments(raw: WhisperSegmentLike[]): SubtitleSegment[] {
  return raw.flatMap((segment, index): SubtitleSegment[] => {
      const words = (segment.tokens ?? []).map(tokenToWord).filter((word): word is WordTiming => Boolean(word))
      const startMs = segment.offsets?.from ?? (segment.timestamps?.from ? parseTimecode(segment.timestamps.from) : null) ?? words[0]?.startMs
      const endMs = segment.offsets?.to ?? (segment.timestamps?.to ? parseTimecode(segment.timestamps.to) : null) ?? words.at(-1)?.endMs
      if (startMs === undefined || startMs === null || endMs === undefined || endMs === null || endMs <= startMs) return []
      const probabilities = words.map((word) => word.probability).filter((value): value is number => typeof value === 'number')
      const confidence = probabilities.length ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length : 0.82
      return [{
        id: `segment-${index + 1}-${startMs}`,
        startMs,
        endMs,
        sourceText: (segment.text ?? words.map((word) => word.text).join(' ')).trim(),
        translatedText: '',
        words,
        confidence: Math.max(0, Math.min(1, confidence)),
        status: confidence < 0.65 ? 'warning' as const : 'generated' as const
      }]
    })
}

export function normalizeAndMergeWhisperSegments(raw: WhisperSegmentLike[]): MergeAdjacentDuplicateResult {
  return mergeAdjacentDuplicateSegments(normalizeWhisperSegments(raw), { maxGapMs: 1000, protectEdited: false })
}
