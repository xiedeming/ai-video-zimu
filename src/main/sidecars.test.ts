import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => 'D:\\app',
    getPath: () => 'D:\\user-data',
    isPackaged: false
  }
}))

let waveformPeaks: typeof import('./sidecars').waveformPeaks
let waveformTemporaryPath: typeof import('./sidecars').waveformTemporaryPath

beforeAll(async () => {
  ({ waveformPeaks, waveformTemporaryPath } = await import('./sidecars'))
})

describe('waveform extraction helpers', () => {
  it('uses request-scoped paths so concurrent extractions cannot delete each other', () => {
    const first = waveformTemporaryPath('D:\\cache\\waveforms', 'request-a')
    const second = waveformTemporaryPath('D:\\cache\\waveforms', 'request-b')

    expect(first).not.toBe(second)
    expect(first).toContain('request-a.partial.s16le')
    expect(second).toContain('request-b.partial.s16le')
  })

  it('returns normalized peaks and keeps a visible floor for silent buckets', () => {
    const buffer = Buffer.alloc(64 * 2)
    buffer.writeInt16LE(32767, 0)

    const peaks = waveformPeaks(buffer, 32)

    expect(peaks).toHaveLength(32)
    expect(peaks[0]).toBeCloseTo(32767 / 32768)
    expect(peaks.slice(1)).toEqual(Array(31).fill(0.06))
  })

  it('returns no peaks when FFmpeg produced no PCM samples', () => {
    expect(waveformPeaks(Buffer.alloc(0), 120)).toEqual([])
  })
})
