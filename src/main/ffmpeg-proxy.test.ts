import { describe, expect, it } from 'vitest'
import { parseFfmpegEncoders, previewVideoArgs, selectPreviewVideoProfile } from './ffmpeg-proxy'

describe('FFmpeg preview proxy profiles', () => {
  it('parses video and audio encoder names from FFmpeg output', () => {
    const encoders = parseFfmpegEncoders(`Encoders:
 V....D libopenh264          OpenH264 H.264 encoder
 V....D libvpx               libvpx VP8
 A....D aac                  AAC
`)

    expect([...encoders]).toEqual(['libopenh264', 'libvpx', 'aac'])
  })

  it('uses OpenH264 when an LGPL FFmpeg build does not contain libx264', () => {
    const profile = selectPreviewVideoProfile(new Set(['libopenh264', 'aac']))

    expect(profile).toMatchObject({ extension: 'mp4' })
    expect(profile?.videoArgs).toContain('libopenh264')
    expect(profile?.videoArgs).not.toContain('libx264')
  })

  it('prefers libx264 when it is available', () => {
    const profile = selectPreviewVideoProfile(new Set(['libx264', 'libopenh264', 'aac']))

    expect(profile?.videoArgs).toContain('libx264')
  })

  it('falls back to a Chromium-compatible WebM profile', () => {
    const profile = selectPreviewVideoProfile(new Set(['libvpx', 'libopus']))

    expect(profile).toMatchObject({ extension: 'webm' })
    expect(profile?.videoArgs).toContain('libvpx')
    expect(profile?.audioArgs).toContain('libopus')
  })

  it('builds arguments with optional audio and fast-start MP4 output', () => {
    const profile = selectPreviewVideoProfile(new Set(['libopenh264', 'aac']))
    expect(profile).not.toBeNull()

    const args = previewVideoArgs('F:\\媒体\\输入.mp4', 'D:\\缓存\\preview.partial.mp4', profile!)
    expect(args).toContain('0:a:0?')
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('D:\\缓存\\preview.partial.mp4')
  })

  it('reports no profile when compatible video and audio encoders are absent', () => {
    expect(selectPreviewVideoProfile(new Set(['mpeg4', 'mp3']))).toBeNull()
  })
})
