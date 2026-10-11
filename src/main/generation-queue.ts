import { randomUUID } from 'node:crypto'
import { queueSnapshotSchema, type GenerationOptions, type QueueControl, type QueueSnapshot, type QueueTask } from '../shared/queue'
import type { JobEvent, ZimuProjectV1 } from '../shared/types'

export interface QueueDependencies {
  readProject?: (filePath: string) => Promise<ZimuProjectV1>
  validate: (project: ZimuProjectV1, options: GenerationOptions, filePath: string, operation: QueueTask['operation']) => Promise<void>
  save: (project: ZimuProjectV1, filePath: string) => Promise<void>
  persist: (snapshot: QueueSnapshot) => Promise<void>
  start: (task: QueueTask, checkpoint: (project: ZimuProjectV1) => Promise<void>, concurrency: number) => void
  cancel: (jobId: string) => void
}

/** Slots are held through preflight, checkpoint writes and final save. */
export class GenerationQueue {
  private data: QueueSnapshot = { tasks: [], paused: false, concurrency: 1, recovery: false }
  private listeners = new Set<(snapshot: QueueSnapshot) => void>()
  private eventListeners = new Set<(event: JobEvent) => void>()
  private writeTail: Promise<void> = Promise.resolve()
  private eventTails = new Map<string, Promise<void>>()
  private started = new Set<string>()
  private cancelRequested = new Set<string>()
  private launching = false

  constructor(private deps: QueueDependencies) {}
  snapshot(): QueueSnapshot { return structuredClone(this.data) }
  onUpdate(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onEvent(listener: (event: JobEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }
  async restore(raw?: unknown): Promise<void> {
    if (raw === undefined) return
    this.data = queueSnapshotSchema.parse(raw)
    for (const task of this.data.tasks) {
      if (this.deps.readProject) {
        try {
          const saved = await this.deps.readProject(task.filePath)
          if (saved.id === task.projectId) task.project = saved
        } catch { /* Keep durable checkpoints; resume preflight reports missing files. */ }
      }
      if (task.state === 'running') {
        task.state = 'interrupted'
        task.message = '上次运行已中断，继续后将重新生成'
      }
    }
    this.data.paused = true
    this.data.recovery = this.data.tasks.some((task) => ['waiting', 'interrupted'].includes(task.state))
    await this.changed()
  }
  async enqueue(projects: { project: ZimuProjectV1; filePath: string; options: GenerationOptions; operation?: QueueTask['operation']; segmentIds?: string[] }[], concurrency?: 1 | 2): Promise<{ jobId: string }[]> {
    if (projects.some(({ project }) => this.data.tasks.some((task) => task.projectId === project.id && ['waiting', 'running', 'interrupted'].includes(task.state)))) {
      throw new Error('此项目已有未结束任务')
    }
    const tasks: QueueTask[] = projects.map(({ project, filePath, options, operation, segmentIds }) => ({
      jobId: randomUUID(), projectId: project.id, project: structuredClone(project), filePath,
      options: structuredClone(options), operation: operation ?? 'generate', segmentIds, state: 'waiting', stage: 'queued', progress: 0, message: '等待处理'
    }))
    this.data.tasks.push(...tasks)
    if (concurrency) this.data.concurrency = concurrency
    try { await this.changed() } catch (error) {
      this.data.tasks = this.data.tasks.filter((task) => !tasks.includes(task))
      throw error
    }
    this.schedule()
    return tasks.map(({ jobId }) => ({ jobId }))
  }
  async control(request: QueueControl): Promise<QueueSnapshot> {
    if (request.action === 'pause') this.data.paused = true
    if (request.action === 'resume') {
      for (const task of this.data.tasks) {
        if (task.state === 'interrupted') { task.state = 'waiting'; task.stage = 'queued'; task.progress = 0 }
      }
      this.data.paused = false
      this.data.recovery = false
    }
    if (request.action === 'concurrency') this.data.concurrency = request.value
    if (request.action === 'clear') this.data.tasks = this.data.tasks.filter((task) => ['waiting', 'running', 'interrupted'].includes(task.state))
    if (request.action === 'cancel' || request.action === 'cancel-all') {
      const selected = this.data.tasks.filter((task) => request.action === 'cancel-all' || task.jobId === request.jobId)
      for (const task of selected) {
        if (task.state === 'running') {
          this.cancelRequested.add(task.jobId)
          if (this.started.has(task.jobId)) this.deps.cancel(task.jobId)
          task.message = '正在取消'
        } else if (['waiting', 'interrupted'].includes(task.state)) {
          task.state = 'canceled'; task.stage = 'canceled'; task.message = '已取消'
        }
      }
    }
    if (request.action === 'retry') {
      const task = this.data.tasks.find((item) => item.jobId === request.jobId)
      if (!task || !['failed', 'canceled', 'interrupted'].includes(task.state)) throw new Error('此任务不可重试')
      if (this.data.tasks.some((item) => item !== task && item.projectId === task.projectId && ['waiting', 'running', 'interrupted'].includes(item.state))) throw new Error('此项目已有未结束任务')
      this.data.tasks = this.data.tasks.filter((item) => item !== task)
      this.data.tasks.push({ ...task, jobId: randomUUID(), state: 'waiting', stage: 'queued', progress: 0, failedStage: undefined, message: '等待重试' })
    }
    await this.changed()
    this.schedule()
    return this.snapshot()
  }
  async recordSavedProject(project: ZimuProjectV1, filePath: string): Promise<void> {
    for (const task of this.data.tasks) {
      if (task.projectId === project.id && !['waiting', 'running', 'interrupted'].includes(task.state)) {
        task.project = structuredClone(project)
        task.filePath = filePath
      }
    }
    await this.changed()
  }
  private async changed(): Promise<void> {
    const snapshot = this.snapshot()
    const write = this.writeTail.then(() => this.deps.persist(snapshot))
    this.writeTail = write.catch(() => undefined)
    try { await write } catch {
      this.data.paused = true
      this.listeners.forEach((listener) => listener(this.snapshot()))
      throw new Error('队列保存失败，已暂停启动新任务；请检查应用数据目录')
    }
    this.listeners.forEach((listener) => listener(this.snapshot()))
  }
  private schedule(): void {
    if (this.launching || this.data.paused) return
    this.launching = true
    try {
      while (!this.data.paused && this.data.tasks.filter((task) => task.state === 'running').length < this.data.concurrency) {
        const task = this.data.tasks.find((item) => item.state === 'waiting')
        if (!task) break
        task.state = 'running'
        void this.launch(task)
      }
    } finally { this.launching = false }
  }
  private async launch(task: QueueTask): Promise<void> {
    try {
      await this.changed()
      await this.deps.validate(task.project, task.options, task.filePath, task.operation)
      if (this.cancelRequested.has(task.jobId)) {
        await this.acceptEvent({ jobId: task.jobId, projectId: task.projectId, stage: 'canceled', progress: 0, message: '已取消', elapsedMs: 0 })
        return
      }
      this.started.add(task.jobId)
      this.deps.start(task, async (project) => {
        task.stage = 'saving'
        task.message = '正在保存识别结果'
        this.listeners.forEach((listener) => listener(this.snapshot()))
        await this.deps.save(project, task.filePath)
        task.project = project
        await this.changed()
      }, this.data.concurrency)
    } catch {
      await this.acceptEvent({ jobId: task.jobId, projectId: task.projectId, stage: 'failed', progress: 0, message: '任务检查或保存失败，请检查源文件、模型和写入权限', elapsedMs: 0 })
    }
  }
  acceptEvent(event: JobEvent): Promise<void> {
    const previous = this.eventTails.get(event.jobId) ?? Promise.resolve()
    const next = previous.then(() => this.processEvent(event))
    const settled = next.catch(() => { this.data.paused = true }).finally(() => {
      // A newer event may already be queued behind this one.
      if (this.eventTails.get(event.jobId) === settled) this.eventTails.delete(event.jobId)
    })
    this.eventTails.set(event.jobId, settled)
    return settled
  }
  private async processEvent(event: JobEvent): Promise<void> {
    const task = this.data.tasks.find((item) => item.jobId === event.jobId && item.projectId === event.projectId)
    if (!task || task.state !== 'running') return
    if (event.project && event.project.id !== task.projectId) return
    const previousStage = task.stage
    task.stage = event.stage
    task.progress = event.progress
    // Sidecar and API errors may contain paths, prompts or credentials.
    task.message = event.stage === 'failed' ? '生成失败，请检查源文件、模型或翻译服务后重试' : event.message
    if (event.project) task.project = event.project
    if (['completed', 'failed', 'canceled'].includes(event.stage)) {
      const canceled = this.cancelRequested.has(task.jobId) || event.stage === 'canceled'
      let terminalState: QueueTask['state'] = canceled ? 'canceled' : event.stage === 'completed' ? 'succeeded' : 'failed'
      if (terminalState === 'failed') task.failedStage = previousStage
      try {
        if (event.project) {
          task.stage = 'saving'
          task.progress = Math.min(99, task.progress)
          this.listeners.forEach((listener) => listener(this.snapshot()))
          await this.deps.save(event.project, task.filePath)
        }
      } catch {
        terminalState = 'failed'; task.failedStage = 'saving'; task.message = '项目保存失败，请检查写入权限后重试'
      }
      task.state = terminalState
      if (this.cancelRequested.has(task.jobId) && task.state !== 'failed') task.state = 'canceled'
      task.stage = task.state === 'succeeded' ? 'completed' : task.state === 'canceled' ? 'canceled' : 'failed'
      task.progress = task.state === 'succeeded' ? 100 : task.progress
      this.started.delete(task.jobId)
      this.cancelRequested.delete(task.jobId)
      this.eventListeners.forEach((listener) => listener({ ...event, stage: task.stage as JobEvent['stage'], message: task.message, project: task.project }))
      await this.changed()
      this.schedule()
    } else {
      this.eventListeners.forEach((listener) => listener(event))
      // Persist stage transitions and subtitle checkpoints, but keep frequent
      // progress-only updates in memory. Recovery restarts running jobs anyway.
      if (event.project || previousStage !== event.stage) await this.changed()
      else this.listeners.forEach((listener) => listener(this.snapshot()))
    }
  }
}
