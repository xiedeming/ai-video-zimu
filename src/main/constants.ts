import { app } from 'electron'
import { join } from 'node:path'
import type { ModelManifestItem } from '../shared/types'

export const MODEL_MANIFEST: ModelManifestItem[] = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    description: '高质量日语、英语语音识别模型',
    fileName: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin?download=true',
    size: 1_621_272_275,
    license: 'MIT',
    version: 'large-v3-turbo',
    expectedSha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    required: true
  },
  {
    id: 'whisper-large-v3',
    name: 'Whisper Large v3',
    description: '通用高精度日语、英语语音识别模型，速度较慢且需要更多内存',
    fileName: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true',
    size: 3_095_033_483,
    license: 'MIT',
    version: 'large-v3',
    expectedSha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    required: false
  },
  {
    id: 'qwen3-8b-q4-k-m',
    name: 'Qwen3 8B Q4_K_M',
    description: '日英到简体中文的自然字幕翻译模型',
    fileName: 'qwen3-8b-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true',
    size: 5_030_000_000,
    license: 'Apache-2.0',
    version: 'Qwen3-8B-Q4_K_M',
    expectedSha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
    required: true
  },
  {
    id: 'silero-vad-v6.2',
    name: 'Silero VAD 6.2',
    description: '过滤静音并减少无声片段幻觉',
    fileName: 'ggml-silero-v6.2.0.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin?download=true',
    size: 864_000,
    license: 'MIT',
    version: '6.2.0',
    required: true
  }
]

export const getAppPaths = () => ({
  models: join(app.getPath('userData'), 'models'),
  cache: join(app.getPath('userData'), 'cache'),
  autosave: join(app.getPath('userData'), 'autosave'),
  recent: join(app.getPath('userData'), 'recent-projects.json'),
  logs: join(app.getPath('userData'), 'logs'),
  translationApiLog: join(app.getPath('userData'), 'logs', 'translation-api.ndjson'),
  translationProfiles: join(app.getPath('userData'), 'translation-profiles.json'),
  translationSecrets: join(app.getPath('userData'), 'translation-secrets.json')
})

export const MEDIA_FILTERS = [
  { name: '视频和音频', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
  { name: '所有文件', extensions: ['*'] }
]
