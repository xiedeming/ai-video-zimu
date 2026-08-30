import { describe, expect, it } from 'vitest'
import { downloadSourceLabel, getModelDownloadSources } from './download-sources'
import type { ModelManifestItem } from '../shared/types'

const whisper: ModelManifestItem = {
  id: 'whisper-large-v3-turbo', name: 'Whisper', description: '', fileName: 'model.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/model.bin?download=true',
  size: 10, license: 'MIT', version: '1', required: true
}

describe('model download sources', () => {
  it('prefers a mirror and keeps the official source as fallback', () => {
    expect(getModelDownloadSources(whisper)).toEqual([
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/model.bin?download=true',
      whisper.url
    ])
  })

  it('puts a custom endpoint first and removes duplicates', () => {
    const sources = getModelDownloadSources(whisper, 'https://models.example.test/')
    expect(sources[0]).toBe('https://models.example.test/ggerganov/whisper.cpp/resolve/main/model.bin?download=true')
    expect(new Set(sources).size).toBe(sources.length)
  })

  it('uses the compatible mirror path for Qwen', () => {
    const qwen: ModelManifestItem = {
      ...whisper,
      id: 'qwen3-8b-q4-k-m',
      url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true'
    }
    expect(getModelDownloadSources(qwen)[0]).toBe(
      'https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true'
    )
  })

  it('returns a readable source label', () => {
    expect(downloadSourceLabel('https://hf-mirror.com/a')).toBe('Hugging Face 国内镜像')
  })
})
