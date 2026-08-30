import { describe, expect, it } from 'vitest'
import { transcriptionAudioArguments, waveformAudioArguments } from './audio-extraction'

describe('timestamp-aligned audio extraction', () => {
  it('uses the same first audio track as preview and retains its timeline offset', () => {
    const args = transcriptionAudioArguments('D:\\素材\\视频.mp4', 'D:\\缓存\\音轨.wav')

    expect(args).toContain('D:\\素材\\视频.mp4')
    expect(args).toContain('D:\\缓存\\音轨.wav')
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '0:a:0'])
    expect(args.slice(args.indexOf('-af'), args.indexOf('-af') + 2)).toEqual([
      '-af',
      'aresample=async=1:first_pts=0'
    ])
    expect(args.slice(args.indexOf('-ar'), args.indexOf('-ar') + 2)).toEqual(['-ar', '16000'])
  })

  it('builds the waveform from the identical aligned audio timeline', () => {
    const args = waveformAudioArguments('input.mov', 'waveform.s16le')

    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '0:a:0'])
    expect(args.slice(args.indexOf('-af'), args.indexOf('-af') + 2)).toEqual([
      '-af',
      'aresample=async=1:first_pts=0'
    ])
    expect(args.slice(args.indexOf('-ar'), args.indexOf('-ar') + 2)).toEqual(['-ar', '200'])
  })
})
