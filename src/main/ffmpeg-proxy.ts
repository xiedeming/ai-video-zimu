export type PreviewVideoProfile = {
  extension: 'mp4' | 'webm'
  videoArgs: string[]
  audioArgs: string[]
}

export function parseFfmpegEncoders(output: string): Set<string> {
  const encoders = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)/)
    if (match) encoders.add(match[1])
  }
  return encoders
}

export function selectPreviewVideoProfile(encoders: ReadonlySet<string>): PreviewVideoProfile | null {
  if (encoders.has('aac')) {
    if (encoders.has('libx264')) {
      return {
        extension: 'mp4',
        videoArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'],
        audioArgs: ['-c:a', 'aac', '-b:a', '96k']
      }
    }
    if (encoders.has('libopenh264')) {
      return {
        extension: 'mp4',
        videoArgs: ['-c:v', 'libopenh264', '-profile:v', 'main', '-b:v', '1500k'],
        audioArgs: ['-c:a', 'aac', '-b:a', '96k']
      }
    }
  }

  const opusEncoder = encoders.has('libopus') ? 'libopus' : encoders.has('opus') ? 'opus' : null
  if (!opusEncoder) return null
  if (encoders.has('libvpx')) {
    return {
      extension: 'webm',
      videoArgs: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '32', '-b:v', '1500k'],
      audioArgs: ['-c:a', opusEncoder, '-b:a', '96k']
    }
  }
  if (encoders.has('libvpx-vp9')) {
    return {
      extension: 'webm',
      videoArgs: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-crf', '36', '-b:v', '0'],
      audioArgs: ['-c:a', opusEncoder, '-b:a', '96k']
    }
  }
  return null
}

export function previewVideoArgs(
  filePath: string,
  output: string,
  profile: PreviewVideoProfile
): string[] {
  return [
    '-y', '-hide_banner', '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', "scale=w='min(1280,iw)':h=-2",
    '-pix_fmt', 'yuv420p',
    ...profile.videoArgs,
    ...profile.audioArgs,
    ...(profile.extension === 'mp4' ? ['-movflags', '+faststart'] : []),
    output
  ]
}
