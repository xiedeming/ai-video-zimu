import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, CirclePlay, CornerDownRight, Languages, ListCollapse, Merge, Plus, RefreshCw, Scissors, Search, Trash2, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { SubtitleSegment } from '../../../shared/types'
import { formatTimecode, mergeAdjacentDuplicateSegments, parseTimecode, untranslatedSegmentIds } from '../../../shared/subtitles'
import { cn } from '../lib/cn'
import { useEditorStore } from '../store'
import { Tooltip } from './Tooltip'

function TimecodeInput({ value, onCommit, label }: { value: number; onCommit: (value: number) => void; label: string }) {
  const [text, setText] = useState(formatTimecode(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setText(formatTimecode(value)), [value])
  const commit = () => {
    const parsed = parseTimecode(text)
    if (parsed === null) { setInvalid(true); setText(formatTimecode(value)); return }
    setInvalid(false)
    if (parsed !== value) onCommit(parsed)
  }
  return <input aria-label={label} className={cn('h-9 w-[112px] rounded-md border bg-canvas px-2 font-mono text-xs text-ink', invalid ? 'border-danger' : 'border-line')} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}

function SubtitleRow({ segment, index, selected, onSelect, onRetranslate, retranslationDisabled }: {
  segment: SubtitleSegment
  index: number
  selected: boolean
  onSelect: () => void
  onRetranslate: () => void
  retranslationDisabled: boolean
}) {
  const updateSegment = useEditorStore((state) => state.updateSegment)
  const deleteSegment = useEditorStore((state) => state.deleteSegment)
  const mergeNext = useEditorStore((state) => state.mergeNext)
  const [source, setSource] = useState(segment.sourceText)
  const [translation, setTranslation] = useState(segment.translatedText)
  useEffect(() => setSource(segment.sourceText), [segment.sourceText])
  useEffect(() => setTranslation(segment.translatedText), [segment.translatedText])
  const confidence = Math.round(segment.confidence * 100)

  return (
    <article className={cn('group absolute left-0 top-0 w-full px-3 py-2', selected && 'z-10')}>
      <div className={cn('rounded-xl border bg-surface p-3 transition-colors', selected ? 'border-primary shadow-[0_0_0_1px_rgba(91,141,255,.24)]' : 'border-line hover:border-muted/50')} onMouseDown={onSelect}>
        <div className="flex items-center gap-2">
          <span className="flex h-7 min-w-7 items-center justify-center rounded-md bg-elevated px-1.5 font-mono text-xs font-bold text-muted">{index + 1}</span>
          <TimecodeInput label={`第 ${index + 1} 段开始时间`} value={segment.startMs} onCommit={(startMs) => updateSegment(segment.id, { startMs })} />
          <span className="text-xs text-muted">→</span>
          <TimecodeInput label={`第 ${index + 1} 段结束时间`} value={segment.endMs} onCommit={(endMs) => updateSegment(segment.id, { endMs })} />
          <span className={cn('badge ml-1', confidence < 65 ? 'border-warning/30 bg-warning/10 text-warning' : confidence > 88 ? 'border-success/30 bg-success/10 text-success' : '')}>{confidence < 65 && <AlertTriangle size={12} className="mr-1" />}{confidence}%</span>
          {segment.status === 'reviewed' && <span className="badge border-success/30 bg-success/10 text-success"><Check size={12} className="mr-1" />已校对</span>}
          <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Tooltip label="重新翻译这一段"><button className="icon-btn h-8 w-8" aria-label="重新翻译这一段" disabled={retranslationDisabled} onClick={(event) => { event.stopPropagation(); onRetranslate() }}><Languages size={15} /></button></Tooltip>
            <Tooltip label="与下一段合并"><button className="icon-btn h-8 w-8" aria-label="与下一段合并" onClick={(event) => { event.stopPropagation(); mergeNext(segment.id) }}><Merge size={15} /></button></Tooltip>
            <Tooltip label="删除字幕"><button className="icon-btn h-8 w-8 hover:text-danger" aria-label="删除字幕" onClick={(event) => { event.stopPropagation(); deleteSegment(segment.id) }}><Trash2 size={15} /></button></Tooltip>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-[46px_1fr] gap-x-3 gap-y-2">
          <span className="pt-2 text-xs font-semibold text-muted">原文</span>
          <textarea aria-label={`第 ${index + 1} 段原文`} className="min-h-[54px] resize-none rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] leading-5 text-ink hover:border-muted/60" value={source} onChange={(event) => setSource(event.target.value)} onBlur={() => { if (source !== segment.sourceText) updateSegment(segment.id, { sourceText: source }) }} />
          <span className="pt-2 text-xs font-semibold text-primary">中文</span>
          <textarea aria-label={`第 ${index + 1} 段中文`} className="min-h-[54px] resize-none rounded-lg border border-primary/30 bg-primary/[.045] px-3 py-2 text-[14px] leading-5 text-ink hover:border-primary/60" value={translation} onChange={(event) => setTranslation(event.target.value)} onBlur={() => { if (translation !== segment.translatedText) updateSegment(segment.id, { translatedText: translation }) }} />
        </div>
      </div>
    </article>
  )
}

export const SubtitleList = memo(function SubtitleList({ onSeek, onRetranslate, onContinueTranslation, notify }: {
  onSeek: (ms: number) => void
  onRetranslate: (ids?: string[]) => void
  onContinueTranslation: () => void
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const document = useEditorStore((state) => state.document)
  const selectedId = useEditorStore((state) => state.selectedId)
  const activeJobId = useEditorStore((state) => state.activeJobId)
  const setSelected = useEditorStore((state) => state.setSelected)
  const search = useEditorStore((state) => state.search)
  const setSearch = useEditorStore((state) => state.setSearch)
  const lowConfidenceOnly = useEditorStore((state) => state.lowConfidenceOnly)
  const toggleLowConfidence = useEditorStore((state) => state.toggleLowConfidence)
  const addSegment = useEditorStore((state) => state.addSegment)
  const splitSegment = useEditorStore((state) => state.splitSegment)
  const updateSegment = useEditorStore((state) => state.updateSegment)
  const mergeDuplicateSegments = useEditorStore((state) => state.mergeDuplicateSegments)
  const [showReplace, setShowReplace] = useState(false)
  const [replacement, setReplacement] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)
  const allSegments = document?.project.segments ?? []
  const pendingTranslationIds = useMemo(() => untranslatedSegmentIds(allSegments), [allSegments])
  const duplicatePreview = useMemo(() => mergeAdjacentDuplicateSegments(allSegments, { maxGapMs: 1000, protectEdited: true }), [allSegments])
  const indexMap = useMemo(() => new Map(allSegments.map((segment, index) => [segment.id, index])), [allSegments])
  const segments = useMemo(() => allSegments.filter((segment) => {
    const matchesSearch = !search || segment.sourceText.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || segment.translatedText.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    return matchesSearch && (!lowConfidenceOnly || segment.confidence < .65)
  }), [allSegments, lowConfidenceOnly, search])
  const virtualizer = useVirtualizer({ count: segments.length, getScrollElement: () => parentRef.current, estimateSize: () => 221, overscan: 5 })

  useEffect(() => {
    if (!selectedId) return
    const index = segments.findIndex((segment) => segment.id === selectedId)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
  }, [selectedId, segments, virtualizer])

  const replaceAll = () => {
    if (!search) return
    allSegments.forEach((segment) => {
      const replace = (text: string) => text.split(search).join(replacement)
      const sourceText = replace(segment.sourceText)
      const translatedText = replace(segment.translatedText)
      if (sourceText !== segment.sourceText || translatedText !== segment.translatedText) updateSegment(segment.id, { sourceText, translatedText })
    })
  }

  const cleanDuplicates = () => {
    if (!duplicatePreview.mergedCount) return
    const conflictNote = duplicatePreview.skippedConflictCount
      ? `；另有 ${duplicatePreview.skippedConflictCount} 处包含人工编辑或不同翻译，将保留不变`
      : ''
    if (!confirm(`将合并 ${duplicatePreview.mergedCount} 段相邻重复字幕${conflictNote}。该操作可使用 Ctrl+Z 撤销，是否继续？`)) return
    const result = mergeDuplicateSegments()
    notify(`已合并 ${result.mergedCount} 段重复字幕，跳过 ${result.skippedConflictCount} 处冲突，当前共 ${result.segments.length} 段`, 'success')
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-canvas" aria-label="字幕编辑器">
      <div className="flex min-h-[60px] items-center gap-2 border-b border-line px-3">
        <div className="relative min-w-[220px] max-w-[360px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input w-full pl-9 pr-9" placeholder="搜索原文或中文" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索字幕" />
          {search && <button className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-muted hover:text-ink" onClick={() => setSearch('')} aria-label="清除搜索"><X size={15} /></button>}
        </div>
        <button className={cn('btn px-3', lowConfidenceOnly && 'border-warning/40 bg-warning/10 text-warning')} onClick={toggleLowConfidence}><AlertTriangle size={16} />低置信度</button>
        <button className="btn px-3" onClick={() => setShowReplace(!showReplace)}><CornerDownRight size={16} />替换</button>
        <button className="btn px-3" onClick={cleanDuplicates} disabled={!duplicatePreview.mergedCount} title={duplicatePreview.mergedCount ? `可合并 ${duplicatePreview.mergedCount} 段，跳过 ${duplicatePreview.skippedConflictCount} 处冲突` : '没有可安全合并的相邻重复字幕'}><ListCollapse size={16} />合并重复{duplicatePreview.mergedCount > 0 && <span className="badge ml-1 border-primary/30 text-primary">{duplicatePreview.mergedCount}</span>}</button>
        <div className="mx-1 h-6 w-px bg-line" />
        <Tooltip label="在当前字幕后添加"><button className="icon-btn" onClick={addSegment} aria-label="添加字幕"><Plus size={18} /></button></Tooltip>
        <Tooltip label="在播放头处分割"><button className="icon-btn" onClick={() => splitSegment()} aria-label="分割字幕" disabled={!selectedId}><Scissors size={18} /></button></Tooltip>
      </div>
      {showReplace && <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2"><span className="label">替换为</span><input className="input h-10 min-h-10 flex-1" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="输入替换文本" /><button className="btn h-10 min-h-10" onClick={replaceAll} disabled={!search}>全部替换</button></div>}
      <div className="flex min-h-12 items-center gap-3 border-b border-line bg-surface/70 px-3 text-xs text-muted">
        <span>{segments.length === allSegments.length ? `共 ${allSegments.length} 段字幕` : `显示 ${segments.length} / ${allSegments.length} 段`}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn btn-primary px-3"
            onClick={onContinueTranslation}
            disabled={Boolean(activeJobId) || !pendingTranslationIds.length}
            title={pendingTranslationIds.length ? `只翻译 ${pendingTranslationIds.length} 段译文为空的字幕` : '所有包含原文的字幕均已翻译'}
            aria-label={pendingTranslationIds.length ? `继续翻译 ${pendingTranslationIds.length} 段未翻译字幕` : '没有未翻译字幕'}
          >
            <CirclePlay size={16} />继续翻译
            {pendingTranslationIds.length > 0 && <span className="badge ml-1 border-white/30 bg-white/10 text-white">{pendingTranslationIds.length}</span>}
          </button>
          <button className="btn px-3" onClick={() => onRetranslate()} disabled={Boolean(activeJobId) || !allSegments.length} title="重新翻译并覆盖全部现有译文"><RefreshCw size={16} />全部重译</button>
        </div>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const segment = segments[item.index]
            return <div key={segment.id} style={{ transform: `translateY(${item.start}px)`, height: item.size, position: 'absolute', top: 0, left: 0, width: '100%' }}>
              <SubtitleRow segment={segment} index={indexMap.get(segment.id) ?? item.index} selected={selectedId === segment.id} onSelect={() => { setSelected(segment.id); onSeek(segment.startMs) }} onRetranslate={() => onRetranslate([segment.id])} retranslationDisabled={Boolean(activeJobId)} />
            </div>
          })}
        </div>
        {!segments.length && <div className="flex h-full min-h-[280px] flex-col items-center justify-center text-center"><Search size={28} className="text-muted" /><p className="mt-3 text-sm font-semibold">没有符合条件的字幕</p><button className="btn btn-ghost mt-2" onClick={() => { setSearch(''); if (lowConfidenceOnly) toggleLowConfidence() }}>清除筛选</button></div>}
      </div>
    </section>
  )
})
