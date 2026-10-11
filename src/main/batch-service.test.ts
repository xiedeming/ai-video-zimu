import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchRequest } from '../shared/queue'
import type { ZimuProjectV1 } from '../shared/types'
import type { ModelManager } from './model-manager'
import type { TranslationProfileManager } from './translation-profile-manager'

const mocks = vi.hoisted(() => ({ createProject: vi.fn(), resolveBinary: vi.fn().mockResolvedValue('binary') }))
vi.mock('./project-service', () => ({ createProject: mocks.createProject }))
vi.mock('./sidecars', () => ({ resolveBinary: mocks.resolveBinary }))
import { BatchService, assertWritable, nextProjectPath } from './batch-service'
import { atomicWrite } from './atomic-file'

let directory: string
function project(path: string): ZimuProjectV1 {
  return {
    schemaVersion: 2, id: randomUUID(), title: basename(path),
    media: { path, name: basename(path), size: 1, durationMs: 1000, kind: 'video', audioCodec: 'aac' },
    sourceLanguage: 'auto', targetLanguage: 'zh-CN', modelVersions: { whisper: 'test', translator: 'test', vad: 'test' },
    settings: { translationStyle: 'natural', minSegmentMs: 1000, maxSegmentMs: 8000, transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3' },
    segments: [], createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z'
  }
}
function setup() {
  const models = { assertReady: vi.fn().mockResolvedValue(undefined) } as unknown as ModelManager
  const profiles = { resolve: vi.fn().mockResolvedValue({ profile: { kind: 'builtin' } }) } as unknown as TranslationProfileManager
  const service = new BatchService(models, profiles)
  const request: BatchRequest = { items: [{ mediaPath: join(directory, '视频🎬.mp4') }], options: { sourceLanguage: 'auto', transcriptionModelId: 'whisper-large-v3-turbo', translationProfileId: 'builtin-qwen3', translate: true }, concurrency: 1 }
  return { service, request, models, profiles }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zimu-batch-'))
  await writeFile(join(directory, '视频🎬.mp4'), 'fixture')
  mocks.createProject.mockReset().mockImplementation(async (path: string) => ({ project: project(path) }))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('batch files and atomic project saves', () => {
  it('validates duplicates per row and accepts Unicode paths', async () => {
    const { service, request } = setup()
    request.items.push({ ...request.items[0] })
    const rows = await service.validate(request)
    expect(rows[0].filePath).toBe(join(directory, '视频🎬.zimu'))
    expect(rows[1].error).toContain('重复')
  })
  it('reports missing source and missing models without leaking error contents', async () => {
    const { service, request, models } = setup()
    request.items.push({ mediaPath: join(directory, 'missing.mp4') })
    vi.mocked(models.assertReady).mockRejectedValue(new Error('secret=key private subtitle D:\\secret.mp4'))
    const rows = await service.validate(request)
    expect(rows[0].error).not.toMatch(/secret|private/)
    expect(rows[1].error).toBe('源文件不存在')
  })
  it('rejects a directory and invalid media', async () => {
    const { service, request } = setup()
    request.items.push({ mediaPath: directory })
    mocks.createProject.mockResolvedValue({ project: { ...project(request.items[0].mediaPath), media: { ...project(request.items[0].mediaPath).media, durationMs: 0 } } })
    const rows = await service.validate(request)
    expect(rows.map((row) => row.error)).toEqual(['媒体文件无效或没有音轨', '请选择媒体文件'])
  })
  it('reserves incrementing names without overwriting existing or simultaneous projects', async () => {
    const { service, request } = setup()
    const existing = join(directory, '视频🎬.zimu')
    await writeFile(existing, 'keep original')
    const input = project(request.items[0].mediaPath)
    const files = await Promise.all([service.reserve(input), service.reserve({ ...input, id: randomUUID() })])
    expect(new Set(files).size).toBe(2)
    expect(files.sort()).toEqual([join(directory, '视频🎬 (1).zimu'), join(directory, '视频🎬 (2).zimu')].sort())
    expect(await readFile(existing, 'utf8')).toBe('keep original')
  })
  it('applies each override only to the corresponding new project', async () => {
    const { service, request } = setup()
    const second = join(directory, 'second.mp4')
    await writeFile(second, 'fixture')
    request.items.push({ mediaPath: second, overrides: { sourceLanguage: 'ja', transcriptionModelId: 'whisper-large-v3', translate: false } })
    const prepared = await service.prepare(request)
    expect(prepared[0].project.sourceLanguage).toBe('auto')
    expect(prepared[1].project.sourceLanguage).toBe('ja')
    expect(prepared[1].project.settings.transcriptionModelId).toBe('whisper-large-v3')
    expect(prepared[0].options.translate).toBe(true)
    expect(prepared[1].options.translate).toBe(false)
  })
  it('preflights source loss and protects files replaced by another project', async () => {
    const { service, request } = setup()
    const input = project(request.items[0].mediaPath)
    const path = await service.reserve(input)
    await rm(input.media.path)
    await expect(service.validateTask(input, request.options, path)).rejects.toThrow()
    await writeFile(path, JSON.stringify({ ...input, id: randomUUID() }))
    await expect(service.save(input, path)).rejects.toThrow('已被替换')
  })
  it('keeps project content unchanged when atomic replacement cannot start', async () => {
    const { service, request } = setup()
    const input = project(request.items[0].mediaPath)
    const path = await service.reserve(input)
    const original = await readFile(path, 'utf8')
    await expect(atomicWrite(join(directory, 'missing', 'test.zimu'), 'new')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
    await service.save({ ...input, title: '更新' }, path)
    expect(JSON.parse(await readFile(path, 'utf8')).title).toBe('更新')
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
  it('probes write permission using exclusive temporary files and leaves no probes', async () => {
    await assertWritable(directory)
    expect((await readdir(directory)).some((name) => name.startsWith('.zimu-write-'))).toBe(false)
    // A filesystem object that cannot contain files exercises an actual write rejection on Windows too.
    await expect(assertWritable(join(directory, '视频🎬.mp4'))).rejects.toThrow()
    await expect(nextProjectPath(join(directory, '视频🎬.mp4'))).resolves.toBe(join(directory, '视频🎬.zimu'))
  })
})
