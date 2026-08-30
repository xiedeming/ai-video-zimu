import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { translationProfileInputSchema } from '../shared/schemas'
import {
  BUILTIN_TRANSLATION_PROFILE_ID,
  type TranslationProfile,
  type TranslationProfileInput
} from '../shared/types'
import { getAppPaths } from './constants'
import { isPrivateNetworkUrl } from './translation-network'

interface StoredProfile {
  id: string
  name: string
  kind: 'openai-compatible'
  baseUrl: string
  model: string
}

interface ProfileFile {
  version: 1
  defaultProfileId: string
  profiles: StoredProfile[]
}

type SecretFile = Record<string, string>

export interface ResolvedTranslationProfile {
  profile: TranslationProfile
  apiKey?: string
}

const BUILTIN_PROFILE: TranslationProfile = {
  id: BUILTIN_TRANSLATION_PROFILE_ID,
  name: '本地 Qwen3 8B',
  kind: 'builtin',
  model: 'Qwen3-8B-Q4_K_M',
  hasApiKey: false,
  isDefault: true
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, filePath)
}

export class TranslationProfileManager {
  private async readProfiles(): Promise<ProfileFile> {
    try {
      const parsed = JSON.parse(await readFile(getAppPaths().translationProfiles, 'utf8')) as ProfileFile
      if (parsed.version === 1 && Array.isArray(parsed.profiles)) return parsed
    } catch { /* use defaults */ }
    return { version: 1, defaultProfileId: BUILTIN_TRANSLATION_PROFILE_ID, profiles: [] }
  }

  private async readSecrets(): Promise<SecretFile> {
    try { return JSON.parse(await readFile(getAppPaths().translationSecrets, 'utf8')) as SecretFile }
    catch { return {} }
  }

  private publicProfiles(metadata: ProfileFile, secrets: SecretFile): TranslationProfile[] {
    const defaultId = metadata.profiles.some((profile) => profile.id === metadata.defaultProfileId)
      ? metadata.defaultProfileId
      : BUILTIN_TRANSLATION_PROFILE_ID
    return [
      { ...BUILTIN_PROFILE, isDefault: defaultId === BUILTIN_TRANSLATION_PROFILE_ID },
      ...metadata.profiles.map((profile) => ({ ...profile, hasApiKey: Boolean(secrets[profile.id]), isDefault: profile.id === defaultId }))
    ]
  }

  async list(): Promise<TranslationProfile[]> {
    const [metadata, secrets] = await Promise.all([this.readProfiles(), this.readSecrets()])
    return this.publicProfiles(metadata, secrets)
  }

  async defaultId(): Promise<string> {
    return (await this.list()).find((profile) => profile.isDefault)?.id ?? BUILTIN_TRANSLATION_PROFILE_ID
  }

  private encryptApiKey(apiKey: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw Object.assign(new Error('当前系统无法安全加密 API Key，请检查 Windows 凭据服务'), { code: 'CREDENTIAL_ENCRYPTION_UNAVAILABLE' })
    }
    return safeStorage.encryptString(apiKey).toString('base64')
  }

  private decryptApiKey(encrypted?: string): string | undefined {
    if (!encrypted) return undefined
    if (!safeStorage.isEncryptionAvailable()) {
      throw Object.assign(new Error('当前系统无法解密已保存的 API Key'), { code: 'CREDENTIAL_DECRYPTION_UNAVAILABLE' })
    }
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  async create(inputValue: TranslationProfileInput): Promise<TranslationProfile> {
    const input = translationProfileInputSchema.parse(inputValue)
    if (!isPrivateNetworkUrl(input.baseUrl) && !input.apiKey?.trim()) {
      throw Object.assign(new Error('云端翻译服务必须填写 API Key'), { code: 'API_KEY_REQUIRED' })
    }
    const metadata = await this.readProfiles()
    const secrets = await this.readSecrets()
    const stored: StoredProfile = { id: randomUUID(), name: input.name, kind: input.kind, baseUrl: input.baseUrl, model: input.model }
    metadata.profiles.push(stored)
    if (input.apiKey?.trim()) secrets[stored.id] = this.encryptApiKey(input.apiKey.trim())
    await Promise.all([atomicJson(getAppPaths().translationProfiles, metadata), atomicJson(getAppPaths().translationSecrets, secrets)])
    return (await this.list()).find((profile) => profile.id === stored.id)!
  }

  async update(id: string, inputValue: TranslationProfileInput): Promise<TranslationProfile> {
    if (id === BUILTIN_TRANSLATION_PROFILE_ID) throw new Error('内置翻译配置不能编辑')
    const input = translationProfileInputSchema.parse(inputValue)
    const metadata = await this.readProfiles()
    const secrets = await this.readSecrets()
    const index = metadata.profiles.findIndex((profile) => profile.id === id)
    if (index < 0) throw Object.assign(new Error('找不到翻译配置'), { code: 'TRANSLATION_PROFILE_NOT_FOUND' })
    const nextHasKey = input.clearApiKey ? false : Boolean(input.apiKey?.trim() || secrets[id])
    if (!isPrivateNetworkUrl(input.baseUrl) && !nextHasKey) throw Object.assign(new Error('云端翻译服务必须填写 API Key'), { code: 'API_KEY_REQUIRED' })
    metadata.profiles[index] = { id, name: input.name, kind: input.kind, baseUrl: input.baseUrl, model: input.model }
    if (input.clearApiKey) delete secrets[id]
    else if (input.apiKey?.trim()) secrets[id] = this.encryptApiKey(input.apiKey.trim())
    await Promise.all([atomicJson(getAppPaths().translationProfiles, metadata), atomicJson(getAppPaths().translationSecrets, secrets)])
    return (await this.list()).find((profile) => profile.id === id)!
  }

  private async persistedUsage(id: string): Promise<boolean> {
    const candidates = new Set<string>()
    try {
      const recent = JSON.parse(await readFile(getAppPaths().recent, 'utf8')) as Array<{ filePath?: string }>
      recent.forEach((entry) => { if (entry.filePath) candidates.add(entry.filePath) })
    } catch { /* no recent projects */ }
    try {
      const names = await readdir(getAppPaths().autosave)
      names.filter((name) => name.endsWith('.zimu')).forEach((name) => candidates.add(join(getAppPaths().autosave, name)))
    } catch { /* no autosaves */ }
    for (const filePath of candidates) {
      try {
        const value = JSON.parse(await readFile(filePath, 'utf8')) as { settings?: { translationProfileId?: string } }
        if (value.settings?.translationProfileId === id) return true
      } catch { /* ignore unreadable projects */ }
    }
    return false
  }

  async remove(id: string, activeProfileId?: string): Promise<void> {
    if (id === BUILTIN_TRANSLATION_PROFILE_ID) throw new Error('内置翻译配置不能删除')
    if (activeProfileId === id || await this.persistedUsage(id)) {
      throw Object.assign(new Error('该翻译配置仍被项目使用，请先为项目选择其他配置'), { code: 'TRANSLATION_PROFILE_IN_USE' })
    }
    const metadata = await this.readProfiles()
    const secrets = await this.readSecrets()
    metadata.profiles = metadata.profiles.filter((profile) => profile.id !== id)
    if (metadata.defaultProfileId === id) metadata.defaultProfileId = BUILTIN_TRANSLATION_PROFILE_ID
    delete secrets[id]
    await Promise.all([atomicJson(getAppPaths().translationProfiles, metadata), atomicJson(getAppPaths().translationSecrets, secrets)])
  }

  async setDefault(id: string): Promise<TranslationProfile[]> {
    const metadata = await this.readProfiles()
    if (id !== BUILTIN_TRANSLATION_PROFILE_ID && !metadata.profiles.some((profile) => profile.id === id)) {
      throw Object.assign(new Error('找不到翻译配置'), { code: 'TRANSLATION_PROFILE_NOT_FOUND' })
    }
    metadata.defaultProfileId = id
    await atomicJson(getAppPaths().translationProfiles, metadata)
    return this.list()
  }

  async resolve(id: string, draft?: TranslationProfileInput): Promise<ResolvedTranslationProfile> {
    if (id === BUILTIN_TRANSLATION_PROFILE_ID && !draft) return { profile: { ...BUILTIN_PROFILE, isDefault: (await this.defaultId()) === id } }
    const [profiles, secrets] = await Promise.all([this.list(), this.readSecrets()])
    const existing = profiles.find((profile) => profile.id === id)
    if (!existing && !draft) throw Object.assign(new Error('项目使用的翻译配置已不存在，请重新选择'), { code: 'TRANSLATION_PROFILE_NOT_FOUND' })
    if (draft) {
      const input = translationProfileInputSchema.parse(draft)
      const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || this.decryptApiKey(secrets[id])
      if (!isPrivateNetworkUrl(input.baseUrl) && !apiKey) throw Object.assign(new Error('云端翻译服务必须填写 API Key'), { code: 'API_KEY_REQUIRED' })
      return { profile: { id, name: input.name, kind: input.kind, baseUrl: input.baseUrl, model: input.model, hasApiKey: Boolean(apiKey), isDefault: false }, apiKey }
    }
    return { profile: existing!, apiKey: this.decryptApiKey(secrets[id]) }
  }
}
