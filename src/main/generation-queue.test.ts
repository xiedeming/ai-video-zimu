import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GenerationQueue, type QueueDependencies } from './generation-queue'
import type { QueueTask } from '../shared/queue'
import type { JobEvent, ZimuProjectV1 } from '../shared/types'

function item(name = '测试🎬') {
  const project: ZimuProjectV1 = {
    schemaVersion: 2, id: randomUUID(), title: name,
    media: { path: `D:\\视频\\${name}.mp4`, name: `${name}.mp4`, size: 1, durationMs: 1000, kind: 'video' },
    sourceLanguage: 'en', targetLanguage: 'zh-CN', modelVersions: { whisper: 'test', translator: 'test', vad: 'test' },
    settings: { translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000, transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3' },
    segments: [], createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z'
  }
  return { project, filePath: `D:\\视频\\${name}.zimu`, options: { sourceLanguage: project.sourceLanguage, transcriptionModelId: project.settings.transcriptionModelId, translationProfileId: project.settings.translationProfileId, translate: true } }
}
function setup(overrides: Partial<QueueDependencies> = {}) {
  const started: QueueTask[] = []
  const deps = {
    validate: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined), persist: vi.fn().mockResolvedValue(undefined),
    start: vi.fn<QueueDependencies['start']>((task) => { started.push(task) }), cancel: vi.fn(), ...overrides
  }
  return { queue: new GenerationQueue(deps), deps, started }
}
function event(task: QueueTask, stage: JobEvent['stage'] = 'completed'): JobEvent {
  return { jobId: task.jobId, projectId: task.projectId, stage, progress: 100, message: '完成', elapsedMs: 1, project: task.project }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('global generation queue', () => {
  it('broadcasts progress without disk writes but persists stages, checkpoints and completion', async () => {
    const { queue, started, deps } = setup()
    await queue.enqueue([item()])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const update = vi.fn()
    queue.onUpdate(update)
    await queue.acceptEvent({ ...event(started[0], 'transcribing'), project: undefined, progress: 10 })
    vi.mocked(deps.persist).mockClear()
    update.mockClear()
    for (let progress = 11; progress <= 60; progress++) {
      await queue.acceptEvent({ ...event(started[0], 'transcribing'), project: undefined, progress })
    }
    expect(deps.persist).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(50)
    expect(queue.snapshot().tasks[0].progress).toBe(60)
    await queue.acceptEvent({ ...event(started[0], 'translating'), project: undefined })
    expect(deps.persist).toHaveBeenCalledTimes(1)
    await queue.acceptEvent(event(started[0], 'translating'))
    expect(deps.persist).toHaveBeenCalledTimes(2)
    await queue.acceptEvent(event(started[0]))
    expect(deps.persist).toHaveBeenCalledTimes(3)
    expect(vi.mocked(deps.persist).mock.calls.at(-1)?.[0].tasks[0].state).toBe('succeeded')
  })

  it('preserves event order when progress and completion arrive together', async () => {
    const { queue, started } = setup()
    await queue.enqueue([item()])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const observed: string[] = []
    queue.onEvent((value) => observed.push(value.stage))
    await Promise.all([
      queue.acceptEvent({ ...event(started[0], 'transcribing'), project: undefined }),
      queue.acceptEvent({ ...event(started[0], 'translating'), project: undefined }),
      queue.acceptEvent(event(started[0]))
    ])
    expect(observed).toEqual(['transcribing', 'translating', 'completed'])
    expect(queue.snapshot().tasks[0].state).toBe('succeeded')
  })
  it('runs three videos in FIFO order with one slot', async () => {
    const { queue, started } = setup()
    await queue.enqueue([item('a'), item('b'), item('c')])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    await queue.acceptEvent(event(started[0]))
    await vi.waitFor(() => expect(started).toHaveLength(2))
    await queue.acceptEvent(event(started[1]))
    await vi.waitFor(() => expect(started).toHaveLength(3))
    await queue.acceptEvent(event(started[2]))
    expect(started.map((task) => task.project.title)).toEqual(['a', 'b', 'c'])
    expect(queue.snapshot().tasks.every((task) => task.state === 'succeeded')).toBe(true)
  })
  it('runs two jobs and reducing concurrency leaves both running', async () => {
    const { queue, started, deps } = setup()
    await queue.enqueue([item('a'), item('b'), item('c')], 2)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    await queue.control({ action: 'concurrency', value: 1 })
    await queue.acceptEvent(event(started[0]))
    expect(started).toHaveLength(2)
    expect(deps.cancel).not.toHaveBeenCalled()
    await queue.acceptEvent(event(started[1]))
    await vi.waitFor(() => expect(started).toHaveLength(3))
  })
  it('pauses only new jobs, permits append, then resumes', async () => {
    const { queue, started } = setup()
    await queue.enqueue([item('a'), item('b')])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    await queue.control({ action: 'pause' })
    await queue.enqueue([item('c')])
    await queue.acceptEvent(event(started[0]))
    expect(started).toHaveLength(1)
    await queue.control({ action: 'resume' })
    await vi.waitFor(() => expect(started).toHaveLength(2))
  })
  it('keeps a slot until final save succeeds', async () => {
    const save = deferred()
    const { queue, started } = setup({ save: () => save.promise })
    await queue.enqueue([item('a'), item('b')])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const finishing = queue.acceptEvent(event(started[0]))
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].stage).toBe('saving'))
    expect(queue.snapshot().tasks[0].state).toBe('running')
    expect(started).toHaveLength(1)
    save.resolve()
    await finishing
    await vi.waitFor(() => expect(started).toHaveLength(2))
  })
  it('cancels only the requested running job and releases its slot after acknowledgment', async () => {
    const { queue, started, deps } = setup()
    await queue.enqueue([item('a'), item('b'), item('c')], 2)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    await queue.control({ action: 'cancel', jobId: started[0].jobId })
    expect(deps.cancel).toHaveBeenCalledExactlyOnceWith(started[0].jobId)
    expect(started).toHaveLength(2)
    await queue.acceptEvent(event(started[0], 'canceled'))
    await vi.waitFor(() => expect(started).toHaveLength(3))
    expect(queue.snapshot().tasks[1].state).toBe('running')
  })
  it('cancels pending work without launching it and clears only terminal records', async () => {
    const { queue, started } = setup()
    await queue.control({ action: 'pause' })
    const ids = await queue.enqueue([item('a'), item('b')])
    await queue.control({ action: 'cancel', jobId: ids[0].jobId })
    await queue.control({ action: 'clear' })
    expect(queue.snapshot().tasks).toHaveLength(1)
    await queue.control({ action: 'cancel-all' })
    await queue.control({ action: 'resume' })
    expect(started).toHaveLength(0)
  })
  it('retains a transcription checkpoint after translation failure and continues other jobs', async () => {
    const { queue, started, deps } = setup()
    await queue.enqueue([item('a'), item('b')])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const checkpoint = { ...started[0].project, segments: [{ id: 's', startMs: 0, endMs: 1000, sourceText: 'private subtitle', translatedText: '', words: [], confidence: 1, status: 'generated' as const }] }
    const callback = vi.mocked(deps.start).mock.calls[0][1]
    await callback(checkpoint)
    await queue.acceptEvent({ ...event(started[0], 'translating'), project: checkpoint })
    await queue.acceptEvent({ ...event(started[0], 'failed'), project: checkpoint, message: 'API key=secret D:\\private.mp4 private subtitle' })
    expect(queue.snapshot().tasks[0].project.segments[0].sourceText).toBe('private subtitle')
    expect(queue.snapshot().tasks[0].failedStage).toBe('translating')
    expect(queue.snapshot().tasks[0].message).not.toMatch(/secret|private/)
    await vi.waitFor(() => expect(started).toHaveLength(2))
  })
  it('marks a final save error as failed, never succeeded', async () => {
    const { queue, started } = setup({ save: vi.fn().mockRejectedValue(new Error('EACCES secret')) })
    await queue.enqueue([item()])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    await queue.acceptEvent(event(started[0]))
    expect(queue.snapshot().tasks[0]).toMatchObject({ state: 'failed', failedStage: 'saving' })
  })
  it('restores running jobs as interrupted and does not run until manual resume', async () => {
    const original = setup()
    await original.queue.enqueue([item('a'), item('b')])
    await vi.waitFor(() => expect(original.started).toHaveLength(1))
    const restored = setup()
    await restored.queue.restore(original.queue.snapshot())
    expect(restored.started).toHaveLength(0)
    expect(restored.queue.snapshot()).toMatchObject({ paused: true, recovery: true })
    expect(restored.queue.snapshot().tasks[0].state).toBe('interrupted')
    await restored.queue.control({ action: 'resume' })
    await vi.waitFor(() => expect(restored.started).toHaveLength(1))
    expect(restored.deps.validate).toHaveBeenCalled()
  })
  it('preflight failure after restart fails one task and proceeds', async () => {
    const { queue, started } = setup({ validate: vi.fn().mockRejectedValueOnce(new Error('missing source')).mockResolvedValue(undefined) })
    await queue.enqueue([item('missing'), item('valid')])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(started[0].project.title).toBe('valid')
    expect(queue.snapshot().tasks[0].state).toBe('failed')
  })
  it('retries with a new identity and the original immutable options', async () => {
    const { queue, started } = setup()
    const submitted = item()
    await queue.enqueue([submitted])
    submitted.options.translate = false
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const oldId = started[0].jobId
    await queue.acceptEvent(event(started[0], 'failed'))
    await queue.control({ action: 'retry', jobId: oldId })
    await vi.waitFor(() => expect(started).toHaveLength(2))
    expect(started[1].jobId).not.toBe(oldId)
    expect(started[1].options.translate).toBe(true)
  })
  it('ignores mismatched project identity and rejects duplicate active projects', async () => {
    const { queue, started } = setup()
    const submitted = item()
    await queue.enqueue([submitted])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    await queue.acceptEvent({ ...event(started[0]), projectId: randomUUID() })
    expect(queue.snapshot().tasks[0].state).toBe('running')
    await expect(queue.enqueue([submitted])).rejects.toThrow('已有未结束任务')
  })
  it('does not start jobs if durable persistence fails', async () => {
    const { queue, started } = setup({ persist: vi.fn().mockRejectedValue(new Error('disk full')) })
    await expect(queue.enqueue([item()])).rejects.toThrow('队列保存失败')
    expect(started).toHaveLength(0)
    expect(queue.snapshot().paused).toBe(true)
    expect(queue.snapshot().tasks).toHaveLength(0)
  })
  it('honors cancellation during the final save without releasing the slot early', async () => {
    const save = deferred()
    const { queue, started } = setup({ save: () => save.promise })
    await queue.enqueue([item()])
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const completed = queue.acceptEvent(event(started[0]))
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].stage).toBe('saving'))
    await queue.control({ action: 'cancel', jobId: started[0].jobId })
    save.resolve()
    await completed
    expect(queue.snapshot().tasks[0].state).toBe('canceled')
  })
  it('refreshes restored project content from the saved file', async () => {
    const original = setup()
    await original.queue.enqueue([item()])
    await vi.waitFor(() => expect(original.started).toHaveLength(1))
    await original.queue.acceptEvent(event(original.started[0]))
    const saved = { ...original.started[0].project, title: '用户保存后的项目' }
    const restored = setup({ readProject: vi.fn().mockResolvedValue(saved) })
    await restored.queue.restore(original.queue.snapshot())
    expect(restored.queue.snapshot().tasks[0].project.title).toBe('用户保存后的项目')
    expect(restored.started).toHaveLength(0)
  })
})
