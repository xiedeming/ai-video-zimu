import { describe, expect, it } from 'vitest'
import {
  formatTimecode,
  mergeAdjacentDuplicateSegments,
  normalizeAndMergeWhisperSegments,
  parseTimecode,
  repairSegmentOverlaps,
  serializeSubtitles,
  synchronizeSubtitleTimings,
  untranslatedSegmentIds,
  validateSegments
} from './subtitles'
import type { SubtitleSegment } from './types'

const segments: SubtitleSegment[] = [
  {
    id: 'a', startMs: 1234, endMs: 4567, sourceText: 'Hello.', translatedText: '你好。',
    words: [], confidence: 0.91, status: 'generated'
  },
  {
    id: 'b', startMs: 5000, endMs: 6500, sourceText: 'World.', translatedText: '世界。',
    words: [], confidence: 0.88, status: 'generated'
  }
]

describe('timecode', () => {
  it('formats and parses milliseconds', () => {
    expect(formatTimecode(3_661_007)).toBe('01:01:01.007')
    expect(parseTimecode('01:01:01,007')).toBe(3_661_007)
    expect(parseTimecode('00:99:00.000')).toBeNull()
  })
})

describe('subtitle serializers', () => {
  it('exports bilingual SRT', () => {
    const result = serializeSubtitles(segments, 'srt', 'bilingual')
    expect(result).toContain('00:00:01,234 --> 00:00:04,567')
    expect(result).toContain('Hello.\n你好。')
  })

  it('exports VTT and ASS', () => {
    expect(serializeSubtitles(segments, 'vtt', 'translation')).toMatch(/^WEBVTT/)
    expect(serializeSubtitles(segments, 'ass', 'source')).toContain('Dialogue: 0,0:00:01.23,0:00:04.57')
  })
})

describe('subtitle timing synchronization', () => {
  it('adds a conservative lead-in and tail without filling long silences', () => {
    const synchronized = synchronizeSubtitleTimings([
      { ...segments[0], startMs: 1000, endMs: 2000 },
      { ...segments[1], startMs: 2600, endMs: 3000 }
    ], { mediaDurationMs: 3100 })

    expect(synchronized.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [900, 2200],
      [2500, 3100]
    ])
  })

  it('shares short gaps at a stable boundary instead of creating overlaps', () => {
    const synchronized = synchronizeSubtitleTimings([
      { ...segments[0], startMs: 1000, endMs: 2000 },
      { ...segments[1], startMs: 2100, endMs: 3000 }
    ])

    expect(synchronized.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [900, 2050],
      [2050, 3200]
    ])
    expect(validateSegments(synchronized)).toEqual([])
  })

  it('keeps adjacent speech transitions exact and clamps to media bounds', () => {
    const synchronized = synchronizeSubtitleTimings([
      { ...segments[0], startMs: 0, endMs: 1000 },
      { ...segments[1], startMs: 1000, endMs: 1990 }
    ], { mediaDurationMs: 2000 })

    expect(synchronized.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 1000],
      [1000, 2000]
    ])
    expect(validateSegments(synchronized)).toEqual([])
  })
})

describe('validation', () => {
  it('finds only untranslated segments that contain source text', () => {
    const candidates = [
      { ...segments[0], id: 'translated' },
      { ...segments[0], id: 'missing', translatedText: '   ' },
      { ...segments[0], id: 'empty-source', sourceText: ' ', translatedText: '' }
    ]

    expect(untranslatedSegmentIds(candidates)).toEqual(['missing'])
  })

  it('finds overlaps and empty ranges', () => {
    const broken = [segments[0], { ...segments[1], startMs: 4000, sourceText: '', translatedText: '' }]
    expect(validateSegments(broken).map((issue) => issue.type)).toEqual(['empty', 'overlap'])
  })

  it('repairs all overlaps by creating non-overlapping boundaries', () => {
    const broken = [
      { ...segments[0], startMs: 0, endMs: 2000 },
      { ...segments[1], id: 'b', startMs: 1500, endMs: 3000 },
      { ...segments[1], id: 'c', startMs: 2500, endMs: 4000 }
    ]
    const repaired = repairSegmentOverlaps(broken)

    expect(repaired.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[0, 1500], [1500, 2500], [2500, 4000]])
    expect(validateSegments(repaired)).toEqual([])
    expect(repaired[0].status).toBe('edited')
  })

  it('repairs only the requested overlap and handles equal starts', () => {
    const equalStarts = [
      { ...segments[0], startMs: 1000, endMs: 3000 },
      { ...segments[1], startMs: 1000, endMs: 4000 }
    ]
    const repaired = repairSegmentOverlaps(equalStarts, ['b'])

    expect(repaired[0].endMs).toBe(1001)
    expect(repaired[1].startMs).toBe(1001)
    expect(validateSegments(repaired)).toEqual([])
  })
})

describe('adjacent duplicate merging', () => {
  const duplicate = (id: string, startMs: number, endMs: number, sourceText = 'Hello'): SubtitleSegment => ({
    id, startMs, endMs, sourceText, translatedText: '', words: [], confidence: .8, status: 'generated'
  })

  it('normalizes whitespace and case but keeps punctuation significant', () => {
    const result = mergeAdjacentDuplicateSegments([
      duplicate('a', 0, 1000, '  Hello\n world  '),
      duplicate('b', 2000, 2500, 'hello   WORLD'),
      duplicate('c', 2500, 3000, 'hello world.')
    ])

    expect(result.mergedCount).toBe(1)
    expect(result.segments.map((segment) => segment.id)).toEqual(['a', 'c'])
    expect(result.segments[0]).toMatchObject({ startMs: 0, endMs: 2500, sourceText: '  Hello\n world  ' })
  })

  it('merges overlap chains and the exact 1000ms boundary but not larger gaps', () => {
    const chain = mergeAdjacentDuplicateSegments([
      duplicate('a', 0, 1000),
      duplicate('b', 900, 1500),
      duplicate('c', 1500, 2000),
      duplicate('d', 3000, 3500),
      duplicate('e', 4501, 5000)
    ])

    expect(chain.mergedCount).toBe(3)
    expect(chain.segments.map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))).toEqual([
      { id: 'a', startMs: 0, endMs: 3500 },
      { id: 'e', startMs: 4501, endMs: 5000 }
    ])
  })

  it('preserves the first ID, deduplicates words and weights confidence by word count', () => {
    const first = {
      ...duplicate('first', 100, 1000), confidence: .9, translatedText: '你好',
      words: [{ text: 'Hello', startMs: 100, endMs: 500, probability: .9 }]
    }
    const second = {
      ...duplicate('second', 1000, 1800), confidence: .6,
      words: [
        { text: 'Hello', startMs: 100, endMs: 500, probability: .9 },
        { text: 'Hello', startMs: 1000, endMs: 1500, probability: .6 }
      ]
    }
    const result = mergeAdjacentDuplicateSegments([first, second])

    expect(result.segments[0].id).toBe('first')
    expect(result.segments[0].translatedText).toBe('你好')
    expect(result.segments[0].words).toHaveLength(2)
    expect(result.segments[0].confidence).toBeCloseTo(.7)
    expect(result.segments[0].status).toBe('generated')
  })

  it('skips edited/reviewed segments and conflicting non-empty translations', () => {
    const edited = { ...duplicate('b', 1000, 2000), translatedText: '甲', status: 'edited' as const }
    const translatedDifferently = { ...duplicate('c', 2000, 3000), translatedText: '乙' }
    const result = mergeAdjacentDuplicateSegments([
      { ...duplicate('a', 0, 1000), translatedText: '甲' },
      edited,
      translatedDifferently,
      duplicate('d', 3000, 4000),
      duplicate('e', 4000, 5000)
    ], { protectEdited: true })

    expect(result.mergedCount).toBe(2)
    expect(result.skippedConflictCount).toBe(2)
    expect(result.segments.map((segment) => segment.id)).toEqual(['a', 'b', 'c'])
  })

  it('normalizes and removes duplicates before a transcription enters translation', () => {
    const result = normalizeAndMergeWhisperSegments([
      { text: '同じ字幕', offsets: { from: 0, to: 1000 } },
      { text: '同じ字幕', offsets: { from: 1000, to: 2000 } }
    ])
    expect(result.mergedCount).toBe(1)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]).toMatchObject({ id: 'segment-1-0', startMs: 0, endMs: 2000 })
  })

  it('ignores whisper control tokens and invalid word ranges', () => {
    const result = normalizeAndMergeWhisperSegments([{
      text: 'Hello',
      offsets: { from: 1000, to: 2000 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 1000 }, p: .1 },
        { text: ' Hello', offsets: { from: 1100, to: 1800 }, p: .9 },
        { text: '[_TT_100]', offsets: { from: 1800, to: 1800 }, p: .2 },
        { text: 'broken', offsets: { from: 1900, to: 1800 }, p: .4 }
      ]
    }])

    expect(result.segments[0].words).toEqual([
      { text: 'Hello', startMs: 1100, endMs: 1800, probability: .9 }
    ])
    expect(result.segments[0].confidence).toBe(.9)
  })
})
