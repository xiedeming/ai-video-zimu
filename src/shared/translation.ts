interface TranslationItem {
  id?: string
  segmentId?: string
  segment_id?: string
  translation?: string
  translatedText?: string
  text?: string
}

function balancedJsonAt(content: string, start: number): string | undefined {
  const opening = content[start]
  if (opening !== '{' && opening !== '[') return undefined
  const stack: string[] = []
  let quoted = false
  let escaped = false

  for (let index = start; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') { quoted = true; continue }
    if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '['
      if (stack.pop() !== expected) return undefined
      if (!stack.length) return content.slice(start, index + 1)
    }
  }
  return undefined
}

function jsonValues(content: string): unknown[] {
  const values: unknown[] = []
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '{' && content[index] !== '[') continue
    const candidate = balancedJsonAt(content, index)
    if (!candidate) continue
    try {
      values.push(JSON.parse(candidate))
      index += candidate.length - 1
    } catch { /* try the next balanced value */ }
  }
  return values
}

function itemsFrom(value: unknown): TranslationItem[] {
  if (Array.isArray(value)) return value.filter((item): item is TranslationItem => Boolean(item) && typeof item === 'object')
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  for (const key of ['items', 'translations', 'results', 'data']) {
    if (Array.isArray(object[key])) return itemsFrom(object[key])
  }
  if (object.result && typeof object.result === 'object') {
    const nested = itemsFrom(object.result)
    if (nested.length) return nested
  }
  if (typeof object.id === 'string' || typeof object.segmentId === 'string' || typeof object.segment_id === 'string') {
    return [object as TranslationItem]
  }
  return Object.entries(object)
    .filter(([, translation]) => typeof translation === 'string')
    .map(([id, translation]) => ({ id, translation: translation as string }))
}

export function stripModelThinking(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim()
}

export function parseTranslationJson(content: string): Map<string, string> {
  const cleaned = stripModelThinking(content)
  const values = jsonValues(cleaned)
  if (!values.length) throw Object.assign(new Error('翻译模型没有返回可解析的 JSON'), { code: 'TRANSLATION_JSON_INVALID' })

  const result = new Map<string, string>()
  for (const value of values) {
    for (const item of itemsFrom(value)) {
      const id = item.id ?? item.segmentId ?? item.segment_id
      const translation = item.translation ?? item.translatedText ?? item.text
      if (id && typeof translation === 'string' && translation.trim()) result.set(id, translation.trim())
    }
    if (result.size) return result
  }
  return result
}
