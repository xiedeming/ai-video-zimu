import { describe, expect, it } from 'vitest'
import { isPrivateNetworkUrl } from './translation-network'

describe('translation service network classification', () => {
  it.each([
    'http://127.0.0.1:11434/v1',
    'http://192.168.1.80:8000/v1',
    'http://10.20.30.40:8080/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.254/v1',
    'http://llm-server:8000/v1',
    'http://model-host.local:8000/v1',
    'http://[fd00::12]:8000/v1'
  ])('recognizes private endpoint %s', (url) => {
    expect(isPrivateNetworkUrl(url)).toBe(true)
  })

  it.each([
    'https://api.openai.com/v1',
    'http://172.32.0.1/v1',
    'http://192.169.1.1/v1'
  ])('does not classify public endpoint %s as private', (url) => {
    expect(isPrivateNetworkUrl(url)).toBe(false)
  })
})
