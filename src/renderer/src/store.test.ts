import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectDocument, SubtitleSegment, ZimuProjectV1 } from '../../shared/types'
import { useEditorStore } from './store'

const segment = (id: string, startMs: number, endMs: number): SubtitleSegment => ({
  id,
  startMs,
  endMs,
  sourceText: 'Same subtitle',
  translatedText: '',
  words: [],
  confidence: .9,
  status: 'generated'
})

const project: ZimuProjectV1 = {
  schemaVersion: 2,
  id: 'f1464ad8-242a-49bb-9897-31c4e9aab14f',
  title: 'Duplicate cleanup test',
  media: { path: 'D:\\video.mp4', name: 'video.mp4', size: 1, durationMs: 4000, kind: 'video' },
  sourceLanguage: 'en',
  detectedLanguage: 'en',
  targetLanguage: 'zh-CN',
  modelVersions: { whisper: 'test', translator: 'test', vad: 'test' },
  settings: {
    translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000,
    transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3'
  },
  segments: [segment('a', 0, 1000), segment('b', 1000, 2000), segment('c', 3001, 4000)],
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z'
}

const document = (): ProjectDocument => ({
  project: { ...project, segments: project.segments.map((item) => ({ ...item, words: [...item.words] })) }
})

describe('editor duplicate cleanup', () => {
  beforeEach(() => {
    useEditorStore.getState().setDocument(document())
  })

  it('records the whole cleanup as one undoable edit', () => {
    const result = useEditorStore.getState().mergeDuplicateSegments()

    expect(result.mergedCount).toBe(1)
    expect(useEditorStore.getState().document?.project.segments.map((item) => item.id)).toEqual(['a', 'c'])
    expect(useEditorStore.getState().history).toHaveLength(1)

    useEditorStore.getState().undo()

    expect(useEditorStore.getState().document?.project.segments.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(useEditorStore.getState().history).toHaveLength(0)
    expect(useEditorStore.getState().future).toHaveLength(1)
  })

  it('stores the selected transcription model in the project', () => {
    useEditorStore.getState().setTranscriptionModel('whisper-large-v3')

    expect(useEditorStore.getState().document?.project.settings.transcriptionModelId).toBe('whisper-large-v3')
    expect(useEditorStore.getState().dirty).toBe(true)
  })
})
