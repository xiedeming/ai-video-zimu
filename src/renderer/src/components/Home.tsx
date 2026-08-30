import { Captions, CheckCircle2, ChevronRight, FileAudio2, FileVideo2, FolderOpen, HardDriveDownload, Languages, LockKeyhole, Sparkles } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { DEFAULT_TRANSCRIPTION_MODEL_ID, type ModelState, type RecentProject } from '../../../shared/types'
import { useEditorStore } from '../store'

export function Home({
  models, recent, onImport, onOpen, onOpenRecent, onModels, notify
}: {
  models: ModelState[]
  recent: RecentProject[]
  onImport: (path?: string) => Promise<void>
  onOpen: () => Promise<void>
  onOpenRecent: (filePath: string) => Promise<void>
  onModels: () => void
  notify: (message: string, kind?: 'error' | 'success') => void
}) {
  const [dragging, setDragging] = useState(false)
  const profiles = useEditorStore((state) => state.translationProfiles)
  const defaultProfile = profiles.find((profile) => profile.isDefault)
  const requiredIds = new Set([DEFAULT_TRANSCRIPTION_MODEL_ID, 'silero-vad-v6.2', ...(defaultProfile?.kind === 'builtin' ? ['qwen3-8b-q4-k-m'] : [])])
  const requiredModels = models.filter((model) => requiredIds.has(model.id))
  const ready = Boolean(defaultProfile) && requiredModels.length === requiredIds.size && requiredModels.every((model) => model.status === 'ready')
  const readyCount = requiredModels.filter((model) => model.status === 'ready').length

  const drop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = window.zimu.media.pathForFile(file)
    if (!path) return notify('无法读取拖入文件的本地路径', 'error')
    await onImport(path)
  }

  return (
    <main className="h-full overflow-y-auto bg-canvas">
      <header className="mx-auto flex max-w-[1240px] items-center justify-between px-10 py-7">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-white shadow-lg shadow-primary/20"><Captions size={24} /></span>
          <div><h1 className="text-lg font-bold leading-tight">字幕工坊</h1><p className="text-xs text-muted">Zimu Studio · 本地 AI 字幕工作台</p></div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost" onClick={() => void onOpen()}><FolderOpen size={17} />打开项目</button>
          <button className="btn" onClick={onModels}><HardDriveDownload size={17} />AI 引擎 <span className={`ml-1 h-2 w-2 rounded-full ${ready ? 'bg-success' : 'bg-warning'}`} /></button>
        </div>
      </header>

      <section className="mx-auto grid max-w-[1240px] grid-cols-[1.45fr_.85fr] gap-8 px-10 pb-10 pt-10">
        <div>
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary"><Sparkles size={14} />媒体不离开你的电脑</span>
            <h2 className="mt-5 text-[42px] font-bold leading-[1.14] tracking-[-.035em] text-ink">日语、英语音视频<br />一键生成中文字幕</h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted">本地识别、自然翻译、逐段校对。从媒体到双语字幕，一处完成。</p>
          </div>

          <div
            className={`mt-9 flex min-h-[230px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-8 text-center transition-colors ${dragging ? 'border-primary bg-primary/10' : 'border-line bg-surface hover:border-primary/70 hover:bg-elevated/70'}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
            onDrop={(event) => void drop(event)}
            onClick={() => void onImport()}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void onImport() }}
            role="button" tabIndex={0} aria-label="导入视频或音频"
          >
            <div className="flex gap-2 text-primary"><FileVideo2 size={32} /><FileAudio2 size={32} /></div>
            <h3 className="mt-4 text-lg font-bold">拖入视频或音频</h3>
            <p className="mt-2 text-sm text-muted">或点击选择文件 · MP4、MKV、MOV、MP3、WAV、M4A 等</p>
            <span className="btn btn-primary mt-5 pointer-events-none">选择媒体文件</span>
          </div>

          <div className="mt-7 grid grid-cols-3 gap-3">
            {[
              [LockKeyhole, '隐私可控', '本地优先 · 云端可选'],
              [Languages, '日英翻中', '自然字幕表达'],
              [Captions, '三种格式', 'SRT · VTT · ASS']
            ].map(([Icon, title, subtitle]) => {
              const IconComponent = Icon as typeof LockKeyhole
              return <div key={String(title)} className="panel flex items-center gap-3 p-4"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-elevated text-primary"><IconComponent size={19} /></span><div><strong className="block text-sm">{String(title)}</strong><span className="text-xs text-muted">{String(subtitle)}</span></div></div>
            })}
          </div>
        </div>

        <aside className="space-y-5">
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h3 className="font-bold">AI 引擎</h3><p className="mt-0.5 text-xs text-muted">{defaultProfile?.kind === 'openai-compatible' ? `默认翻译：${defaultProfile.name}` : '本地识别与翻译'}</p></div><span className={`badge ${ready ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>{ready ? '已就绪' : `${readyCount}/${requiredModels.length}`}</span></div>
            <div className="space-y-3 p-5">
              {requiredModels.map((model) => <div key={model.id} className="flex items-center justify-between"><div className="flex items-center gap-2.5">{model.status === 'ready' ? <CheckCircle2 size={17} className="text-success" /> : <span className="h-4 w-4 rounded-full border-2 border-line" />}<span className="text-sm text-ink">{model.name}</span></div><span className="text-xs text-muted">{model.status === 'ready' ? '就绪' : '待下载'}</span></div>)}
              {defaultProfile?.kind === 'openai-compatible' && <div className="flex items-center justify-between"><div className="flex items-center gap-2.5"><CheckCircle2 size={17} className="text-success" /><span className="text-sm text-ink">{defaultProfile.name}</span></div><span className="text-xs text-muted">已配置</span></div>}
              <button className={`btn mt-2 w-full ${ready ? '' : 'btn-primary'}`} onClick={onModels}>{ready ? '管理 AI 引擎' : '配置所需引擎'}<ChevronRight size={16} /></button>
            </div>
          </section>

          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-4"><h3 className="font-bold">最近项目</h3>{recent.length > 0 && <span className="text-xs text-muted">{recent.length} 个</span>}</div>
            <div className="p-2">
              {recent.length ? recent.slice(0, 5).map((item) => (
                <button key={item.filePath} className="group flex min-h-16 w-full items-center rounded-lg px-3 text-left hover:bg-elevated" onClick={() => void onOpenRecent(item.filePath)}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted group-hover:text-primary"><Captions size={17} /></span>
                  <span className="ml-3 min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{item.title}</strong><span className="block truncate text-xs text-muted">{item.mediaName}</span></span>
                  <ChevronRight size={16} className="text-muted" />
                </button>
              )) : <div className="px-4 py-8 text-center"><p className="text-sm text-muted">还没有保存过项目</p><p className="mt-1 text-xs text-muted/70">导入媒体，从第一条字幕开始。</p></div>}
            </div>
          </section>
        </aside>
      </section>
    </main>
  )
}
