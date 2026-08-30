import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))
vi.mock('./constants', () => ({ getAppPaths: () => ({
  translationProfiles: `${state.root}/profiles.json`, translationSecrets: `${state.root}/secrets.json`,
  recent: `${state.root}/recent.json`, autosave: `${state.root}/autosave`
}) }))

import { TranslationProfileManager } from './translation-profile-manager'

describe('translation profile manager', () => {
  beforeEach(async () => {
    state.root = join(tmpdir(), 'zimu-profile-manager-vitest')
    await mkdir(join(state.root, 'autosave'), { recursive: true })
    await Promise.all(['profiles.json', 'secrets.json', 'recent.json'].map((name) => unlink(join(state.root, name)).catch(() => undefined)))
  })

  it('stores an encrypted key and never returns it in public profiles', async () => {
    const manager = new TranslationProfileManager()
    const created = await manager.create({ name: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'qwen', apiKey: 'plain-secret' })
    expect(created).toMatchObject({ name: 'Cloud', hasApiKey: true })
    expect(created).not.toHaveProperty('apiKey')
    expect(await readFile(join(state.root, 'secrets.json'), 'utf8')).not.toContain('plain-secret')
    expect((await manager.resolve(created.id)).apiKey).toBe('plain-secret')
  })

  it('allows an unauthenticated localhost profile and blocks deleting an active profile', async () => {
    const manager = new TranslationProfileManager()
    const created = await manager.create({ name: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' })
    expect(created.hasApiKey).toBe(false)
    await expect(manager.remove(created.id, created.id)).rejects.toMatchObject({ code: 'TRANSLATION_PROFILE_IN_USE' })
  })

  it('allows an unauthenticated private-network translation service', async () => {
    const manager = new TranslationProfileManager()
    const created = await manager.create({
      name: 'LAN model',
      kind: 'openai-compatible',
      baseUrl: 'http://192.168.1.80:8000/v1',
      model: 'qwen'
    })

    expect(created).toMatchObject({ baseUrl: 'http://192.168.1.80:8000/v1', hasApiKey: false })
  })
})
