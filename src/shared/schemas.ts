import { z } from 'zod'
import { BUILTIN_TRANSLATION_PROFILE_ID, DEFAULT_TRANSCRIPTION_MODEL_ID } from './types'

export const sourceLanguageSchema = z.enum(['auto', 'ja', 'en'])
export const transcriptionModelIdSchema = z.enum(['whisper-large-v3-turbo', 'whisper-large-v3'])

export const wordTimingSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  probability: z.number().min(0).max(1).optional()
})

export const subtitleSegmentSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  sourceText: z.string(),
  translatedText: z.string(),
  words: z.array(wordTimingSchema).default([]),
  confidence: z.number().min(0).max(1),
  status: z.enum(['generated', 'edited', 'reviewed', 'warning'])
})

export const subtitleSegmentIdListSchema = z.array(z.string().min(1).max(256)).max(100_000)

export const mediaReferenceSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  kind: z.enum(['video', 'audio']),
  audioCodec: z.string().optional(),
  videoCodec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fingerprint: z.string().optional()
})

const projectBaseSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  media: mediaReferenceSchema,
  sourceLanguage: sourceLanguageSchema,
  detectedLanguage: z.enum(['ja', 'en']).optional(),
  targetLanguage: z.literal('zh-CN'),
  modelVersions: z.object({ whisper: z.string(), translator: z.string(), vad: z.string() }),
  segments: z.array(subtitleSegmentSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export const legacyProjectSchema = projectBaseSchema.extend({
  schemaVersion: z.literal(1),
  settings: z.object({
    translationStyle: z.literal('natural'),
    minSegmentMs: z.number().int().positive(),
    maxSegmentMs: z.number().int().positive()
  })
})

export const projectSchema = projectBaseSchema.extend({
  schemaVersion: z.literal(2),
  settings: z.object({
    translationStyle: z.literal('natural'),
    minSegmentMs: z.number().int().positive(),
    maxSegmentMs: z.number().int().positive(),
    transcriptionModelId: transcriptionModelIdSchema.default(DEFAULT_TRANSCRIPTION_MODEL_ID),
    translationProfileId: z.string().min(1)
  })
})

export const translationProfileInputSchema = z.object({
  name: z.string().trim().min(1, '请输入配置名称').max(80),
  kind: z.literal('openai-compatible'),
  baseUrl: z.string().trim().url('请输入有效的 Base URL').transform((value) => value.replace(/\/$/, '')),
  model: z.string().trim().min(1, '请输入模型名称').max(160),
  apiKey: z.string().max(4096).optional(),
  clearApiKey: z.boolean().optional()
})

export const translationProfileIdSchema = z.union([z.literal(BUILTIN_TRANSLATION_PROFILE_ID), z.string().uuid()])
export const translationProfileTestIdSchema = z.union([translationProfileIdSchema, z.literal('draft')])

export const exportRequestSchema = z.object({
  project: projectSchema,
  format: z.enum(['srt', 'vtt', 'ass']),
  content: z.enum(['bilingual', 'translation', 'source']),
  filePath: z.string().optional()
})

export const modelIdSchema = z.enum(['whisper-large-v3-turbo', 'whisper-large-v3', 'qwen3-8b-q4-k-m', 'silero-vad-v6.2'])
