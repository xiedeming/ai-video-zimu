export type SourceLanguage = 'auto' | 'ja' | 'en'
export type ResolvedLanguage = 'ja' | 'en'
export type TranscriptionModelId = 'whisper-large-v3-turbo' | 'whisper-large-v3'
export type ExportFormat = 'srt' | 'vtt' | 'ass'
export type ExportContent = 'bilingual' | 'translation' | 'source'
export type SegmentStatus = 'generated' | 'edited' | 'reviewed' | 'warning'

export interface WordTiming {
  text: string
  startMs: number
  endMs: number
  probability?: number
}

export interface SubtitleSegment {
  id: string
  startMs: number
  endMs: number
  sourceText: string
  translatedText: string
  words: WordTiming[]
  confidence: number
  status: SegmentStatus
}

export interface MediaReference {
  path: string
  name: string
  size: number
  durationMs: number
  kind: 'video' | 'audio'
  audioCodec?: string
  videoCodec?: string
  width?: number
  height?: number
  fingerprint?: string
}

export const BUILTIN_TRANSLATION_PROFILE_ID = 'builtin-qwen3'
export const DEFAULT_TRANSCRIPTION_MODEL_ID: TranscriptionModelId = 'whisper-large-v3-turbo'

export interface TranslationProfile {
  id: string
  name: string
  kind: 'builtin' | 'openai-compatible'
  baseUrl?: string
  model: string
  hasApiKey: boolean
  isDefault: boolean
}

export interface TranslationProfileInput {
  name: string
  kind: 'openai-compatible'
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface TranslationProfileTestResult {
  ok: boolean
  latencyMs: number
  model: string
  message: string
  errorCode?: string
}

export interface LegacyZimuProjectV1 {
  schemaVersion: 1
  id: string
  title: string
  media: MediaReference
  sourceLanguage: SourceLanguage
  detectedLanguage?: ResolvedLanguage
  targetLanguage: 'zh-CN'
  modelVersions: { whisper: string; translator: string; vad: string }
  settings: { translationStyle: 'natural'; minSegmentMs: number; maxSegmentMs: number }
  segments: SubtitleSegment[]
  createdAt: string
  updatedAt: string
}

export interface ZimuProjectV2 {
  schemaVersion: 2
  id: string
  title: string
  media: MediaReference
  sourceLanguage: SourceLanguage
  detectedLanguage?: ResolvedLanguage
  targetLanguage: 'zh-CN'
  modelVersions: {
    whisper: string
    translator: string
    vad: string
  }
  settings: {
    translationStyle: 'natural'
    minSegmentMs: number
    maxSegmentMs: number
    transcriptionModelId: TranscriptionModelId
    translationProfileId: string
  }
  segments: SubtitleSegment[]
  createdAt: string
  updatedAt: string
}

/** @deprecated Internal compatibility alias. New project files use schema version 2. */
export type ZimuProjectV1 = ZimuProjectV2

export interface ProjectDocument {
  project: ZimuProjectV1
  filePath?: string
  mediaUrl?: string
}

export type JobStage =
  | 'queued'
  | 'probing'
  | 'preparing'
  | 'transcribing'
  | 'translating'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface JobEvent {
  jobId: string
  projectId: string
  stage: JobStage
  progress: number
  message: string
  elapsedMs: number
  errorCode?: string
  project?: ZimuProjectV1
  remainingSegmentIds?: string[]
}

export interface ModelManifestItem {
  id: TranscriptionModelId | 'qwen3-8b-q4-k-m' | 'silero-vad-v6.2'
  name: string
  description: string
  fileName: string
  url: string
  size: number
  license: string
  version: string
  expectedSha256?: string
  required: boolean
}

export interface ModelState extends ModelManifestItem {
  status: 'missing' | 'downloading' | 'ready' | 'invalid' | 'error'
  downloadedBytes: number
  sha256?: string
  error?: string
}

export interface ModelProgressEvent {
  id: ModelManifestItem['id']
  status: ModelState['status']
  downloadedBytes: number
  totalBytes: number
  message: string
}

export interface ExportRequest {
  project: ZimuProjectV1
  format: ExportFormat
  content: ExportContent
  filePath?: string
}

export interface ExportResult {
  canceled: boolean
  filePath?: string
}

export interface RecentProject {
  filePath: string
  title: string
  mediaName: string
  updatedAt: string
}

export interface ZimuApi {
  queue: {
    choose: () => Promise<string[]>
    validate: (request: import('./queue').BatchRequest) => Promise<import('./queue').BatchValidationRow[]>
    submit: (request: import('./queue').BatchRequest) => Promise<import('./queue').QueueSnapshot>
    snapshot: () => Promise<import('./queue').QueueSnapshot>
    control: (request: import('./queue').QueueControl) => Promise<import('./queue').QueueSnapshot>
    onUpdate: (handler: (snapshot: import('./queue').QueueSnapshot) => void) => () => void
  }
  app: {
    getInfo: () => Promise<{
      version: string
      platform: string
      paths: { models: string; cache: string; logs: string; translationApiLog: string }
    }>
  }
  project: {
    create: (mediaPath?: string) => Promise<ProjectDocument | null>
    open: () => Promise<ProjectDocument | null>
    save: (project: ZimuProjectV1, filePath?: string) => Promise<ProjectDocument | null>
    autosave: (project: ZimuProjectV1) => Promise<string>
    recent: () => Promise<RecentProject[]>
    openRecent: (filePath: string) => Promise<ProjectDocument>
    relinkMedia: (project: ZimuProjectV1) => Promise<ProjectDocument | null>
  }
  media: {
    choose: () => Promise<string | null>
    inspect: (filePath: string) => Promise<MediaReference>
    toUrl: (filePath: string) => Promise<string>
    waveform: (filePath: string, points?: number) => Promise<number[]>
    createProxy: (filePath: string, projectId: string, kind: 'video' | 'audio') => Promise<{ filePath: string; url: string }>
    pathForFile: (file: File) => string
  }
  models: {
    list: () => Promise<ModelState[]>
    download: (id: ModelManifestItem['id']) => Promise<void>
    cancel: (id: ModelManifestItem['id']) => Promise<void>
    remove: (id: ModelManifestItem['id']) => Promise<void>
    import: (id: ModelManifestItem['id']) => Promise<ModelState | null>
    onProgress: (handler: (event: ModelProgressEvent) => void) => () => void
  }
  translationProfiles: {
    list: () => Promise<TranslationProfile[]>
    create: (input: TranslationProfileInput) => Promise<TranslationProfile>
    update: (id: string, input: TranslationProfileInput) => Promise<TranslationProfile>
    remove: (id: string, activeProfileId?: string) => Promise<void>
    setDefault: (id: string) => Promise<TranslationProfile[]>
    test: (id: string, input?: TranslationProfileInput) => Promise<TranslationProfileTestResult>
  }
  jobs: {
      start: (project: ZimuProjectV1, filePath?: string) => Promise<{ jobId: string }>
      cancel: (jobId: string) => Promise<void>
      retranslate: (project: ZimuProjectV1, segmentIds?: string[], filePath?: string) => Promise<{ jobId: string }>
      continueTranslation: (project: ZimuProjectV1, filePath?: string) => Promise<{ jobId: string }>
      onEvent: (handler: (event: JobEvent) => void) => () => void
  }
  subtitles: {
    export: (request: ExportRequest) => Promise<ExportResult>
  }
}

declare global {
  interface Window {
    zimu: ZimuApi
  }
}
