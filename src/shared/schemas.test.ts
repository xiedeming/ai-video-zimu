import { describe, expect, it } from 'vitest'
import { projectSchema, translationProfileInputSchema } from './schemas'
import { migrateProject } from './project'
import { BUILTIN_TRANSLATION_PROFILE_ID, DEFAULT_TRANSCRIPTION_MODEL_ID } from './types'
import { normalizeWhisperSegments, validateSegments } from './subtitles'

describe('project schema', () => {
  it('migrates a valid v1 project and rejects unknown language', () => {
    const project = {
      schemaVersion: 1, id: '93797fd4-3d3d-4a23-9901-62ed08794ae3', title: '测试',
      media: { path: 'D:\\测试\\video.mp4', name: 'video.mp4', size: 100, durationMs: 3000, kind: 'video' },
      sourceLanguage: 'ja', targetLanguage: 'zh-CN',
      modelVersions: { whisper: 'a', translator: 'b', vad: 'c' },
      settings: { translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000 },
      segments: [], createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z'
    }
    const migrated = migrateProject(project)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.settings.translationProfileId).toBe(BUILTIN_TRANSLATION_PROFILE_ID)
    expect(migrated.settings.transcriptionModelId).toBe(DEFAULT_TRANSCRIPTION_MODEL_ID)
    expect(migrated.media.path).toContain('测试')
    expect(() => migrateProject({ ...project, sourceLanguage: 'fr' })).toThrow()
    expect(projectSchema.parse(migrated).schemaVersion).toBe(2)
  })

  it('adds the default transcription model when opening an older v2 project', () => {
    const project = {
      schemaVersion: 2, id: '93797fd4-3d3d-4a23-9901-62ed08794ae3', title: '旧版 V2',
      media: { path: 'D:\\video.mp4', name: 'video.mp4', size: 100, durationMs: 3000, kind: 'video' },
      sourceLanguage: 'ja', targetLanguage: 'zh-CN',
      modelVersions: { whisper: 'large-v3-turbo', translator: 'qwen', vad: 'silero' },
      settings: {
        translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000,
        translationProfileId: BUILTIN_TRANSLATION_PROFILE_ID
      },
      segments: [], createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z'
    }

    expect(migrateProject(project).settings.transcriptionModelId).toBe(DEFAULT_TRANSCRIPTION_MODEL_ID)
  })
})

describe('translation profile schema', () => {
  it('allows HTTP and HTTPS for local and remote services', () => {
    const base = { name: 'API', kind: 'openai-compatible', model: 'qwen' } as const
    expect(translationProfileInputSchema.parse({ ...base, baseUrl: 'http://127.0.0.1:11434/v1/' }).baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(translationProfileInputSchema.parse({ ...base, baseUrl: 'https://api.example.com/v1' }).baseUrl).toContain('https://')
    expect(translationProfileInputSchema.parse({ ...base, baseUrl: 'http://192.168.1.20:8000/v1' }).baseUrl).toBe('http://192.168.1.20:8000/v1')
    expect(translationProfileInputSchema.parse({ ...base, baseUrl: 'http://api.example.com/v1' }).baseUrl).toBe('http://api.example.com/v1')
  })
})

describe('Whisper normalization', () => {
  it('keeps word timing and confidence', () => {
    const result = normalizeWhisperSegments([{
      text: 'こんにちは', offsets: { from: 1000, to: 2500 },
      tokens: [{ text: 'こんにちは', offsets: { from: 1000, to: 2500 }, p: .92 }]
    }])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ startMs: 1000, endMs: 2500, confidence: .92, status: 'generated' })
  })

  it('drops invalid zero-length segments', () => {
    expect(normalizeWhisperSegments([{ text: 'bad', offsets: { from: 10, to: 10 } }])).toEqual([])
  })
})

describe('subtitle errors', () => {
  it('reports invalid ranges', () => {
    const issues = validateSegments([{
      id: 'bad', startMs: 2000, endMs: 1000, sourceText: 'x', translatedText: '中', words: [], confidence: .9, status: 'edited'
    }])
    expect(issues[0]?.type).toBe('invalid-range')
  })
})
