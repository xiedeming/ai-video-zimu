import { create } from 'zustand'
import type {
  JobEvent, ModelState, ProjectDocument, RecentProject, SourceLanguage, SubtitleSegment, TranscriptionModelId, TranslationProfile, ZimuProjectV1
} from '../../shared/types'
import { mergeAdjacentDuplicateSegments, repairSegmentOverlaps, type MergeAdjacentDuplicateResult } from '../../shared/subtitles'

interface EditorState {
  document: ProjectDocument | null
  models: ModelState[]
  translationProfiles: TranslationProfile[]
  recent: RecentProject[]
  selectedId?: string
  playheadMs: number
  activeJobId?: string
  jobEvent?: JobEvent
  dirty: boolean
  history: SubtitleSegment[][]
  future: SubtitleSegment[][]
  search: string
  lowConfidenceOnly: boolean
  setDocument: (document: ProjectDocument | null) => void
  setModels: (models: ModelState[]) => void
  setTranslationProfiles: (profiles: TranslationProfile[]) => void
  setRecent: (recent: RecentProject[]) => void
  setSelected: (id?: string) => void
  setPlayhead: (ms: number) => void
  setSearch: (search: string) => void
  toggleLowConfidence: () => void
  setLanguage: (language: SourceLanguage) => void
  setTranscriptionModel: (id: TranscriptionModelId) => void
  setTranslationProfile: (id: string) => void
  setActiveJob: (jobId?: string) => void
  applyJobEvent: (event: JobEvent) => void
  updateSegment: (id: string, patch: Partial<SubtitleSegment>) => void
  addSegment: () => void
  deleteSegment: (id: string) => void
  splitSegment: (id?: string, atMs?: number) => void
  mergeNext: (id: string) => void
  mergeDuplicateSegments: () => MergeAdjacentDuplicateResult
  repairOverlaps: (segmentIds?: string[]) => void
  undo: () => void
  redo: () => void
  markSaved: (filePath?: string) => void
}

const copySegments = (segments: SubtitleSegment[]) => segments.map((segment) => ({ ...segment, words: [...segment.words] }))

function projectWithSegments(project: ZimuProjectV1, segments: SubtitleSegment[]): ZimuProjectV1 {
  return { ...project, segments, updatedAt: new Date().toISOString() }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  document: null,
  models: [],
  translationProfiles: [],
  recent: [],
  playheadMs: 0,
  dirty: false,
  history: [],
  future: [],
  search: '',
  lowConfidenceOnly: false,
  setDocument: (document) => set({ document, selectedId: document?.project.segments[0]?.id, dirty: false, history: [], future: [], jobEvent: undefined, activeJobId: undefined }),
  setModels: (models) => set({ models }),
  setTranslationProfiles: (translationProfiles) => set({ translationProfiles }),
  setRecent: (recent) => set({ recent }),
  setSelected: (selectedId) => set({ selectedId }),
  setPlayhead: (playheadMs) => set({ playheadMs }),
  setSearch: (search) => set({ search }),
  toggleLowConfidence: () => set((state) => ({ lowConfidenceOnly: !state.lowConfidenceOnly })),
  setLanguage: (sourceLanguage) => set((state) => state.document ? ({
    document: { ...state.document, project: { ...state.document.project, sourceLanguage, updatedAt: new Date().toISOString() } },
    dirty: true
  }) : state),
  setTranscriptionModel: (transcriptionModelId) => set((state) => state.document ? ({
    document: {
      ...state.document,
      project: {
        ...state.document.project,
        settings: { ...state.document.project.settings, transcriptionModelId },
        updatedAt: new Date().toISOString()
      }
    },
    dirty: true
  }) : state),
  setTranslationProfile: (translationProfileId) => set((state) => state.document ? ({
    document: { ...state.document, project: { ...state.document.project, settings: { ...state.document.project.settings, translationProfileId }, updatedAt: new Date().toISOString() } },
    dirty: true
  }) : state),
  setActiveJob: (activeJobId) => set({ activeJobId }),
  applyJobEvent: (event) => set((state) => {
    if (state.activeJobId && event.jobId !== state.activeJobId) return state
    if (event.stage === 'completed' && event.project && state.document) {
      return {
        jobEvent: event,
        activeJobId: undefined,
        document: { ...state.document, project: event.project },
        dirty: true,
        history: [], future: [], selectedId: event.project.segments[0]?.id
      }
    }
    if (event.project && state.document) {
      return {
        jobEvent: event,
        activeJobId: event.stage === 'failed' || event.stage === 'canceled' ? undefined : state.activeJobId,
        document: { ...state.document, project: event.project },
        dirty: true
      }
    }
    if (event.stage === 'failed' || event.stage === 'canceled') return { jobEvent: event, activeJobId: undefined }
    return { jobEvent: event }
  }),
  updateSegment: (id, patch) => set((state) => {
    if (!state.document) return state
    const before = copySegments(state.document.project.segments)
    const segments = state.document.project.segments.map((segment) => segment.id === id
      ? { ...segment, ...patch, status: patch.status ?? 'edited' as const }
      : segment)
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  addSegment: () => set((state) => {
    if (!state.document) return state
    const before = copySegments(state.document.project.segments)
    const sorted = [...state.document.project.segments].sort((a, b) => a.startMs - b.startMs)
    const selectedIndex = sorted.findIndex((segment) => segment.id === state.selectedId)
    const reference = selectedIndex >= 0 ? sorted[selectedIndex] : sorted.at(-1)
    const startMs = reference?.endMs ?? state.playheadMs
    const segment: SubtitleSegment = {
      id: crypto.randomUUID(), startMs, endMs: startMs + 2000,
      sourceText: '', translatedText: '', words: [], confidence: 1, status: 'edited'
    }
    const segments = [...sorted, segment].sort((a, b) => a.startMs - b.startMs)
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      selectedId: segment.id, dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  deleteSegment: (id) => set((state) => {
    if (!state.document) return state
    const before = copySegments(state.document.project.segments)
    const index = state.document.project.segments.findIndex((segment) => segment.id === id)
    const segments = state.document.project.segments.filter((segment) => segment.id !== id)
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      selectedId: segments[Math.min(index, Math.max(0, segments.length - 1))]?.id,
      dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  splitSegment: (requestedId, requestedMs) => set((state) => {
    if (!state.document) return state
    const id = requestedId ?? state.selectedId
    const segment = state.document.project.segments.find((item) => item.id === id)
    if (!segment) return state
    const atMs = requestedMs ?? state.playheadMs
    if (atMs <= segment.startMs + 200 || atMs >= segment.endMs - 200) return state
    const before = copySegments(state.document.project.segments)
    const splitText = (text: string) => {
      const middle = Math.floor(text.length / 2)
      const breakAt = Math.max(text.lastIndexOf(' ', middle), text.lastIndexOf('。', middle), text.lastIndexOf('.', middle))
      const point = breakAt > 0 ? breakAt + 1 : middle
      return [text.slice(0, point).trim(), text.slice(point).trim()]
    }
    const [sourceA, sourceB] = splitText(segment.sourceText)
    const [translationA, translationB] = splitText(segment.translatedText)
    const first: SubtitleSegment = { ...segment, endMs: atMs, sourceText: sourceA, translatedText: translationA, words: segment.words.filter((word) => word.startMs < atMs), status: 'edited' }
    const second: SubtitleSegment = { ...segment, id: crypto.randomUUID(), startMs: atMs, sourceText: sourceB, translatedText: translationB, words: segment.words.filter((word) => word.endMs > atMs), status: 'edited' }
    const segments = state.document.project.segments.flatMap((item) => item.id === segment.id ? [first, second] : [item])
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      selectedId: second.id, dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  mergeNext: (id) => set((state) => {
    if (!state.document) return state
    const segments = [...state.document.project.segments].sort((a, b) => a.startMs - b.startMs)
    const index = segments.findIndex((segment) => segment.id === id)
    if (index < 0 || index >= segments.length - 1) return state
    const before = copySegments(state.document.project.segments)
    const current = segments[index]
    const next = segments[index + 1]
    segments.splice(index, 2, {
      ...current,
      endMs: next.endMs,
      sourceText: `${current.sourceText.trim()} ${next.sourceText.trim()}`.trim(),
      translatedText: `${current.translatedText.trim()} ${next.translatedText.trim()}`.trim(),
      words: [...current.words, ...next.words],
      confidence: Math.min(current.confidence, next.confidence),
      status: 'edited'
    })
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  mergeDuplicateSegments: () => {
    const state = get()
    if (!state.document) return { segments: [], mergedCount: 0, skippedConflictCount: 0 }
    const before = copySegments(state.document.project.segments)
    const result = mergeAdjacentDuplicateSegments(state.document.project.segments, { maxGapMs: 1000, protectEdited: true })
    if (!result.mergedCount) return result
    const selectedBefore = before.find((segment) => segment.id === state.selectedId)
    const selectedId = result.segments.some((segment) => segment.id === state.selectedId)
      ? state.selectedId
      : selectedBefore
        ? result.segments.reduce((nearest, segment) => Math.abs(segment.startMs - selectedBefore.startMs) < Math.abs(nearest.startMs - selectedBefore.startMs) ? segment : nearest, result.segments[0]).id
        : result.segments[0]?.id
    set({
      document: { ...state.document, project: projectWithSegments(state.document.project, result.segments) },
      selectedId,
      dirty: true,
      history: [...state.history, before].slice(-60),
      future: []
    })
    return result
  },
  repairOverlaps: (segmentIds) => set((state) => {
    if (!state.document) return state
    const before = copySegments(state.document.project.segments)
    const segments = repairSegmentOverlaps(state.document.project.segments, segmentIds)
    const changed = segments.some((segment, index) => segment.startMs !== before[index].startMs || segment.endMs !== before[index].endMs)
    if (!changed) return state
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, segments) },
      dirty: true, history: [...state.history, before].slice(-60), future: []
    }
  }),
  undo: () => set((state) => {
    if (!state.document || !state.history.length) return state
    const previous = state.history.at(-1)!
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, copySegments(previous)) },
      history: state.history.slice(0, -1), future: [copySegments(state.document.project.segments), ...state.future].slice(0, 60), dirty: true
    }
  }),
  redo: () => set((state) => {
    if (!state.document || !state.future.length) return state
    const next = state.future[0]
    return {
      document: { ...state.document, project: projectWithSegments(state.document.project, copySegments(next)) },
      history: [...state.history, copySegments(state.document.project.segments)].slice(-60), future: state.future.slice(1), dirty: true
    }
  }),
  markSaved: (filePath) => set((state) => state.document ? ({ document: { ...state.document, filePath: filePath ?? state.document.filePath }, dirty: false }) : state)
}))
