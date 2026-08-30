import type { SubtitleSegment } from '../../../shared/types'

type SeekableMedia = Pick<HTMLMediaElement, 'currentTime' | 'duration' | 'readyState'>

type MediaClock = Pick<HTMLMediaElement, 'currentTime'> & Partial<Pick<
  HTMLVideoElement,
  'requestVideoFrameCallback' | 'cancelVideoFrameCallback'
>>

export interface AnimationFrameScheduler {
  requestAnimationFrame: (callback: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
}

const HAVE_METADATA = 1

export function clampSeekMs(requestedMs: number, projectDurationMs: number): number {
  const finiteRequested = Number.isFinite(requestedMs) ? requestedMs : 0
  const maximum = Number.isFinite(projectDurationMs) && projectDurationMs > 0
    ? projectDurationMs
    : Number.POSITIVE_INFINITY
  return Math.max(0, Math.min(finiteRequested, maximum))
}

export function applyMediaSeek(media: SeekableMedia, requestedMs: number): boolean {
  if (media.readyState < HAVE_METADATA) return false
  const durationMs = Number.isFinite(media.duration) && media.duration > 0
    ? media.duration * 1000
    : Number.POSITIVE_INFINITY
  const targetMs = clampSeekMs(requestedMs, durationMs)
  try {
    media.currentTime = targetMs / 1000
    return true
  } catch {
    return false
  }
}

export function findActiveSubtitle(
  sortedSegments: readonly SubtitleSegment[],
  requestedMs: number
): SubtitleSegment | undefined {
  if (!Number.isFinite(requestedMs) || requestedMs < 0) return undefined

  let low = 0
  let high = sortedSegments.length - 1
  let candidateIndex = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (sortedSegments[middle].startMs <= requestedMs) {
      candidateIndex = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (candidateIndex < 0) return undefined
  const candidate = sortedSegments[candidateIndex]
  return requestedMs < candidate.endMs ? candidate : undefined
}

export function startMediaTimeSync(
  media: MediaClock,
  onTime: (timeMs: number) => void,
  scheduler: AnimationFrameScheduler = window
): () => void {
  let stopped = false
  let animationFrameId: number | undefined
  let videoFrameId: number | undefined

  const schedule = () => {
    if (stopped) return
    if (typeof media.requestVideoFrameCallback === 'function') {
      videoFrameId = media.requestVideoFrameCallback(update)
    } else {
      animationFrameId = scheduler.requestAnimationFrame(update)
    }
  }
  const update = () => {
    if (stopped) return
    const currentTimeMs = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime * 1000) : 0
    onTime(currentTimeMs)
    schedule()
  }

  update()
  return () => {
    stopped = true
    if (animationFrameId !== undefined) scheduler.cancelAnimationFrame(animationFrameId)
    if (videoFrameId !== undefined && typeof media.cancelVideoFrameCallback === 'function') {
      media.cancelVideoFrameCallback(videoFrameId)
    }
  }
}
