import { Captions, CheckCircle2, CircleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ModelProgressEvent, ProjectDocument } from '../../shared/types'
import { ExportDialog } from './components/ExportDialog'
import { Home } from './components/Home'
import { ModelDialog } from './components/ModelDialog'
import { Workspace } from './components/Workspace'
import { BatchDialog } from './components/BatchDialog'
import { TaskCenter } from './components/TaskCenter'
import { useEditorStore } from './store'

interface ToastState { message: string; kind: 'error' | 'success' }

export function App() {
  const document = useEditorStore((state) => state.document)
  const models = useEditorStore((state) => state.models)
  const recent = useEditorStore((state) => state.recent)
  const setTranslationProfiles = useEditorStore((state) => state.setTranslationProfiles)
  const dirty = useEditorStore((state) => state.dirty)
  const setDocument = useEditorStore((state) => state.setDocument)
  const setModels = useEditorStore((state) => state.setModels)
  const setRecent = useEditorStore((state) => state.setRecent)
  const markSaved = useEditorStore((state) => state.markSaved)
  const applyJobEvent = useEditorStore((state) => state.applyJobEvent)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)
  const queue = useEditorStore((state) => state.queue)
  const activeJobId = useEditorStore((state) => state.activeJobId)
  const documents = useEditorStore((state) => state.documents)
  const applyQueue = useEditorStore((state) => state.applyQueue)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchPaths, setBatchPaths] = useState<string[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [toast, setToast] = useState<ToastState>()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const notify = (message: string, kind: 'error' | 'success' = 'success') => {
    setToast({ message, kind })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 5000)
  }

  const loadBase = async () => {
    const [nextModels, nextProfiles, nextRecent] = await Promise.all([window.zimu.models.list(), window.zimu.translationProfiles.list(), window.zimu.project.recent()])
    setModels(nextModels)
    setTranslationProfiles(nextProfiles)
    setRecent(nextRecent)
  }

  useEffect(() => {
    void loadBase().catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
    const stopModels = window.zimu.models.onProgress((progress: ModelProgressEvent) => {
      const current = useEditorStore.getState().models
      setModels(current.map((model) => model.id === progress.id ? {
        ...model, status: progress.status, downloadedBytes: progress.downloadedBytes,
        error: progress.status === 'error' ? progress.message : undefined
      } : model))
      if (progress.status === 'ready') void window.zimu.models.list().then(setModels)
    })
    const stopJobs = window.zimu.jobs.onEvent((event) => {
      applyJobEvent(event)
      if (event.stage === 'completed') notify(event.message, 'success')
      if (event.stage === 'failed') notify(event.message, 'error')
    })
    const stopQueue = window.zimu.queue.onUpdate(applyQueue)
    void window.zimu.queue.snapshot().then((snapshot) => { applyQueue(snapshot); if (snapshot.recovery) setTasksOpen(true) }).catch(() => notify('无法恢复任务队列，请检查应用数据目录', 'error'))
    return () => { stopModels(); stopJobs(); stopQueue(); if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [])

  useEffect(() => {
    if (!document || !dirty) return
    const timer = setTimeout(() => void window.zimu.project.autosave(document.project).catch(() => undefined), 1400)
    return () => clearTimeout(timer)
  }, [document?.project.updatedAt, dirty])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 's') { event.preventDefault(); void save() }
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo() }
      if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const setDoc = (next: ProjectDocument | null) => {
    setDocument(next)
    setExportOpen(false)
  }

  const importMedia = async (path?: string) => {
    try {
      const next = await window.zimu.project.create(path)
      if (next) setDoc(next)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const open = async () => {
    try { const next = await window.zimu.project.open(); if (next) setDoc(next) }
    catch (error) { notify(`无法打开项目：${error instanceof Error ? error.message : String(error)}`, 'error') }
  }

  const openRecent = async (filePath: string) => {
    try { setDoc(await window.zimu.project.openRecent(filePath)) }
    catch (error) { notify(`最近项目无法打开：${error instanceof Error ? error.message : String(error)}`, 'error') }
  }

  const save = async () => {
    const current = useEditorStore.getState().document
    if (!current || useEditorStore.getState().activeJobId) return
    try {
      const result = await window.zimu.project.save(current.project, current.filePath)
      if (result) {
        if (useEditorStore.getState().document?.project.id === current.project.id) {
          // Do not replace edits made while the save dialog was open.
          if (useEditorStore.getState().document?.project.updatedAt === current.project.updatedAt) { setDocument(result); markSaved(result.filePath) }
        } else {
          useEditorStore.setState((state) => ({ documents: { ...state.documents, [current.project.id]: result }, sessions: { ...state.sessions, [current.project.id]: { ...state.sessions[current.project.id], dirty: false } } }))
        }
        setRecent(await window.zimu.project.recent())
        notify('项目已保存', 'success')
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const back = () => {
    if (dirty && !confirm('当前项目有未保存修改，确定返回主页吗？自动恢复副本仍会保留。')) return
    setDoc(null)
    void loadBase()
  }
  const openBatch = (paths: string[] = []) => { setTasksOpen(false); setBatchPaths(paths); setBatchOpen(true) }
  const selectProject = (id: string) => {
    if (useEditorStore.getState().document?.project.id !== id) useEditorStore.getState().switchProject(id)
    setTasksOpen(false)
    const selected = useEditorStore.getState().document
    if (selected && !selected.mediaUrl) void window.zimu.media.toUrl(selected.project.media.path).then((mediaUrl) => {
      useEditorStore.setState((state) => ({
        documents: { ...state.documents, [id]: { ...state.documents[id], mediaUrl } },
        document: state.document?.project.id === id ? { ...state.document, mediaUrl } : state.document
      }))
    }).catch(() => notify('无法读取项目媒体', 'error'))
  }

  return (
    <div className="flex h-full flex-col bg-canvas pt-9">
      <div className="fixed left-0 right-0 top-0 z-[100] flex h-9 items-center border-b border-line bg-surface px-3 text-xs text-muted" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <Captions size={14} className="mr-2 text-primary" /><span>字幕工坊</span>
      </div>
      <nav className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5" aria-label="项目与任务">
        <label className="label">项目 <select className="input ml-2 max-w-[260px]" value={document?.project.id ?? ''} onChange={(event) => { if (event.target.value) selectProject(event.target.value) }}><option value="">选择项目</option>{Object.values(documents).map((item) => <option key={item.project.id} value={item.project.id}>{item.project.title}</option>)}</select></label>
        {activeJobId && <span className="text-xs text-warning">正在生成 · 字幕只读</span>}
        <button className="btn ml-auto" onClick={() => openBatch()}>批量生成字幕</button><button className="btn" onClick={() => setTasksOpen(true)}>任务中心 · {queue.tasks.filter((task) => ['waiting', 'running', 'interrupted'].includes(task.state)).length}</button>
      </nav>
      <div className="min-h-0 flex-1">
      {document ? (
        <Workspace key={document.project.id} onBack={back} onSave={save} onExport={() => setExportOpen(true)} onModels={() => setModelOpen(true)} notify={notify} />
      ) : (
        <Home models={models} recent={recent} onImport={importMedia} onBatch={openBatch} onOpen={open} onOpenRecent={openRecent} onModels={() => setModelOpen(true)} notify={notify} />
      )}
      </div>
      <BatchDialog open={batchOpen} paths={batchPaths} onClose={() => setBatchOpen(false)} onSubmitted={() => { setBatchOpen(false); setTasksOpen(true) }} notify={notify} />
      <TaskCenter open={tasksOpen} onClose={() => setTasksOpen(false)} onAdd={() => openBatch()} onProject={selectProject} notify={notify} />
      <ModelDialog open={modelOpen} onOpenChange={setModelOpen} notify={notify} />
      {document && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} project={document.project} notify={notify} />}
      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-10 left-1/2 z-[80] flex max-w-[680px] -translate-x-1/2 items-center gap-3 rounded-xl border px-4 py-3 shadow-panel ${toast.kind === 'error' ? 'border-danger/40 bg-[#2b171d] text-danger' : 'border-success/40 bg-[#10251f] text-success'}`}>
          {toast.kind === 'error' ? <CircleAlert size={19} /> : <CheckCircle2 size={19} />}<span className="text-sm font-semibold">{toast.message}</span><button className="ml-2 flex h-8 w-8 items-center justify-center rounded-md hover:bg-white/10" onClick={() => setToast(undefined)} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}
    </div>
  )
}
