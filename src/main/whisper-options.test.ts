import { describe, expect, it } from 'vitest'
import { buildWhisperArguments, whisperThreadCount } from './whisper-options'

const options = {
  modelPath: 'model.bin',
  audioPath: 'audio.wav',
  language: 'ja' as const,
  outputBase: 'transcript',
  vadModelPath: 'vad.bin',
  useGpu: true,
  logicalProcessors: 16
}

describe('Whisper performance arguments', () => {
  it('uses all small CPUs and caps larger systems at eight threads', () => {
    expect(whisperThreadCount(1)).toBe(1)
    expect(whisperThreadCount(4)).toBe(4)
    expect(whisperThreadCount(16)).toBe(8)
  })

  it('keeps quality decoding while enabling CUDA and tuned VAD', () => {
    const args = buildWhisperArguments(options)
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1]

    expect(valueAfter('-t')).toBe('8')
    expect(valueAfter('-bs')).toBe('5')
    expect(valueAfter('-bo')).toBe('5')
    expect(valueAfter('-vsd')).toBe('300')
    expect(valueAfter('-vmsd')).toBe('30')
    expect(valueAfter('-vp')).toBe('120')
    expect(valueAfter('-vo')).toBe('0.10')
    expect(args).toContain('-fa')
    expect(args).not.toContain('--no-gpu')
  })

  it('keeps the same settings and explicitly falls back to CPU', () => {
    expect(buildWhisperArguments({ ...options, useGpu: false })).toContain('--no-gpu')
  })
})
