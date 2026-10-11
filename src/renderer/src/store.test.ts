import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectDocument, SubtitleSegment, ZimuProjectV1 } from '../../shared/types'
import { useEditorStore } from './store'
import { queueTaskSchema, type QueueSnapshot } from '../../shared/queue'

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
    useEditorStore.setState({ documents: {}, sessions: {}, queue: { tasks: [], paused: false, concurrency: 1, recovery: false }, activeJobId: undefined })
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

  it('routes background completion to its project while preserving current edits', () => {
    const other = { ...document(), project: { ...project, id: '10000000-0000-4000-8000-000000000001', title: 'Other' } }
    useEditorStore.getState().setDocument(other)
    useEditorStore.getState().switchProject(project.id)
    useEditorStore.getState().updateSegment('a', { translatedText: '人工校对' })
    useEditorStore.getState().applyJobEvent({ jobId: 'background', projectId: other.project.id, stage: 'completed', progress: 100, message: '完成', elapsedMs: 1, project: { ...other.project, segments: [segment('background', 0, 1000)] } })
    expect(useEditorStore.getState().document?.project.id).toBe(project.id)
    expect(useEditorStore.getState().document?.project.segments[0].translatedText).toBe('人工校对')
    expect(useEditorStore.getState().documents[other.project.id].project.segments[0].id).toBe('background')
  })
  it('preserves each project edits, undo history and playback position when switching', () => {
    useEditorStore.getState().updateSegment('a', { translatedText: '编辑一' })
    useEditorStore.getState().setPlayhead(2345)
    const other = { ...document(), project: { ...project, id: '10000000-0000-4000-8000-000000000002' } }
    useEditorStore.getState().setDocument(other)
    useEditorStore.getState().updateSegment('b', { translatedText: '编辑二' })
    useEditorStore.getState().switchProject(project.id)
    expect(useEditorStore.getState().playheadMs).toBe(2345)
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().document?.project.segments[0].translatedText).toBe('')
    useEditorStore.getState().switchProject(other.project.id)
    expect(useEditorStore.getState().document?.project.segments[1].translatedText).toBe('编辑二')
  })
  it('keeps document and session references stable for progress-only snapshots', () => {
    const task = queueTaskSchema.parse({ jobId: '10000000-0000-4000-8000-000000000005', projectId: project.id, project, filePath: 'test.zimu', options: { sourceLanguage: 'en', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: true }, state: 'running', stage: 'transcribing', progress: 20, message: '识别中' })
    const snapshot: QueueSnapshot = { tasks: [task], paused: false, concurrency: 1, recovery: false }
    useEditorStore.getState().applyQueue(snapshot)
    const before = useEditorStore.getState()
    useEditorStore.getState().applyQueue({ ...snapshot, tasks: [{ ...task, progress: 30 }] })
    const after = useEditorStore.getState()
    expect(after.documents).toBe(before.documents)
    expect(after.sessions).toBe(before.sessions)
    expect(after.document).toBe(before.document)
    expect(after.queue.tasks[0].progress).toBe(30)
  })

  it('locks only the project with pending generation and unlocks on completion', () => {
    const task = queueTaskSchema.parse({ jobId: '10000000-0000-4000-8000-000000000003', projectId: project.id, project, filePath: 'D:\\test.zimu', options: { sourceLanguage: 'en', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: true }, state: 'running', stage: 'transcribing', progress: 20, message: '识别中' })
    const snapshot: QueueSnapshot = { tasks: [task], paused: false, concurrency: 1, recovery: false }
    useEditorStore.getState().applyQueue(snapshot)
    useEditorStore.getState().updateSegment('a', { sourceText: '不可编辑' })
    expect(useEditorStore.getState().document?.project.segments[0].sourceText).toBe('Same subtitle')
    useEditorStore.getState().applyQueue({ ...snapshot, tasks: [{ ...task, state: 'succeeded', stage: 'completed' }] })
    useEditorStore.getState().updateSegment('a', { sourceText: '完成后编辑' })
    expect(useEditorStore.getState().document?.project.segments[0].sourceText).toBe('完成后编辑')
  })
  it('marks auto-saved completion clean after the final job event and resets old undo history', () => {
    useEditorStore.getState().updateSegment('a', { translatedText: '识别前编辑' })
    const task = queueTaskSchema.parse({ jobId: '10000000-0000-4000-8000-000000000004', projectId: project.id, project, filePath: 'D:\\test.zimu', options: { sourceLanguage: 'en', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: true }, state: 'running', stage: 'transcribing', progress: 20, message: '识别中' })
    const snapshot: QueueSnapshot = { tasks: [task], paused: false, concurrency: 1, recovery: false }
    useEditorStore.getState().applyQueue(snapshot)
    useEditorStore.getState().applyJobEvent({ jobId: task.jobId, projectId: project.id, stage: 'completed', progress: 100, message: '完成', elapsedMs: 1, project })
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().applyQueue({ ...snapshot, tasks: [{ ...task, state: 'succeeded', stage: 'completed' }] })
    expect(useEditorStore.getState().dirty).toBe(false)
    expect(useEditorStore.getState().history).toHaveLength(0)
  })
})
