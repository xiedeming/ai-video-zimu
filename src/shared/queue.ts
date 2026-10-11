import { z } from 'zod'
import { projectSchema, sourceLanguageSchema, transcriptionModelIdSchema, translationProfileIdSchema } from './schemas'

export const generationOptionsSchema = z.object({
  sourceLanguage: sourceLanguageSchema,
  transcriptionModelId: transcriptionModelIdSchema,
  translationProfileId: translationProfileIdSchema,
  translate: z.boolean()
}).strict()
export const batchRequestSchema = z.object({
  items: z.array(z.object({ mediaPath: z.string().min(1).max(32768), overrides: generationOptionsSchema.partial().optional() }).strict()).min(1).max(100),
  options: generationOptionsSchema,
  concurrency: z.union([z.literal(1), z.literal(2)])
}).strict()
export const queueControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('cancel-all') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('concurrency'), value: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ action: z.literal('cancel'), jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('retry'), jobId: z.string().uuid() }).strict()
])
export const queueTaskSchema = z.object({
  jobId: z.string().uuid(), projectId: z.string().uuid(),
  project: projectSchema, filePath: z.string().min(1),
  options: generationOptionsSchema,
  state: z.enum(['waiting', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']),
  stage: z.enum(['queued', 'probing', 'preparing', 'transcribing', 'translating', 'saving', 'completed', 'failed', 'canceled']),
  progress: z.number().min(0).max(100), message: z.string(),
  failedStage: z.string().optional(),
  operation: z.enum(['generate', 'retranslate', 'continue']).default('generate'),
  segmentIds: z.array(z.string().min(1)).optional()
}).refine((task) => task.projectId === task.project.id, { message: '项目身份不匹配' })
export const queueSnapshotSchema = z.object({
  tasks: z.array(queueTaskSchema), paused: z.boolean(),
  concurrency: z.union([z.literal(1), z.literal(2)]), recovery: z.boolean()
})
export type GenerationOptions = z.infer<typeof generationOptionsSchema>
export type BatchRequest = z.infer<typeof batchRequestSchema>
export type QueueControl = z.infer<typeof queueControlSchema>
export type QueueTask = z.infer<typeof queueTaskSchema>
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>
export interface BatchValidationRow { mediaPath: string; filePath?: string; error?: string }
export const projectJobEventSchema = z.object({
  jobId: z.string().uuid(), projectId: z.string().uuid(),
  stage: z.enum(['queued', 'probing', 'preparing', 'transcribing', 'translating', 'completed', 'failed', 'canceled']),
  progress: z.number().min(0).max(100), message: z.string(), elapsedMs: z.number().nonnegative(),
  project: projectSchema.optional(), errorCode: z.string().optional(), remainingSegmentIds: z.array(z.string()).optional()
}).refine((event) => !event.project || event.project.id === event.projectId, { message: '项目身份不匹配' })
