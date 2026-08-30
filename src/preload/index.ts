import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ExportRequest, JobEvent, ModelManifestItem, ModelProgressEvent, TranslationProfileInput, ZimuApi, ZimuProjectV1 } from '../shared/types'

const api: ZimuApi = {
  app: {
    getInfo: () => ipcRenderer.invoke('app:info')
  },
  project: {
    create: (mediaPath) => ipcRenderer.invoke('project:create', mediaPath),
    open: () => ipcRenderer.invoke('project:open'),
    save: (project, filePath) => ipcRenderer.invoke('project:save', project, filePath),
    autosave: (project) => ipcRenderer.invoke('project:autosave', project),
    recent: () => ipcRenderer.invoke('project:recent'),
    openRecent: (filePath) => ipcRenderer.invoke('project:open-recent', filePath),
    relinkMedia: (project) => ipcRenderer.invoke('project:relink', project)
  },
  media: {
    choose: () => ipcRenderer.invoke('media:choose'),
    inspect: (filePath) => ipcRenderer.invoke('media:inspect', filePath),
    toUrl: (filePath) => ipcRenderer.invoke('media:url', filePath),
    waveform: (filePath, points) => ipcRenderer.invoke('media:waveform', filePath, points),
    createProxy: (filePath, projectId, kind) => ipcRenderer.invoke('media:proxy', filePath, projectId, kind),
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    download: (id: ModelManifestItem['id']) => ipcRenderer.invoke('models:download', id),
    cancel: (id: ModelManifestItem['id']) => ipcRenderer.invoke('models:cancel', id),
    remove: (id: ModelManifestItem['id']) => ipcRenderer.invoke('models:remove', id),
    import: (id: ModelManifestItem['id']) => ipcRenderer.invoke('models:import', id),
    onProgress: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ModelProgressEvent) => handler(progress)
      ipcRenderer.on('models:progress', listener)
      return () => ipcRenderer.removeListener('models:progress', listener)
    }
  },
  translationProfiles: {
    list: () => ipcRenderer.invoke('translation-profiles:list'),
    create: (input: TranslationProfileInput) => ipcRenderer.invoke('translation-profiles:create', input),
    update: (id: string, input: TranslationProfileInput) => ipcRenderer.invoke('translation-profiles:update', id, input),
    remove: (id: string, activeProfileId?: string) => ipcRenderer.invoke('translation-profiles:remove', id, activeProfileId),
    setDefault: (id: string) => ipcRenderer.invoke('translation-profiles:set-default', id),
    test: (id: string, input?: TranslationProfileInput) => ipcRenderer.invoke('translation-profiles:test', id, input)
  },
  jobs: {
    start: (project: ZimuProjectV1) => ipcRenderer.invoke('jobs:start', project),
    cancel: (jobId: string) => ipcRenderer.invoke('jobs:cancel', jobId),
    retranslate: (project: ZimuProjectV1, segmentIds?: string[]) => ipcRenderer.invoke('jobs:retranslate', project, segmentIds),
    continueTranslation: (project: ZimuProjectV1) => ipcRenderer.invoke('jobs:continue-translation', project),
    onEvent: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, jobEvent: JobEvent) => handler(jobEvent)
      ipcRenderer.on('jobs:event', listener)
      return () => ipcRenderer.removeListener('jobs:event', listener)
    }
  },
  subtitles: {
    export: (request: ExportRequest) => ipcRenderer.invoke('subtitles:export', request)
  }
}

contextBridge.exposeInMainWorld('zimu', api)
