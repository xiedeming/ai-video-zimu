import { availableParallelism } from 'node:os'
import type { SourceLanguage } from '../shared/types'

export interface WhisperArgumentOptions {
  modelPath: string
  audioPath: string
  language: SourceLanguage
  outputBase: string
  vadModelPath: string
  useGpu: boolean
  logicalProcessors?: number
}

export function whisperThreadCount(logicalProcessors = availableParallelism()): number {
  return Math.max(1, Math.min(8, Math.floor(logicalProcessors)))
}

export function buildWhisperArguments(options: WhisperArgumentOptions): string[] {
  const args = [
    '-m', options.modelPath,
    '-f', options.audioPath,
    '-l', options.language,
    '-ojf', '-of', options.outputBase,
    '--vad', '-vm', options.vadModelPath,
    '-vsd', '300',
    '-vmsd', '30',
    '-vp', '120',
    '-vo', '0.10',
    '-t', String(whisperThreadCount(options.logicalProcessors)),
    '-bs', '5',
    '-bo', '5',
    '-fa',
    '-ml', '80',
    '-sow',
    '-pp'
  ]
  if (!options.useGpu) args.push('--no-gpu')
  return args
}
