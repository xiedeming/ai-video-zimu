import { dialog } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './atomic-file'
import { getAppPaths, MEDIA_FILTERS, MODEL_MANIFEST } from './constants'
import { inspectMedia } from './sidecars'
import { projectSchema } from '../shared/schemas'
import { migrateProject } from '../shared/project'
import { BUILTIN_TRANSLATION_PROFILE_ID, DEFAULT_TRANSCRIPTION_MODEL_ID, type ModelManifestItem, type ProjectDocument, type RecentProject, type ZimuProjectV1 } from '../shared/types'

function titleFromPath(filePath: string): string {
  return basename(filePath, extname(filePath)) || '未命名项目'
}

function mediaUrl(filePath: string): string {
  return `zimu-media://local/${Buffer.from(filePath, 'utf8').toString('base64url')}`
}

function modelVersion(id: ModelManifestItem['id']): string {
  const model = MODEL_MANIFEST.find((item) => item.id === id)
  if (!model) throw new Error(`模型清单缺少 ${id}`)
  return model.version
}

async function readRecent(): Promise<RecentProject[]> {
  try {
    const raw = await readFile(getAppPaths().recent, 'utf8')
    return JSON.parse(raw) as RecentProject[]
  } catch {
    return []
  }
}

async function remember(filePath: string, project: ZimuProjectV1): Promise<void> {
  const paths = getAppPaths()
  await mkdir(dirname(paths.recent), { recursive: true })
  const current = await readRecent()
  const next: RecentProject[] = [
    { filePath, title: project.title, mediaName: project.media.name, updatedAt: project.updatedAt },
    ...current.filter((item) => item.filePath !== filePath)
  ].slice(0, 8)
  await writeFile(paths.recent, JSON.stringify(next, null, 2), 'utf8')
}

export async function createProject(initialMediaPath?: string, translationProfileId = BUILTIN_TRANSLATION_PROFILE_ID): Promise<ProjectDocument | null> {
  let filePath = initialMediaPath
  if (!filePath) {
    const choice = await dialog.showOpenDialog({ properties: ['openFile'], filters: MEDIA_FILTERS, title: '选择视频或音频' })
    if (choice.canceled || !choice.filePaths[0]) return null
    filePath = choice.filePaths[0]
  }
  const media = await inspectMedia(filePath)
  const now = new Date().toISOString()
  const project: ZimuProjectV1 = {
    schemaVersion: 2,
    id: randomUUID(),
    title: titleFromPath(filePath),
    media,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    modelVersions: {
      whisper: modelVersion(DEFAULT_TRANSCRIPTION_MODEL_ID),
      translator: modelVersion('qwen3-8b-q4-k-m'),
      vad: modelVersion('silero-vad-v6.2')
    },
    settings: {
      translationStyle: 'natural',
      minSegmentMs: 1000,
      maxSegmentMs: 8000,
      transcriptionModelId: DEFAULT_TRANSCRIPTION_MODEL_ID,
      translationProfileId
    },
    segments: [],
    createdAt: now,
    updatedAt: now
  }
  return { project, mediaUrl: mediaUrl(filePath) }
}

export async function saveProject(projectInput: ZimuProjectV1, existingPath?: string): Promise<ProjectDocument | null> {
  const project = projectSchema.parse({ ...projectInput, updatedAt: new Date().toISOString() })
  let filePath = existingPath
  if (!filePath) {
    const result = await dialog.showSaveDialog({
      title: '保存字幕项目', defaultPath: `${project.title}.zimu`,
      filters: [{ name: '字幕工坊项目', extensions: ['zimu'] }]
    })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath
  }
  await mkdir(dirname(filePath), { recursive: true })
  await atomicWrite(filePath, JSON.stringify(project, null, 2))
  await remember(filePath, project)
  return { project, filePath, mediaUrl: mediaUrl(project.media.path) }
}

export async function autosaveProject(projectInput: ZimuProjectV1): Promise<string> {
  const paths = getAppPaths()
  await mkdir(paths.autosave, { recursive: true })
  const project = projectSchema.parse({ ...projectInput, updatedAt: new Date().toISOString() })
  const filePath = join(paths.autosave, `${project.id}.zimu`)
  await atomicWrite(filePath, JSON.stringify(project, null, 2))
  return filePath
}

export async function openProject(filePath?: string): Promise<ProjectDocument | null> {
  let selected = filePath
  if (!selected) {
    const result = await dialog.showOpenDialog({ title: '打开字幕项目', properties: ['openFile'], filters: [{ name: '字幕工坊项目', extensions: ['zimu'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    selected = result.filePaths[0]
  }
  const raw = await readFile(selected, 'utf8')
  const project = migrateProject(JSON.parse(raw))
  await remember(selected, project)
  const mediaExists = await stat(project.media.path).then(() => true).catch(() => false)
  return { project, filePath: selected, mediaUrl: mediaExists ? mediaUrl(project.media.path) : undefined }
}

export async function relinkMedia(projectInput: ZimuProjectV1): Promise<ProjectDocument | null> {
  const choice = await dialog.showOpenDialog({ properties: ['openFile'], filters: MEDIA_FILTERS, title: '重新关联原始媒体' })
  if (choice.canceled || !choice.filePaths[0]) return null
  const media = await inspectMedia(choice.filePaths[0])
  const project = projectSchema.parse({ ...projectInput, media, updatedAt: new Date().toISOString() })
  return { project, mediaUrl: mediaUrl(media.path) }
}

export const getRecentProjects = readRecent
export const toMediaUrl = mediaUrl
export const toFileUrl = pathToFileURL
