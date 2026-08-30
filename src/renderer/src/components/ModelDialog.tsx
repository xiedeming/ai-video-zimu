import * as Dialog from '@radix-ui/react-dialog'
import * as Progress from '@radix-ui/react-progress'
import { Check, CheckCircle2, CircleAlert, Cloud, Copy, Download, Eye, EyeOff, FolderInput, HardDrive, KeyRound, Laptop, Pause, Pencil, Plus, Radio, Star, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DEFAULT_TRANSCRIPTION_MODEL_ID, type TranslationProfile, type TranslationProfileInput } from '../../../shared/types'
import { translationProfileInputSchema } from '../../../shared/schemas'
import { useEditorStore } from '../store'

const formatSize = (bytes: number) => {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

const emptyDraft = (): TranslationProfileInput => ({ name: '', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '' })
type FieldErrors = Partial<Record<'name' | 'baseUrl' | 'model' | 'apiKey', string>>
const isLocalEndpoint = (value?: string) => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value ?? '').hostname) } catch { return false }
}

export function ModelDialog({ open, onOpenChange, notify }: { open: boolean; onOpenChange: (open: boolean) => void; notify: (message: string, kind?: 'error' | 'success') => void }) {
  const models = useEditorStore((state) => state.models)
  const profiles = useEditorStore((state) => state.translationProfiles)
  const document = useEditorStore((state) => state.document)
  const setModels = useEditorStore((state) => state.setModels)
  const setProfiles = useEditorStore((state) => state.setTranslationProfiles)
  const setTranslationProfile = useEditorStore((state) => state.setTranslationProfile)
  const [tab, setTab] = useState<'models' | 'translation'>('models')
  const [busy, setBusy] = useState<string>()
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<TranslationProfileInput>(emptyDraft)
  const [showKey, setShowKey] = useState(false)
  const [testMessage, setTestMessage] = useState<string>()
  const [testSucceeded, setTestSucceeded] = useState<boolean>()
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const activeProfileId = document?.project.settings.translationProfileId
  const activeTranscriptionModelId = document?.project.settings.transcriptionModelId ?? DEFAULT_TRANSCRIPTION_MODEL_ID
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles.find((profile) => profile.isDefault)
  const requiredIds = useMemo(() => new Set([
    activeTranscriptionModelId, 'silero-vad-v6.2', ...(activeProfile?.kind === 'builtin' ? ['qwen3-8b-q4-k-m'] : [])
  ]), [activeProfile?.kind, activeTranscriptionModelId])
  const requiredModels = models.filter((model) => requiredIds.has(model.id))
  const readyCount = requiredModels.filter((model) => model.status === 'ready').length
  const totalSize = useMemo(() => requiredModels.reduce((sum, model) => sum + model.size, 0), [requiredModels])

  const refreshModels = async () => setModels(await window.zimu.models.list())
  const refreshProfiles = async () => setProfiles(await window.zimu.translationProfiles.list())
  const runModel = async (id: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(id)
    try { await action(); await refreshModels(); if (success) notify(success, 'success') }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(undefined) }
  }

  const downloadAll = async () => {
    for (const model of requiredModels.filter((item) => item.status !== 'ready')) await runModel(model.id, () => window.zimu.models.download(model.id))
  }

  const edit = (profile?: TranslationProfile, copy = false) => {
    setTestMessage(undefined); setTestSucceeded(undefined); setShowKey(false); setFieldErrors({})
    if (!profile || profile.kind === 'builtin') { setEditingId(undefined); setDraft(emptyDraft()); return }
    setEditingId(copy ? undefined : profile.id)
    setDraft({ name: copy ? `${profile.name} 副本` : profile.name, kind: 'openai-compatible', baseUrl: profile.baseUrl ?? '', model: profile.model, apiKey: '' })
  }

  const saveProfile = async () => {
    const validation = translationProfileInputSchema.safeParse(draft)
    if (!validation.success) {
      const next: FieldErrors = {}
      validation.error.issues.forEach((issue) => { const field = issue.path[0] as keyof FieldErrors; if (field && !next[field]) next[field] = issue.message })
      setFieldErrors(next); return
    }
    setBusy('profile-save')
    try {
      const saved = editingId
        ? await window.zimu.translationProfiles.update(editingId, draft)
        : await window.zimu.translationProfiles.create(draft)
      if (document) setTranslationProfile(saved.id)
      await refreshProfiles(); edit(); notify(document ? '翻译配置已保存并用于当前项目' : '翻译配置已保存', 'success')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(undefined) }
  }

  const testProfile = async () => {
    const validation = translationProfileInputSchema.safeParse(draft)
    if (!validation.success) {
      const next: FieldErrors = {}
      validation.error.issues.forEach((issue) => { const field = issue.path[0] as keyof FieldErrors; if (field && !next[field]) next[field] = issue.message })
      setFieldErrors(next); return
    }
    setBusy('profile-test'); setTestMessage('正在发送一条极小测试请求…'); setTestSucceeded(undefined)
    try {
      const result = await window.zimu.translationProfiles.test(editingId ?? 'draft', draft)
      setTestSucceeded(result.ok)
      setTestMessage(result.ok ? `${result.message} · ${result.model} · ${result.latencyMs} ms` : result.message)
    } catch (error) { setTestSucceeded(false); setTestMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(undefined) }
  }

  const removeProfile = async (profile: TranslationProfile) => {
    if (!confirm(`确定删除“${profile.name}”吗？已保存的 API Key 也会删除。`)) return
    setBusy(profile.id)
    try { await window.zimu.translationProfiles.remove(profile.id, activeProfileId); await refreshProfiles(); notify('翻译配置已删除', 'success') }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(undefined) }
  }

  const testSavedProfile = async (profile: TranslationProfile) => {
    setBusy(profile.id)
    try {
      const result = await window.zimu.translationProfiles.test(profile.id)
      notify(`${profile.name}：${result.message}${result.ok && result.latencyMs ? ` · ${result.latencyMs} ms` : ''}`, result.ok ? 'success' : 'error')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(undefined) }
  }

  const makeDefault = async (profile: TranslationProfile) => {
    setBusy(profile.id)
    try { setProfiles(await window.zimu.translationProfiles.setDefault(profile.id)); notify(`已将 ${profile.name} 设为默认`, 'success') }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(undefined) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[940px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-panel">
          <header className="flex items-start justify-between border-b border-line px-6 py-5">
            <div><Dialog.Title className="text-xl font-bold text-ink">AI 引擎</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">管理语音识别模型和本地、云端翻译服务。</Dialog.Description></div>
            <Dialog.Close className="icon-btn" aria-label="关闭 AI 引擎窗口"><X size={19} /></Dialog.Close>
          </header>
          <div className="flex border-b border-line px-6" role="tablist" aria-label="AI 引擎设置">
            <button role="tab" aria-selected={tab === 'models'} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${tab === 'models' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'}`} onClick={() => setTab('models')}><HardDrive className="mr-2 inline" size={16} />语音识别模型</button>
            <button role="tab" aria-selected={tab === 'translation'} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${tab === 'translation' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'}`} onClick={() => setTab('translation')}><Radio className="mr-2 inline" size={16} />翻译服务</button>
          </div>

          {tab === 'models' ? <>
            <div className="flex items-center justify-between border-b border-line bg-canvas/40 px-6 py-4">
              <div className="flex gap-7 text-sm"><span><strong className="text-ink">{readyCount}/{requiredModels.length}</strong><span className="ml-1.5 text-muted">当前配置所需</span></span><span><strong className="text-ink">{formatSize(totalSize)}</strong><span className="ml-1.5 text-muted">所需下载量</span></span></div>
              <button className="btn btn-primary" onClick={() => void downloadAll()} disabled={readyCount === requiredModels.length || Boolean(busy)}><Download size={17} />下载当前所需模型</button>
            </div>
            <div className="max-h-[58vh] space-y-3 overflow-y-auto p-6">
              {models.map((model) => {
                const progress = model.size > 0 ? Math.min(100, model.downloadedBytes / model.size * 100) : 0
                const isDownloading = model.status === 'downloading'
                const required = requiredIds.has(model.id)
                return <section key={model.id} className="rounded-xl border border-line bg-canvas/35 p-4" aria-label={model.name}>
                  <div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2">{model.status === 'ready' ? <CheckCircle2 size={18} className="text-success" /> : model.status === 'invalid' || model.status === 'error' ? <CircleAlert size={18} className="text-danger" /> : <HardDrive size={18} className="text-muted" />}<h3 className="font-semibold text-ink">{model.name}</h3><span className="badge">{required ? '当前需要' : '可选'}</span><span className="badge">{model.license}</span></div><p className="mt-1.5 text-sm text-muted">{model.description}</p></div><span className="shrink-0 font-mono text-xs text-muted">{formatSize(model.size)}</span></div>
                  {(isDownloading || model.status === 'error') && <div className="mt-3"><Progress.Root value={progress} className="h-1.5 overflow-hidden rounded-full bg-line" aria-label={`${model.name} 下载进度`}><Progress.Indicator className="h-full bg-primary transition-transform" style={{ transform: `translateX(-${100 - progress}%)` }} /></Progress.Root><p className={`mt-2 text-xs ${model.status === 'error' ? 'text-danger' : 'text-muted'}`}>{model.error ?? `${formatSize(model.downloadedBytes)} / ${formatSize(model.size)}`}</p></div>}
                  <div className="mt-4 flex items-center gap-2">{isDownloading ? <button className="btn" onClick={() => void window.zimu.models.cancel(model.id)}><Pause size={16} />暂停</button> : model.status !== 'ready' ? <button className="btn btn-primary" onClick={() => void runModel(model.id, () => window.zimu.models.download(model.id), `${model.name} 已就绪`)} disabled={Boolean(busy)}><Download size={16} />{model.downloadedBytes ? '继续下载' : '下载'}</button> : null}<button className="btn" onClick={() => void runModel(model.id, () => window.zimu.models.import(model.id), '模型导入完成')} disabled={Boolean(busy)}><FolderInput size={16} />手动导入</button>{model.status === 'ready' && <button className="btn btn-danger ml-auto" onClick={() => { if (confirm(`确定删除 ${model.name}？`)) void runModel(model.id, () => window.zimu.models.remove(model.id), '模型已删除') }} disabled={Boolean(busy)}><Trash2 size={16} />删除</button>}</div>
                </section>
              })}
            </div>
          </> : <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr]">
            <aside className="min-h-0 overflow-y-auto border-r border-line p-4">
              <button className="btn btn-primary mb-4 w-full" onClick={() => edit()}><Plus size={16} />新增 OpenAI 兼容配置</button>
              <div className="space-y-2">{profiles.map((profile) => <section key={profile.id} className={`rounded-xl border p-3 ${profile.id === editingId ? 'border-primary bg-primary/5' : 'border-line bg-canvas/40'}`}>
                <div className="flex items-start gap-3"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${profile.kind === 'builtin' || isLocalEndpoint(profile.baseUrl) ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary'}`}>{profile.kind === 'builtin' || isLocalEndpoint(profile.baseUrl) ? <Laptop size={17} /> : <Cloud size={17} />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><strong className="truncate text-sm">{profile.name}</strong>{profile.isDefault && <Star size={13} className="fill-warning text-warning" aria-label="默认配置" />}{profile.id === activeProfileId && <span className="badge border-primary/30 text-primary">当前项目</span>}</div><p className="mt-0.5 truncate text-xs text-muted">{profile.model}</p></div></div>
                <div className="mt-3 flex flex-wrap gap-1.5"><button className="btn h-8 px-2 text-xs" onClick={() => void testSavedProfile(profile)} disabled={Boolean(busy)}><Radio size={13} />测试</button>{document && profile.id !== activeProfileId && <button className="btn h-8 px-2 text-xs" onClick={() => { setTranslationProfile(profile.id); notify(`当前项目已切换到 ${profile.name}`, 'success') }} disabled={Boolean(busy)}><Check size={13} />用于项目</button>}{!profile.isDefault && <button className="btn h-8 px-2 text-xs" onClick={() => void makeDefault(profile)} disabled={Boolean(busy)}><Star size={13} />默认</button>}{profile.kind !== 'builtin' && <><button className="icon-btn h-8 w-8" aria-label={`编辑 ${profile.name}`} onClick={() => edit(profile)}><Pencil size={14} /></button><button className="icon-btn h-8 w-8" aria-label={`复制 ${profile.name}`} onClick={() => edit(profile, true)}><Copy size={14} /></button><button className="icon-btn h-8 w-8 text-danger" aria-label={`删除 ${profile.name}`} onClick={() => void removeProfile(profile)}><Trash2 size={14} /></button></>}</div>
              </section>)}</div>
            </aside>
            <section className="min-h-0 overflow-y-auto p-6">
              <div className="mb-5"><h3 className="text-lg font-bold">{editingId ? '编辑翻译配置' : '新增翻译配置'}</h3><p className="mt-1 text-sm text-muted">兼容 OpenAI Chat Completions 的本地或云端服务。</p></div>
              <div className="space-y-4">
                <label className="block"><span className="label">配置名称</span><input aria-invalid={Boolean(fieldErrors.name)} className="input mt-1.5 w-full" value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setFieldErrors({ ...fieldErrors, name: undefined }) }} placeholder="例如：本机 Ollama / DeepSeek" />{fieldErrors.name && <span role="alert" className="mt-1 block text-xs text-danger">{fieldErrors.name}</span>}</label>
                <label className="block"><span className="label">Base URL</span><input aria-invalid={Boolean(fieldErrors.baseUrl)} className="input mt-1.5 w-full font-mono text-sm" value={draft.baseUrl} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }); setFieldErrors({ ...fieldErrors, baseUrl: undefined }) }} placeholder="http://192.168.1.20:8000/v1" />{fieldErrors.baseUrl ? <span role="alert" className="mt-1 block text-xs text-danger">{fieldErrors.baseUrl}</span> : <span className="mt-1.5 block text-xs text-muted">支持本机、局域网和远程 HTTP/HTTPS 地址；应用会追加 /chat/completions。</span>}</label>
                <label className="block"><span className="label">模型名称</span><input aria-invalid={Boolean(fieldErrors.model)} className="input mt-1.5 w-full font-mono text-sm" value={draft.model} onChange={(event) => { setDraft({ ...draft, model: event.target.value }); setFieldErrors({ ...fieldErrors, model: undefined }) }} placeholder="例如 qwen3:8b、deepseek-chat" />{fieldErrors.model && <span role="alert" className="mt-1 block text-xs text-danger">{fieldErrors.model}</span>}</label>
                <label className="block"><span className="label">API Key</span><span className="relative mt-1.5 block"><KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input type={showKey ? 'text' : 'password'} className="input w-full pl-9 pr-11 font-mono text-sm" value={draft.apiKey ?? ''} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, clearApiKey: false })} placeholder={editingId ? '留空则保留已保存的密钥' : '本机无鉴权服务可以留空'} autoComplete="new-password" /><button type="button" className="icon-btn absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label>
                {editingId && profiles.find((profile) => profile.id === editingId)?.hasApiKey && <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line bg-canvas px-3 text-sm"><input type="checkbox" checked={Boolean(draft.clearApiKey)} onChange={(event) => setDraft({ ...draft, clearApiKey: event.target.checked, apiKey: '' })} className="accent-[rgb(var(--primary))]" />清除已保存的 API Key</label>}
                <div className={`rounded-lg border px-4 py-3 text-sm ${isLocalEndpoint(draft.baseUrl) ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>{isLocalEndpoint(draft.baseUrl) ? '本机服务：字幕原文不会离开这台电脑。' : '云端服务：翻译时字幕原文将发送到所选 API。'}</div>
                {testMessage && <div role={testSucceeded === false ? 'alert' : 'status'} aria-live="polite" className={`rounded-lg border px-4 py-3 text-sm ${testSucceeded === false ? 'border-danger/40 bg-danger/10 text-danger' : testSucceeded ? 'border-success/40 bg-success/10 text-success' : 'border-line bg-canvas text-ink'}`}>{testMessage}</div>}
                <div className="flex gap-2 border-t border-line pt-4"><button className="btn" onClick={() => void testProfile()} disabled={Boolean(busy) || !draft.baseUrl || !draft.model}><Radio size={16} />{busy === 'profile-test' ? '测试中…' : '测试连接'}</button><button className="btn btn-primary ml-auto" onClick={() => void saveProfile()} disabled={Boolean(busy) || !draft.name || !draft.baseUrl || !draft.model}><Check size={16} />保存配置</button></div>
              </div>
            </section>
          </div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
