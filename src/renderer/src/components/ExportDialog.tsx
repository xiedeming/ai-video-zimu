import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, CheckCircle2, FileDown, LocateFixed, Wrench, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ExportContent, ExportFormat, ZimuProjectV1 } from '../../../shared/types'
import { formatTimecode, validateSegments } from '../../../shared/subtitles'
import { useEditorStore } from '../store'

export function ExportDialog({ open, onOpenChange, project, notify }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ZimuProjectV1
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const [format, setFormat] = useState<ExportFormat>('srt')
  const [content, setContent] = useState<ExportContent>('bilingual')
  const [busy, setBusy] = useState(false)
  const setSelected = useEditorStore((state) => state.setSelected)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const repairOverlaps = useEditorStore((state) => state.repairOverlaps)
  const issues = useMemo(() => validateSegments(project.segments), [project.segments])
  const overlapIssues = issues.filter((issue) => issue.type === 'overlap')
  const segmentIndex = useMemo(() => new Map(project.segments.map((segment, index) => [segment.id, index])), [project.segments])
  const segmentById = useMemo(() => new Map(project.segments.map((segment) => [segment.id, segment])), [project.segments])

  const exportFile = async () => {
    setBusy(true)
    try {
      const result = await window.zimu.subtitles.export({ project, format, content })
      if (!result.canceled) {
        notify(`字幕已导出：${result.filePath}`, 'success')
        onOpenChange(false)
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const locate = (segmentId: string) => {
    const segment = segmentById.get(segmentId)
    if (!segment) return
    const state = useEditorStore.getState()
    state.setSearch('')
    if (state.lowConfidenceOnly) state.toggleLowConfidence()
    setSelected(segmentId)
    setPlayhead(segment.startMs)
    onOpenChange(false)
  }

  const fixOverlaps = (segmentIds?: string[]) => {
    const count = segmentIds?.length ?? overlapIssues.length
    repairOverlaps(segmentIds ?? overlapIssues.map((issue) => issue.segmentId))
    notify(`已修复 ${count} 个时间码重叠，可使用 Ctrl+Z 撤销`, 'success')
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-panel">
          <header className="flex shrink-0 items-start justify-between border-b border-line px-6 py-5">
            <div><Dialog.Title className="text-xl font-bold">导出字幕</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">选择格式，并在导出前处理时间轴问题。</Dialog.Description></div>
            <Dialog.Close className="icon-btn" aria-label="关闭导出窗口"><X size={19} /></Dialog.Close>
          </header>
          <div className="min-h-0 space-y-6 overflow-y-auto p-6">
            <fieldset>
              <legend className="label mb-3">文件格式</legend>
              <div className="grid grid-cols-3 gap-2">
                {(['srt', 'vtt', 'ass'] as const).map((value) => (
                  <button key={value} className={`min-h-16 rounded-lg border px-3 text-left ${format === value ? 'border-primary bg-primary/10 text-ink' : 'border-line bg-canvas text-muted hover:border-muted/60'}`} onClick={() => setFormat(value)}>
                    <strong className="block text-sm uppercase">{value}</strong><span className="mt-1 block text-xs">{value === 'srt' ? '通用字幕' : value === 'vtt' ? '网页字幕' : '带样式字幕'}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="label mb-3">字幕内容</legend>
              <div className="space-y-2">
                {([
                  ['bilingual', '双语字幕', '原文在上，简体中文在下'],
                  ['translation', '仅简体中文', '适合直接观看'],
                  ['source', '仅原文', '保留日语或英语识别结果']
                ] as const).map(([value, title, description]) => (
                  <label key={value} className={`flex min-h-14 cursor-pointer items-center rounded-lg border px-4 ${content === value ? 'border-primary bg-primary/10' : 'border-line bg-canvas hover:border-muted/60'}`}>
                    <input type="radio" name="content" value={value} checked={content === value} onChange={() => setContent(value)} className="h-4 w-4 accent-[rgb(var(--primary))]" />
                    <span className="ml-3"><strong className="block text-sm text-ink">{title}</strong><span className="text-xs text-muted">{description}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>

            {issues.length ? (
              <section className="rounded-xl border border-warning/40 bg-warning/[.07]" aria-labelledby="subtitle-issues-title">
                <div className="flex items-center gap-3 border-b border-warning/25 px-4 py-3">
                  <AlertTriangle size={19} className="shrink-0 text-warning" />
                  <div className="min-w-0 flex-1"><h3 id="subtitle-issues-title" className="text-sm font-semibold">发现 {issues.length} 个问题</h3><p className="mt-0.5 text-xs text-muted">修复后会立即重新检查；所有修改均可撤销。</p></div>
                  {overlapIssues.length > 0 && <button className="btn min-h-10 shrink-0 border-warning/40 bg-warning/10 text-warning" onClick={() => fixOverlaps()}><Wrench size={15} />修复全部重叠（{overlapIssues.length}）</button>}
                </div>
                <div className="max-h-64 divide-y divide-line/70 overflow-y-auto" role="list" aria-live="polite">
                  {issues.map((issue, issueIndex) => {
                    const segment = segmentById.get(issue.segmentId)
                    const index = segmentIndex.get(issue.segmentId)
                    return <div key={`${issue.segmentId}-${issue.type}-${issueIndex}`} className="flex items-center gap-3 px-4 py-3" role="listitem">
                      <span className="flex h-8 min-w-8 items-center justify-center rounded-md bg-warning/10 px-1.5 font-mono text-xs font-bold text-warning">#{(index ?? 0) + 1}</span>
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-ink">{issue.message}</p>{segment && <p className="mt-0.5 font-mono text-xs text-muted">{formatTimecode(segment.startMs)} → {formatTimecode(segment.endMs)}</p>}</div>
                      <button className="btn min-h-10 px-3 text-xs" onClick={() => locate(issue.segmentId)}><LocateFixed size={14} />定位</button>
                      {issue.type === 'overlap' && <button className="btn min-h-10 px-3 text-xs" onClick={() => fixOverlaps([issue.segmentId])}><Wrench size={14} />修复</button>}
                    </div>
                  })}
                </div>
              </section>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3" role="status">
                <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-success" />
                <div><p className="text-sm font-semibold">共 {project.segments.length} 段，检查通过</p><p className="mt-0.5 text-xs text-muted">时间码连续有效，可以导出。</p></div>
              </div>
            )}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-6 py-4">
            <Dialog.Close className="btn">取消</Dialog.Close>
            <button className="btn btn-primary" onClick={() => void exportFile()} disabled={Boolean(issues.length) || busy}><FileDown size={17} />{busy ? '正在导出' : issues.length ? '请先修复问题' : '选择位置并导出'}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
