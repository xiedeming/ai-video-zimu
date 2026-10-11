import * as Progress from '@radix-ui/react-progress'
import { ArrowLeft, AudioLines, Captions, CircleAlert, Clock3, Cloud, FileDown, FolderSync, HardDriveDownload, Languages, Laptop, Pause, Play, Redo2, Save, Sparkles, Square, Undo2, Video, Waves } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTimecode } from '../../../shared/subtitles'
import type { TranscriptionModelId } from '../../../shared/types'
import { cn } from '../lib/cn'
import { applyMediaSeek, clampSeekMs, findActiveSubtitle, startMediaTimeSync } from '../lib/media-playback'
import { useEditorStore } from '../store'
import { SubtitleList } from './SubtitleList'
import { Tooltip } from './Tooltip'

const formatDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const isLocalEndpoint = (value?: string) => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value ?? '').hostname) } catch { return false }
}

const jobStageLabel = {
  queued: '排队', probing: '读取媒体', preparing: '准备音轨', transcribing: '语音识别', translating: '翻译', completed: '已完成', failed: '失败', canceled: '已取消'
} as const

export function Workspace({ onBack, onSave, onExport, onModels, notify }: {
  onBack: () => void
  onSave: () => Promise<void>
  onExport: () => void
  onModels: () => void
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const document = useEditorStore((state) => state.document)!
  const dirty = useEditorStore((state) => state.dirty)
  const models = useEditorStore((state) => state.models)
  const profiles = useEditorStore((state) => state.translationProfiles)
  const selectedId = useEditorStore((state) => state.selectedId)
  const playheadMs = useEditorStore((state) => state.playheadMs)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const setLanguage = useEditorStore((state) => state.setLanguage)
  const setTranscriptionModel = useEditorStore((state) => state.setTranscriptionModel)
  const setTranslationProfile = useEditorStore((state) => state.setTranslationProfile)
  const activeJobId = useEditorStore((state) => state.activeJobId)
  const jobEvent = useEditorStore((state) => state.jobEvent)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)
  const history = useEditorStore((state) => state.history)
  const future = useEditorStore((state) => state.future)
  const project = document.project
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const fallbackWaveform = useMemo(() => Array.from({ length: 120 }, (_, index) => .12 + Math.abs(Math.sin(index * .71) * .44 + Math.sin(index * .19) * .21)), [project.id])
  const [waveform, setWaveform] = useState(fallbackWaveform)
  const [playbackUrl, setPlaybackUrl] = useState(document.mediaUrl)
  const [creatingProxy, setCreatingProxy] = useState(false)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const pendingSeekMsRef = useRef<number | null>(null)
  const translationProfile = profiles.find((profile) => profile.id === project.settings.translationProfileId)
  const transcriptionModels = models.filter((model) => model.id === 'whisper-large-v3-turbo' || model.id === 'whisper-large-v3')
  const selectedTranscriptionModel = transcriptionModels.find((model) => model.id === project.settings.transcriptionModelId)
  const transcriptionReady = [project.settings.transcriptionModelId, 'silero-vad-v6.2'].every((id) => models.find((model) => model.id === id)?.status === 'ready')
  const translationReady = Boolean(translationProfile) && (translationProfile?.kind !== 'builtin' || models.find((model) => model.id === 'qwen3-8b-q4-k-m')?.status === 'ready')
  const engineReady = transcriptionReady && translationReady
  const selected = project.segments.find((segment) => segment.id === selectedId)
  const sortedSegments = useMemo(
    () => [...project.segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    [project.segments]
  )
  const activeSubtitle = useMemo(
    () => findActiveSubtitle(sortedSegments, playheadMs),
    [playheadMs, sortedSegments]
  )

  const seek = useCallback((ms: number) => {
    const targetMs = clampSeekMs(ms, project.media.durationMs)
    pendingSeekMsRef.current = targetMs
    setPlayhead(targetMs)
    if (mediaRef.current && applyMediaSeek(mediaRef.current, targetMs)) pendingSeekMsRef.current = null
  }, [project.media.durationMs, setPlayhead])

  const applyPendingSeek = (media: HTMLMediaElement) => {
    const targetMs = pendingSeekMsRef.current
    if (targetMs !== null && applyMediaSeek(media, targetMs)) pendingSeekMsRef.current = null
  }

  const handleMediaTimeUpdate = (media: HTMLMediaElement) => {
    if (pendingSeekMsRef.current !== null) {
      applyPendingSeek(media)
      return
    }
    setPlayhead(clampSeekMs(media.currentTime * 1000, project.media.durationMs))
  }

  const togglePlay = useCallback(async () => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) await media.play().catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
    else media.pause()
  }, [notify])

  const startGeneration = async () => {
    if (!transcriptionReady) { notify(`请先下载 ${selectedTranscriptionModel?.name ?? '所选 Whisper'} 和 Silero 语音识别模型`, 'error'); onModels(); return }
    if (!translationReady) { notify(translationProfile ? '请先下载本地 Qwen 翻译模型' : '项目使用的翻译配置不存在，请重新选择', 'error'); onModels(); return }
    if (!document.mediaUrl) return notify('原始媒体已丢失，请先重新关联', 'error')
    if (project.segments.length && !confirm('重新识别会替换当前全部字幕，是否继续？')) return
    try {
      await window.zimu.jobs.start(project, document?.filePath)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const retranslate = useCallback(async (ids?: string[]) => {
    if (!translationReady) { notify(translationProfile ? '当前翻译服务尚未就绪' : '项目使用的翻译配置不存在，请重新选择', 'error'); onModels(); return }
    try {
      await window.zimu.jobs.retranslate(project, ids, document?.filePath)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }, [notify, onModels, project, document?.filePath, translationProfile, translationReady])

  const continueTranslation = useCallback(async () => {
    if (!translationReady) { notify(translationProfile ? '当前翻译服务尚未就绪' : '项目使用的翻译配置不存在，请重新选择', 'error'); onModels(); return }
    try {
      await window.zimu.jobs.continueTranslation(project, document?.filePath)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }, [notify, onModels, project, document?.filePath, translationProfile, translationReady])

  const relink = async () => {
    const result = await window.zimu.project.relinkMedia(project)
    if (result) useEditorStore.getState().setDocument({ ...result, filePath: document.filePath })
  }

  const handlePlaybackError = async () => {
    if (creatingProxy || !document.mediaUrl || playbackUrl !== document.mediaUrl) return
    setCreatingProxy(true)
    pendingSeekMsRef.current = playheadMs
    notify('当前编码无法直接预览，正在生成兼容代理文件')
    try {
      const proxy = await window.zimu.media.createProxy(project.media.path, project.id, project.media.kind)
      setPlaybackUrl(proxy.url)
      notify('兼容预览已生成', 'success')
    } catch (error) {
      notify(`无法生成预览：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setCreatingProxy(false) }
  }

  useEffect(() => {
    pendingSeekMsRef.current = useEditorStore.getState().playheadMs
    setPlaybackUrl(document.mediaUrl)
  }, [document.mediaUrl])

  useEffect(() => {
    let active = true
    void window.zimu.media.waveform(project.media.path, 120).then((peaks) => {
      if (active && peaks.length) setWaveform(peaks)
    }).catch(() => undefined)
    return () => { active = false }
  }, [project.media.path])

  useEffect(() => {
    const media = mediaRef.current
    if (!playing || !media) return
    return startMediaTimeSync(media, (timeMs) => {
      if (pendingSeekMsRef.current !== null) return
      setPlayhead(clampSeekMs(timeMs, project.media.durationMs))
    })
  }, [playbackUrl, playing, project.media.durationMs, setPlayhead])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, select, [contenteditable=true]')) return
      if (event.code === 'Space') { event.preventDefault(); void togglePlay() }
      if (event.key === 'ArrowLeft') seek(Math.max(0, playheadMs - 1000))
      if (event.key === 'ArrowRight') seek(Math.min(project.media.durationMs, playheadMs + 1000))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [playheadMs, project.media.durationMs, seek, togglePlay])

  return (
    <main className="flex h-full flex-col bg-canvas">
      <header className="flex h-[64px] shrink-0 items-center border-b border-line bg-surface px-3">
        <Tooltip label="返回主页"><button className="icon-btn" onClick={onBack} aria-label="返回主页"><ArrowLeft size={19} /></button></Tooltip>
        <div className="mx-2 h-7 w-px bg-line" />
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><Captions size={20} /></span>
        <div className="ml-3 min-w-0"><h1 className="max-w-[360px] truncate text-sm font-bold">{project.title}</h1><p className="max-w-[400px] truncate text-xs text-muted">{project.media.name}{dirty ? ' · 未保存' : ''}</p></div>
        <div className="ml-5 flex items-center gap-1">
          <Tooltip label="撤销 Ctrl+Z"><button className="icon-btn" onClick={undo} disabled={!history.length} aria-label="撤销"><Undo2 size={18} /></button></Tooltip>
          <Tooltip label="重做 Ctrl+Y"><button className="icon-btn" onClick={redo} disabled={!future.length} aria-label="重做"><Redo2 size={18} /></button></Tooltip>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-ghost" onClick={onModels}><HardDriveDownload size={17} />AI 引擎<span className={`h-2 w-2 rounded-full ${engineReady ? 'bg-success' : 'bg-warning'}`} /></button>
          <button className="btn" onClick={() => void onSave()}><Save size={17} />保存</button>
          <button className="btn btn-primary" onClick={onExport} disabled={!project.segments.length}><FileDown size={17} />导出字幕</button>
        </div>
      </header>

      {activeJobId && jobEvent && (
        <div className="flex h-[62px] shrink-0 items-center gap-4 border-b border-primary/30 bg-primary/[.08] px-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/20 text-primary"><Sparkles size={18} className="animate-pulse" /></span>
          <div className="min-w-0 flex-1"><div className="flex justify-between text-sm"><strong>{jobStageLabel[jobEvent.stage]} · {jobEvent.message}</strong><span className="font-mono text-xs text-muted">{Math.round(jobEvent.progress)}%</span></div><Progress.Root value={jobEvent.progress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><Progress.Indicator className="h-full bg-primary transition-transform" style={{ transform: `translateX(-${100 - jobEvent.progress}%)` }} /></Progress.Root></div>
          <button className="btn" onClick={() => void window.zimu.jobs.cancel(activeJobId)}><Square size={15} />取消任务</button>
        </div>
      )}
      {!activeJobId && jobEvent?.stage === 'failed' && <div className="flex min-h-12 items-center gap-3 border-b border-danger/30 bg-danger/10 px-5 text-sm text-danger"><CircleAlert size={17} /><span className="truncate">{jobEvent.message}</span>{jobEvent.remainingSegmentIds?.length ? <button className="ml-auto text-xs font-semibold underline" onClick={() => void retranslate(jobEvent.remainingSegmentIds)}>继续未完成翻译</button> : <button className="ml-auto text-xs font-semibold underline" onClick={() => void startGeneration()}>重试</button>}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(390px,42%)_1fr]">
        <section className="flex min-h-0 flex-col border-r border-line bg-surface" aria-label="媒体预览">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="relative flex min-h-[250px] flex-1 items-center justify-center overflow-hidden rounded-xl border border-line bg-black">
              {document.mediaUrl ? project.media.kind === 'video' ? (
                <video ref={(node) => { mediaRef.current = node }} src={playbackUrl} className="h-full w-full object-contain" onError={() => void handlePlaybackError()} onLoadedMetadata={(event) => applyPendingSeek(event.currentTarget)} onCanPlay={(event) => applyPendingSeek(event.currentTarget)} onTimeUpdate={(event) => handleMediaTimeUpdate(event.currentTarget)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
              ) : (
                <div className="flex flex-col items-center text-muted"><span className="flex h-20 w-20 items-center justify-center rounded-full bg-elevated text-primary"><Waves size={34} /></span><p className="mt-4 text-sm font-semibold text-ink">{creatingProxy ? '正在生成兼容预览…' : project.media.name}</p><audio ref={(node) => { mediaRef.current = node }} src={playbackUrl} onError={() => void handlePlaybackError()} onLoadedMetadata={(event) => applyPendingSeek(event.currentTarget)} onCanPlay={(event) => applyPendingSeek(event.currentTarget)} onTimeUpdate={(event) => handleMediaTimeUpdate(event.currentTarget)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /></div>
              ) : <div className="text-center"><CircleAlert size={32} className="mx-auto text-warning" /><p className="mt-3 text-sm font-semibold">找不到原始媒体</p><button className="btn mt-4" onClick={() => void relink()}><FolderSync size={16} />重新关联</button></div>}
              <span className="absolute right-3 top-3 rounded-md bg-black/75 px-2 py-1 font-mono text-xs text-white">{formatTimecode(playheadMs)}</span>
              {activeSubtitle && (
                <div className="pointer-events-none absolute inset-x-5 bottom-5 z-10 flex justify-center px-3">
                  <div className="max-w-[92%] rounded-lg bg-black/80 px-4 py-2 text-center shadow-lg">
                    <p className="whitespace-pre-wrap break-words text-sm font-medium leading-5 text-white" lang={project.detectedLanguage ?? (project.sourceLanguage === 'auto' ? undefined : project.sourceLanguage)}>
                      {activeSubtitle.sourceText.trim()}
                    </p>
                    {activeSubtitle.translatedText.trim() && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-base font-semibold leading-6 text-white" lang="zh-CN">
                        {activeSubtitle.translatedText.trim()}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-line bg-canvas p-3">
              <button className="flex h-[82px] w-full items-center gap-[2px] overflow-hidden" aria-label="音频波形，点击跳转" onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                seek((event.clientX - rect.left) / rect.width * project.media.durationMs)
              }}>
                {waveform.map((height, index) => <span key={index} className={cn('min-w-[2px] flex-1 rounded-full', index / waveform.length <= playheadMs / Math.max(1, project.media.durationMs) ? 'bg-primary' : 'bg-line')} style={{ height: 10 + height * 64 }} />)}
              </button>
              <div className="mt-2 flex items-center gap-3">
                <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white" onClick={() => void togglePlay()} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" className="ml-0.5" />}</button>
                <span className="w-20 font-mono text-xs text-muted">{formatDuration(playheadMs)} / {formatDuration(project.media.durationMs)}</span>
                <input aria-label="音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => { const next = Number(event.target.value); setVolume(next); if (mediaRef.current) mediaRef.current.volume = next }} className="ml-auto w-24 accent-[rgb(var(--primary))]" />
              </div>
            </div>
          </div>

          <div className="border-t border-line p-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-canvas p-3"><span className="label flex items-center gap-1.5"><Clock3 size={13} />时长</span><strong className="mt-1 block font-mono text-sm">{formatDuration(project.media.durationMs)}</strong></div>
              <div className="rounded-lg bg-canvas p-3"><span className="label flex items-center gap-1.5"><Video size={13} />媒体</span><strong className="mt-1 block text-sm">{project.media.kind === 'video' ? `${project.media.width ?? '—'}×${project.media.height ?? '—'}` : '纯音频'}</strong></div>
              <div className="rounded-lg bg-canvas p-3"><span className="label flex items-center gap-1.5"><Captions size={13} />字幕</span><strong className="mt-1 block text-sm">{project.segments.length} 段</strong></div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="relative flex-1"><span className="sr-only">源语言</span><Languages size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><select className="input w-full appearance-none pl-9" value={project.sourceLanguage} onChange={(event) => setLanguage(event.target.value as 'auto' | 'ja' | 'en')} disabled={Boolean(activeJobId)}><option value="auto">自动检测日语 / 英语</option><option value="ja">日语</option><option value="en">英语</option></select></label>
              <label className="relative"><span className="sr-only">语音识别模型</span><AudioLines size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><select className="input w-full appearance-none pl-9" value={project.settings.transcriptionModelId} onChange={(event) => setTranscriptionModel(event.target.value as TranscriptionModelId)} disabled={Boolean(activeJobId)}>{transcriptionModels.map((model) => <option key={model.id} value={model.id}>{model.id === 'whisper-large-v3' ? 'Large v3 · 通用高精度' : 'Large v3 Turbo · 快速'}</option>)}</select></label>
            </div>
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
              <label className="relative"><span className="sr-only">翻译服务</span>{translationProfile?.kind === 'builtin' ? <Laptop size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /> : <Cloud size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />}<select className="input w-full appearance-none pl-9" value={project.settings.translationProfileId} onChange={(event) => setTranslationProfile(event.target.value)} disabled={Boolean(activeJobId)}>{!translationProfile && <option value={project.settings.translationProfileId}>配置已不存在</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
              <button className="btn btn-primary min-w-[142px]" onClick={() => void startGeneration()} disabled={Boolean(activeJobId)}><Sparkles size={17} />{project.segments.length ? '重新识别' : '生成字幕'}</button>
            </div>
          </div>
        </section>

        <SubtitleList onSeek={seek} onRetranslate={retranslate} onContinueTranslation={continueTranslation} notify={notify} />
      </div>

      <footer className="flex h-8 shrink-0 items-center border-t border-line bg-surface px-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${engineReady ? 'bg-success' : 'bg-warning'}`} />{engineReady ? 'AI 引擎就绪' : 'AI 引擎需要配置'}</span>
        {translationProfile && <span className="ml-5 flex items-center gap-1.5">{translationProfile.kind === 'builtin' || isLocalEndpoint(translationProfile.baseUrl) ? <Laptop size={12} /> : <Cloud size={12} />}{translationProfile.name}</span>}
        {project.detectedLanguage && <span className="ml-5">识别语言：{project.detectedLanguage === 'ja' ? '日语' : '英语'}</span>}
        {selected && <span className="ml-auto font-mono">选中 #{project.segments.findIndex((segment) => segment.id === selected.id) + 1} · {formatTimecode(selected.startMs)} — {formatTimecode(selected.endMs)}</span>}
      </footer>
    </main>
  )
}
