import * as Dialog from '@radix-ui/react-dialog'
import { Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BatchRequest, BatchValidationRow, GenerationOptions } from '../../../shared/queue'
import { BUILTIN_TRANSLATION_PROFILE_ID, DEFAULT_TRANSCRIPTION_MODEL_ID } from '../../../shared/types'
import { useEditorStore } from '../store'

function Options({ value, onChange, disabled }: { value: GenerationOptions; onChange: (value: GenerationOptions) => void; disabled?: boolean }) {
  const profiles = useEditorStore((state) => state.translationProfiles)
  return <fieldset disabled={disabled} className="grid grid-cols-4 gap-3">
    <label className="label">源语言<select className="input mt-1 w-full" value={value.sourceLanguage} onChange={(event) => onChange({ ...value, sourceLanguage: event.target.value as GenerationOptions['sourceLanguage'] })}><option value="auto">自动检测</option><option value="ja">日语</option><option value="en">英语</option></select></label>
    <label className="label">识别模型<select className="input mt-1 w-full" value={value.transcriptionModelId} onChange={(event) => onChange({ ...value, transcriptionModelId: event.target.value as GenerationOptions['transcriptionModelId'] })}><option value="whisper-large-v3-turbo">Large v3 Turbo</option><option value="whisper-large-v3">Large v3</option></select></label>
    <label className="label">生成内容<select className="input mt-1 w-full" value={String(value.translate)} onChange={(event) => onChange({ ...value, translate: event.target.value === 'true' })}><option value="true">识别并翻译</option><option value="false">仅识别原文</option></select></label>
    <label className="label">翻译服务<select className="input mt-1 w-full" disabled={!value.translate} value={value.translationProfileId} onChange={(event) => onChange({ ...value, translationProfileId: event.target.value })}>{!profiles.some((profile) => profile.id === value.translationProfileId) && <option value={value.translationProfileId}>本地 Qwen3</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
  </fieldset>
}

export function BatchDialog({ open, paths, onClose, onSubmitted, notify }: {
  open: boolean; paths: string[]; onClose: () => void; onSubmitted: () => void
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const profiles = useEditorStore((state) => state.translationProfiles)
  const applyQueue = useEditorStore((state) => state.applyQueue)
  const [items, setItems] = useState<BatchRequest['items']>([])
  const [options, setOptions] = useState<GenerationOptions>({ sourceLanguage: 'auto', transcriptionModelId: DEFAULT_TRANSCRIPTION_MODEL_ID, translationProfileId: BUILTIN_TRANSLATION_PROFILE_ID, translate: true })
  const [concurrency, setConcurrency] = useState<1 | 2>(1)
  const [rows, setRows] = useState<BatchValidationRow[]>([])
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checkError, setCheckError] = useState('')
  useEffect(() => {
    if (open) {
      setItems(paths.map((mediaPath) => ({ mediaPath })))
      setOptions((current) => ({ ...current, translationProfileId: profiles.find((profile) => profile.isDefault)?.id ?? BUILTIN_TRANSLATION_PROFILE_ID }))
      setConcurrency(useEditorStore.getState().queue.concurrency)
      setRows([])
    }
  }, [open, paths])
  useEffect(() => {
    if (!open || !items.length) { setRows([]); return }
    let live = true
    setChecking(true)
    setCheckError('')
    const timer = setTimeout(() => {
      void window.zimu.queue.validate({ items, options, concurrency }).then((result) => { if (live) setRows(result) }).catch(() => { if (live) { setRows([]); setCheckError('检查失败，请重新添加文件或调整参数') } }).finally(() => { if (live) setChecking(false) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [open, items, options, concurrency])
  const add = async () => {
    try { const selected = await window.zimu.queue.choose(); setItems((current) => [...current, ...selected.map((mediaPath) => ({ mediaPath }))]) }
    catch { notify('无法选择媒体文件', 'error') }
  }
  const submit = async () => {
    setBusy(true)
    try { applyQueue(await window.zimu.queue.submit({ items, options, concurrency })); onSubmitted() }
    catch { notify('批次提交失败，请检查文件、模型和目录权限后重试', 'error'); setItems((current) => [...current]) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/70" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[111] flex max-h-[85vh] w-[min(960px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface p-6 shadow-panel">
      <div className="flex items-center justify-between"><Dialog.Title className="text-xl font-bold">批量生成字幕</Dialog.Title><Dialog.Close className="icon-btn" aria-label="关闭批量配置" disabled={busy}><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="mt-2 text-sm text-muted">每个视频创建独立项目，保存到视频所在目录。提交后参数固定，可在任务运行时切换项目。</Dialog.Description>
      <div className="mt-5"><h3 className="mb-3 font-semibold">统一参数</h3><Options value={options} onChange={setOptions} disabled={busy} /></div>
      <div className="my-4 flex items-center justify-between"><button className="btn" onClick={() => void add()} disabled={busy}><Plus size={17} />添加视频</button><label className="label">并发数 <select className="input ml-2" value={concurrency} disabled={busy} onChange={(event) => setConcurrency(Number(event.target.value) as 1 | 2)}><option value={1}>1 · 串行</option><option value={2}>2 · 同时处理</option></select></label></div>
      <div className="min-h-24 flex-1 space-y-3 overflow-y-auto" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault()
        if (!busy) setItems((current) => [...current, ...Array.from(event.dataTransfer.files).map((file) => ({ mediaPath: window.zimu.media.pathForFile(file) }))])
      }}>
        {!items.length && <p className="rounded-xl border border-dashed border-line p-8 text-center text-muted">选择多个视频，或将视频拖到这里</p>}
        {items.map((item, index) => <section key={`${index}-${item.mediaPath}`} className="rounded-xl border border-line p-3">
          <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><strong className="block truncate text-sm" title={item.mediaPath}>{item.mediaPath.split(/[\\/]/).at(-1)}</strong><p className="mt-1 break-all text-xs text-muted">预计保存：{rows[index]?.filePath ?? '检查中…'}</p></div><button className="btn" disabled={busy} onClick={() => setItems((current) => current.map((row, i) => i === index ? { ...row, overrides: row.overrides ? undefined : { ...options } } : row))}>{item.overrides ? '使用统一参数' : '单项覆盖'}</button><button className="icon-btn" disabled={busy} aria-label={`移除第 ${index + 1} 个视频`} onClick={() => setItems((current) => current.filter((_, i) => i !== index))}><X size={16} /></button></div>
          {rows[index]?.error && <p role="alert" className="mt-2 text-sm text-danger">{rows[index].error}</p>}
          {item.overrides && <div className="mt-3"><Options value={{ ...options, ...item.overrides }} disabled={busy} onChange={(overrides) => setItems((current) => current.map((row, i) => i === index ? { ...row, overrides } : row))} /></div>}
        </section>)}
      </div>
      <div className="mt-5 flex items-center justify-between"><span role="status" className="text-sm text-muted">{checkError || (checking ? '正在检查文件、模型和写入权限…' : `${items.length} 个视频 · 结果仅保存到项目`)}</span><button className="btn btn-primary" disabled={busy || checking || !items.length || rows.length !== items.length || rows.some((row) => row.error)} onClick={() => void submit()}>{busy ? '正在提交…' : '加入队列'}</button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
