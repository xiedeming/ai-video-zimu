import { legacyProjectSchema, projectSchema } from './schemas'
import { BUILTIN_TRANSLATION_PROFILE_ID, DEFAULT_TRANSCRIPTION_MODEL_ID, type ZimuProjectV1 } from './types'

export function migrateProject(value: unknown): ZimuProjectV1 {
  const current = projectSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = legacyProjectSchema.parse(value)
  return projectSchema.parse({
    ...legacy,
    schemaVersion: 2,
    settings: {
      ...legacy.settings,
      transcriptionModelId: DEFAULT_TRANSCRIPTION_MODEL_ID,
      translationProfileId: BUILTIN_TRANSLATION_PROFILE_ID
    }
  })
}
