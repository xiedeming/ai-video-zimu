import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobEvent, ZimuProjectV1 } from '../shared/types'

const mocks = vi.hoisted(() => ({
  resolveBinary: vi.fn(),
  translate: vi.fn(),
  runProcess: vi.fn(),
  spawnTracked: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  hasNvidiaGpu: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: mocks.mkdir,
  readFile: mocks.readFile
}))

vi.mock('./constants', () => ({
  getAppPaths: () => ({ cache: 'D:\\cache', models: 'D:\\models' })
}))

vi.mock('./sidecars', () => ({
  hasNvidiaGpu: mocks.hasNvidiaGpu,
  resolveBinary: mocks.resolveBinary,
  runProcess: mocks.runProcess,
  spawnTracked: mocks.spawnTracked
}))

vi.mock('./translation-client', () => ({
  translateWithCompatibleApi: mocks.translate
}))

import { JobManager } from './job-manager'
import type { ModelManager } from './model-manager'
import type { TranslationProfileManager } from './translation-profile-manager'

const profileId = 'd50d8250-d0bd-44f2-a61b-77666d4c4263'
const project: ZimuProjectV1 = {
  schemaVersion: 2,
  id: '93797fd4-3d3d-4a23-9901-62ed08794ae3',
  title: 'Remote API test',
  media: { path: 'D:\\video.mp4', name: 'video.mp4', size: 1, durationMs: 1000, kind: 'video' },
  sourceLanguage: 'en',
  detectedLanguage: 'en',
  targetLanguage: 'zh-CN',
  modelVersions: { whisper: 'test', translator: 'old', vad: 'test' },
  settings: {
    translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000,
    transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: profileId
  },
  segments: [{ id: 'segment-1', startMs: 0, endMs: 1000, sourceText: 'Hello', translatedText: '', words: [], confidence: 1, status: 'generated' }],
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z'
}

function pipelineManager() {
  mocks.resolveBinary.mockReset().mockImplementation(async (name: string) => name)
  mocks.runProcess.mockReset().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.readFile.mockReset().mockResolvedValue(JSON.stringify({ result: { language: 'en' }, transcription: [{ text: 'Hello', offsets: { from: 0, to: 1000 } }] }))
  mocks.translate.mockReset().mockImplementation(async (_profile, _language, batch) => new Map(batch.map((segment: { id: string }) => [segment.id, '你好'])))
  const models = { assertReady: vi.fn().mockResolvedValue(undefined), pathFor: vi.fn((id) => id) } as unknown as ModelManager
  const profiles = { resolve: vi.fn().mockResolvedValue({ profile: { id: profileId, kind: 'openai-compatible', model: 'remote', baseUrl: 'http://localhost/v1' } }) } as unknown as TranslationProfileManager
  const manager = new JobManager(models, profiles)
  const completed = new Promise<JobEvent>((resolve) => { manager.onEvent((event) => { if (['completed', 'failed', 'canceled'].includes(event.stage)) resolve(event) }) })
  return { manager, completed }
}

describe('JobManager translation provider selection', () => {
  beforeEach(() => {
    mocks.hasNvidiaGpu.mockReset().mockResolvedValue(false)
  })

  it('does not resolve llama-server when retranslating with a remote profile', async () => {
    mocks.resolveBinary.mockReset()
    mocks.translate.mockReset().mockResolvedValue(new Map([['segment-1', '你好']]))
    const models = { assertReady: vi.fn(), pathFor: vi.fn() } as unknown as ModelManager
    const profiles = {
      resolve: vi.fn().mockResolvedValue({
        profile: { id: profileId, name: 'Remote', kind: 'openai-compatible', baseUrl: 'http://192.168.1.20:8000/v1', model: 'qwen', hasApiKey: true, isDefault: false },
        apiKey: 'secret'
      })
    } as unknown as TranslationProfileManager
    const manager = new JobManager(models, profiles)
    const finished = new Promise<JobEvent>((resolve) => {
      manager.onEvent((event) => {
        if (event.stage === 'completed' || event.stage === 'failed') resolve(event)
      })
    })

    manager.retranslate(project)
    const event = await finished

    expect(event.stage).toBe('completed')
    expect(event.project?.segments[0].translatedText).toBe('你好')
    expect(mocks.resolveBinary).not.toHaveBeenCalled()
    expect(models.assertReady).not.toHaveBeenCalled()
  })

  it('continues only untranslated segments without overwriting existing translations', async () => {
    mocks.resolveBinary.mockReset()
    mocks.translate.mockReset().mockImplementation(async (_profile, _language, batch) => {
      expect(batch.map((item: { id: string }) => item.id)).toEqual(['segment-2'])
      return new Map([['segment-2', '世界']])
    })
    const models = { assertReady: vi.fn(), pathFor: vi.fn() } as unknown as ModelManager
    const profiles = {
      resolve: vi.fn().mockResolvedValue({
        profile: { id: profileId, name: 'Remote', kind: 'openai-compatible', baseUrl: 'http://192.168.1.20:8000/v1', model: 'qwen', hasApiKey: false, isDefault: false }
      })
    } as unknown as TranslationProfileManager
    const manager = new JobManager(models, profiles)
    const continuationProject: ZimuProjectV1 = {
      ...project,
      segments: [
        { ...project.segments[0], id: 'segment-1', translatedText: '保留现有译文' },
        { ...project.segments[0], id: 'segment-2', startMs: 1000, endMs: 2000, sourceText: 'World', translatedText: '' },
        { ...project.segments[0], id: 'segment-3', startMs: 2000, endMs: 3000, sourceText: ' ', translatedText: '' }
      ]
    }
    const finished = new Promise<JobEvent>((resolve) => {
      manager.onEvent((event) => {
        if (event.stage === 'completed' || event.stage === 'failed') resolve(event)
      })
    })

    manager.continueTranslation(continuationProject)
    const event = await finished

    expect(event.stage).toBe('completed')
    expect(event.project?.segments.map((item) => item.translatedText)).toEqual(['保留现有译文', '世界', ''])
    expect(mocks.translate).toHaveBeenCalledTimes(1)
  })

  it('does not turn an empty continuation into a full retranslation', () => {
    const models = { assertReady: vi.fn(), pathFor: vi.fn() } as unknown as ModelManager
    const profiles = {} as TranslationProfileManager
    const manager = new JobManager(models, profiles)

    expect(() => manager.continueTranslation({
      ...project,
      segments: project.segments.map((item) => ({ ...item, translatedText: '已有译文' }))
    })).toThrow('没有可翻译的字幕段')
  })

  it('removes adjacent recognition duplicates before creating translation batches', async () => {
    mocks.resolveBinary.mockReset().mockImplementation(async (name: string) => name)
    mocks.hasNvidiaGpu.mockReset().mockResolvedValue(true)
    mocks.runProcess.mockReset().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    mocks.spawnTracked.mockReset().mockReturnValue({
      child: { kill: vi.fn() },
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    })
    mocks.mkdir.mockReset().mockResolvedValue(undefined)
    mocks.readFile.mockReset().mockResolvedValue(JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { text: 'Repeated line', offsets: { from: 0, to: 1000 } },
        { text: ' repeated   LINE ', offsets: { from: 1000, to: 2000 } }
      ]
    }))
    mocks.translate.mockReset().mockImplementation(async (_profile, _language, batch) => {
      expect(batch).toHaveLength(1)
      expect(batch[0]).toMatchObject({ id: 'segment-1-0', startMs: 0, endMs: 2000 })
      return new Map([[batch[0].id, '重复的一行']])
    })
    const models = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      pathFor: vi.fn((id: string) => `D:\\models\\${id}`)
    } as unknown as ModelManager
    const profiles = {
      resolve: vi.fn().mockResolvedValue({
        profile: { id: profileId, name: 'Remote', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen', hasApiKey: false, isDefault: false },
        apiKey: ''
      })
    } as unknown as TranslationProfileManager
    const manager = new JobManager(models, profiles)
    const finished = new Promise<JobEvent>((resolve) => {
      manager.onEvent((event) => {
        if (event.stage === 'completed' || event.stage === 'failed') resolve(event)
      })
    })

    manager.start({
      ...project,
      media: { ...project.media, durationMs: 2000 },
      settings: { ...project.settings, transcriptionModelId: 'whisper-large-v3' },
      segments: []
    })
    const event = await finished

    expect(event.stage).toBe('completed')
    expect(models.assertReady).toHaveBeenCalledWith(['whisper-large-v3', 'silero-vad-v6.2'])
    expect(models.pathFor).toHaveBeenCalledWith('whisper-large-v3')
    expect(event.project?.modelVersions.whisper).toBe('large-v3')
    expect(event.project?.segments).toHaveLength(1)
    expect(event.project?.segments[0].translatedText).toBe('重复的一行')
    expect(mocks.translate).toHaveBeenCalledTimes(1)
  })

  it('retries a failed GPU transcription on CPU within its own job', async () => {
    const { manager, completed } = pipelineManager()
    mocks.hasNvidiaGpu.mockResolvedValue(true)
    mocks.spawnTracked.mockReset()
      .mockReturnValueOnce({ child: { kill: vi.fn() }, result: Promise.reject(new Error('GPU unavailable')) })
      .mockReturnValueOnce({ child: { kill: vi.fn() }, result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) })
    manager.start(project, { translate: false, concurrency: 2 })
    const event = await completed
    expect(event.stage).toBe('completed')
    expect(mocks.resolveBinary).toHaveBeenCalledWith('whisper-cli', false)
    expect(mocks.spawnTracked.mock.calls[1][1]).toContain('--no-gpu')
    expect(mocks.translate).not.toHaveBeenCalled()
  })

  it('saves transcription before translating and retains it on translation failure', async () => {
    const { manager, completed } = pipelineManager()
    mocks.spawnTracked.mockReset().mockReturnValue({ child: { kill: vi.fn() }, result: Promise.resolve({}) })
    const checkpoint = vi.fn().mockResolvedValue(undefined)
    mocks.translate.mockImplementation(async () => {
      expect(checkpoint).toHaveBeenCalledOnce()
      throw new Error('translation failed')
    })
    manager.start(project, { checkpoint })
    const event = await completed
    expect(event.stage).toBe('failed')
    expect(event.project?.segments[0].sourceText).toBe('Hello')
    expect(event.project?.segments[0].translatedText).toBe('')
  })

  it('does not translate or succeed if checkpoint saving fails', async () => {
    const { manager, completed } = pipelineManager()
    mocks.spawnTracked.mockReset().mockReturnValue({ child: { kill: vi.fn() }, result: Promise.resolve({}) })
    manager.start(project, { checkpoint: vi.fn().mockRejectedValue(new Error('disk full')) })
    expect((await completed).stage).toBe('failed')
    expect(mocks.translate).not.toHaveBeenCalled()
  })

  it('serializes two local translations through a single shared process', async () => {
    const models = { assertReady: vi.fn().mockResolvedValue(undefined), pathFor: vi.fn((id) => id) } as unknown as ModelManager
    const profiles = { resolve: vi.fn().mockResolvedValue({ profile: { id: 'builtin-qwen3', kind: 'builtin', model: 'local' } }) } as unknown as TranslationProfileManager
    const manager = new JobManager(models, profiles)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const kill = vi.fn()
    mocks.spawnTracked.mockReset().mockReturnValue({ child: { kill }, result: new Promise(() => undefined) })
    mocks.resolveBinary.mockReset().mockResolvedValue('llama-server')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.translate.mockReset().mockImplementation(async () => { await gate; return new Map([['segment-1', '你好']]) })
    const results: JobEvent[] = []
    manager.onEvent((event) => { if (event.stage === 'completed') results.push(event) })
    try {
      manager.retranslate(project)
      manager.retranslate({ ...project, id: '10000000-0000-4000-8000-000000000001' })
      await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1))
      release()
      await vi.waitFor(() => expect(results).toHaveLength(2))
      expect(mocks.spawnTracked).toHaveBeenCalledTimes(1)
      expect(kill).not.toHaveBeenCalled()
    } finally { manager.dispose(); vi.unstubAllGlobals() }
    expect(kill).toHaveBeenCalledOnce()
  })
  it('cancels a task waiting for the local translator before the preceding task finishes', async () => {
    const models = { assertReady: vi.fn().mockResolvedValue(undefined), pathFor: vi.fn((id) => id) } as unknown as ModelManager
    const profiles = { resolve: vi.fn().mockResolvedValue({ profile: { id: 'builtin-qwen3', kind: 'builtin', model: 'local' } }) } as unknown as TranslationProfileManager
    const manager = new JobManager(models, profiles)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    mocks.resolveBinary.mockReset().mockResolvedValue('llama-server')
    mocks.spawnTracked.mockReset().mockReturnValue({ child: { kill: vi.fn() }, result: new Promise(() => undefined) })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.translate.mockReset().mockImplementation(async () => { await gate; return new Map([['segment-1', '你好']]) })
    const events: JobEvent[] = []
    manager.onEvent((event) => events.push(event))
    try {
      manager.retranslate(project)
      await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1))
      const waiting = manager.retranslate({ ...project, id: '10000000-0000-4000-8000-000000000002' })
      await Promise.resolve()
      manager.cancel(waiting.jobId)
      await vi.waitFor(() => expect(events.some((event) => event.jobId === waiting.jobId && event.stage === 'canceled')).toBe(true))
      expect(events.some((event) => event.stage === 'completed')).toBe(false)
      expect(mocks.translate).toHaveBeenCalledTimes(1)
      release()
      await vi.waitFor(() => expect(events.some((event) => event.stage === 'completed')).toBe(true))
    } finally { release(); manager.dispose(); vi.unstubAllGlobals() }
  })
})
