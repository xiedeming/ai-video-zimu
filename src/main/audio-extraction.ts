const alignedResampleFilter = 'aresample=async=1:first_pts=0'

function alignedAudioInput(filePath: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', alignedResampleFilter, '-ac', '1'
  ]
}

export function transcriptionAudioArguments(filePath: string, outputPath: string): string[] {
  return [
    ...alignedAudioInput(filePath),
    '-ar', '16000', '-c:a', 'pcm_s16le', outputPath
  ]
}

export function waveformAudioArguments(filePath: string, outputPath: string): string[] {
  return [
    ...alignedAudioInput(filePath),
    '-ar', '200', '-f', 's16le', outputPath
  ]
}
