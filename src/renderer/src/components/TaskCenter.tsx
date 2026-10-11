import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import type { QueueControl } from '../../../shared/queue'
import { useEditorStore } from '../store'

const states = { waiting: '等待', running: '运行中', succeeded: '成功', failed: '失败', canceled: '已取消', interrupted: '已中断' }
const stages = { queued: '检查', probing: '读取媒体', preparing: '准备音频', transcribing: '识别', translating: '翻译', saving: '保存', completed: '完成', failed: '失败', canceled: '取消' }

export function TaskCenter({ open, onClose, onAdd, onProject, notify }: {
  open: boolean; onClose: () => void; onAdd: () => void; onProject: (id: string) => void
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const queue = useEditorStore((state) => state.queue)
  const applyQueue = useEditorStore((state) => state.applyQueue)
  const [busy, setBusy] = useState(false)
  const control = async (request: QueueControl) => {
    setBusy(true)
    try { applyQueue(await window.zimu.queue.control(request)) } catch { notify('队列操作失败，请检查应用数据目录', 'error') }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/70" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[111] flex max-h-[85vh] w-[min(1000px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface p-6 shadow-panel">
      <div className="flex items-center justify-between"><Dialog.Title className="text-xl font-bold">任务中心</Dialog.Title><Dialog.Close className="icon-btn" aria-label="关闭任务中心"><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="mt-2 text-sm text-muted">已完成 {queue.tasks.filter((task) => task.state === 'succeeded').length} / {queue.tasks.length} · 失败 {queue.tasks.filter((task) => task.state === 'failed').length} · 运行 {queue.tasks.filter((task) => task.state === 'running').length} · 并发上限 {queue.concurrency}</Dialog.Description>
      {queue.recovery && <p role="status" className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">已恢复上次队列，尚未开始执行。继续后将重新检查文件和模型，中断任务从头生成。</p>}
      <div className="my-4 flex flex-wrap items-center gap-2"><button className="btn btn-primary" onClick={onAdd}>追加批次</button><button className="btn" disabled={busy} onClick={() => void control({ action: queue.paused ? 'resume' : 'pause' })}>{queue.paused ? '继续队列' : '暂停队列'}</button><button className="btn" disabled={busy} onClick={() => void control({ action: 'cancel-all' })}>取消全部</button><button className="btn" disabled={busy} onClick={() => void control({ action: 'clear' })}>清除已结束</button><label className="label ml-auto">并发 <select className="input ml-2" disabled={busy} value={queue.concurrency} onChange={(event) => void control({ action: 'concurrency', value: Number(event.target.value) as 1 | 2 })}><option value={1}>1</option><option value={2}>2</option></select></label></div>
      <p className="mb-3 text-xs text-muted">{queue.paused ? '已暂停，新任务不会启动；运行中的任务继续。' : '按入队顺序执行；降低并发不会终止运行中的任务。'}</p>
      <div className="space-y-3 overflow-y-auto">
        {!queue.tasks.length && <p className="p-10 text-center text-muted">还没有任务，添加一批视频开始。</p>}
        {queue.tasks.map((task) => <section key={task.jobId} className="rounded-xl border border-line p-4">
          <div className="flex items-center gap-3"><strong className="min-w-0 flex-1 truncate">{task.project.media.name}</strong><span className={`badge ${task.state === 'failed' ? 'text-danger' : task.state === 'succeeded' ? 'text-success' : 'text-muted'}`}>{states[task.state]}</span><span className="text-xs text-muted">{stages[task.stage]} · {Math.round(task.progress)}%</span><button className="btn" onClick={() => onProject(task.projectId)}>查看项目</button>{['waiting', 'running', 'interrupted'].includes(task.state) && <button className="btn" disabled={busy} onClick={() => void control({ action: 'cancel', jobId: task.jobId })}>取消</button>}{['failed', 'canceled', 'interrupted'].includes(task.state) && <button className="btn" disabled={busy} onClick={() => void control({ action: 'retry', jobId: task.jobId })}>重试</button>}</div>
          <progress className="mt-3 h-1.5 w-full accent-primary" max={100} value={task.progress} aria-label={`${task.project.media.name} 进度`} />
          <p className="mt-2 text-sm text-muted">{task.message}{task.failedStage && ` · 失败阶段：${stages[task.failedStage as keyof typeof stages] ?? task.failedStage}`}</p>
        </section>)}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
