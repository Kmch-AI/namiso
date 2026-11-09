import { createHash } from 'node:crypto'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'with',
  '我',
  '你',
  '他',
  '她',
  '它',
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '吗',
  '呢',
  '啊',
  '什么',
  '怎么',
])

export function segment(text: string): string[] {
  const tokens: string[] = []
  for (const part of segmenter.segment(text.normalize('NFKC'))) {
    if (!part.isWordLike) continue
    const token = part.segment.toLowerCase().trim()
    if (token.length === 0 || stopWords.has(token)) continue
    tokens.push(token)
  }
  return tokens
}

export function toIndexText(text: string): string {
  return segment(text).join(' ')
}

export function toFtsQuery(text: string): string {
  const tokens = [...new Set(segment(text))]
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase()
}

export function normalizeAttribute(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/[。！？!?，,；;：:、]+$/g, '')
    .trim()
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

export function excerpt(text: string, tokens: ReadonlySet<string>, maxChars: number): string {
  if (text.length <= maxChars) return text
  const limit = Math.max(1, maxChars)
  const haystack = text.toLowerCase()
  let matchIndex = -1
  let matchLength = 0
  for (const token of tokens) {
    if (token.length === 0) continue
    const index = haystack.indexOf(token)
    if (index === -1) continue
    if (
      matchIndex === -1 ||
      index < matchIndex ||
      (index === matchIndex && token.length > matchLength)
    ) {
      matchIndex = index
      matchLength = token.length
    }
  }
  if (matchIndex === -1) return truncate(text, limit)
  const centered = Math.max(0, matchIndex - Math.floor((limit - matchLength) / 2))
  const start = Math.min(centered, Math.max(0, text.length - limit))
  const end = Math.min(text.length, start + limit)
  const body = text.slice(start, end)
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
