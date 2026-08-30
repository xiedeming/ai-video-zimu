import { describe, expect, it } from 'vitest'
import type { SubtitleSegment } from '../../../shared/types'
import { applyMediaSeek, clampSeekMs, findActiveSubtitle, startMediaTimeSync } from './media-playback'

describe('media preview seeking', () => {
  it('clamps timeline seeks to the project duration', () => {
    expect(clampSeekMs(-100, 10_000)).toBe(0)
    expect(clampSeekMs(12_000, 10_000)).toBe(10_000)
    expect(clampSeekMs(4_500, 10_000)).toBe(4_500)
  })

  it('defers seeking until media metadata is available', () => {
    const media = { currentTime: 0, duration: Number.NaN, readyState: 0 }

    expect(applyMediaSeek(media, 5_000)).toBe(false)
    expect(media.currentTime).toBe(0)
  })

  it('seeks after metadata loads and respects the actual media duration', () => {
    const media = { currentTime: 0, duration: 8, readyState: 1 }

    expect(applyMediaSeek(media, 12_000)).toBe(true)
    expect(media.currentTime).toBe(8)
  })
})

describe('subtitle preview timing', () => {
  const segments: SubtitleSegment[] = [
    { id: 'a', startMs: 1000, endMs: 2000, sourceText: 'A', translatedText: '', words: [], confidence: .9, status: 'generated' },
    { id: 'b', startMs: 2000, endMs: 2500, sourceText: 'B', translatedText: '', words: [], confidence: .9, status: 'generated' }
  ]

  it('switches cues exactly at an end-exclusive shared boundary', () => {
    expect(findActiveSubtitle(segments, 999)).toBeUndefined()
    expect(findActiveSubtitle(segments, 1000)?.id).toBe('a')
    expect(findActiveSubtitle(segments, 1999)?.id).toBe('a')
    expect(findActiveSubtitle(segments, 2000)?.id).toBe('b')
    expect(findActiveSubtitle(segments, 2500)).toBeUndefined()
  })

  it('updates against video frames and cancels the pending callback', () => {
    let callback: VideoFrameRequestCallback | undefined
    let canceledId: number | undefined
    const media = {
      currentTime: 1.25,
      requestVideoFrameCallback: (next: VideoFrameRequestCallback) => {
        callback = next
        return 7
      },
      cancelVideoFrameCallback: (id: number) => { canceledId = id }
    }
    const scheduler = {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined
    }
    const times: number[] = []

    const stop = startMediaTimeSync(media, (timeMs) => times.push(timeMs), scheduler)
    expect(times).toEqual([1250])

    media.currentTime = 1.5
    callback?.(0, {} as VideoFrameCallbackMetadata)
    expect(times).toEqual([1250, 1500])

    stop()
    expect(canceledId).toBe(7)
  })

  it('uses animation frames for audio-only media', () => {
    let callback: FrameRequestCallback | undefined
    let canceledId: number | undefined
    const media = { currentTime: .25 }
    const scheduler = {
      requestAnimationFrame: (next: FrameRequestCallback) => {
        callback = next
        return 9
      },
      cancelAnimationFrame: (id: number) => { canceledId = id }
    }
    const times: number[] = []

    const stop = startMediaTimeSync(media, (timeMs) => times.push(timeMs), scheduler)
    media.currentTime = .5
    callback?.(0)

    expect(times).toEqual([250, 500])
    stop()
    expect(canceledId).toBe(9)
  })
})
