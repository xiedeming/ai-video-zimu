import { describe, expect, it } from 'vitest'
import { parseTranslationJson } from './translation'

describe('translation JSON', () => {
  it('accepts fenced JSON and removes thinking output', () => {
    const result = parseTranslationJson('<think>hidden</think>```json\n{"items":[{"id":"a","translation":" 你好 "}]}\n```')
    expect(result.get('a')).toBe('你好')
  })

  it('rejects a response without JSON', () => {
    expect(() => parseTranslationJson('plain text')).toThrow(/JSON/)
  })

  it('extracts balanced JSON surrounded by explanatory text', () => {
    const result = parseTranslationJson('下面是结果：\n{"items":[{"id":"a","translation":"你好"}]}\n翻译完成。')
    expect(result.get('a')).toBe('你好')
  })

  it('accepts common compatible-service field names and direct maps', () => {
    expect(parseTranslationJson('{"translations":[{"segment_id":"a","text":"甲"}]}').get('a')).toBe('甲')
    expect(parseTranslationJson('{"a":"甲","b":"乙"}').get('b')).toBe('乙')
  })
})
