import type { QueryAspect } from '../types.ts'

import { segment } from '../text.ts'

export interface QueryFacet {
  text: string
  tokens: ReadonlySet<string>
}

export interface QueryAnalysis {
  aspects: QueryAspect[]
  facets: QueryFacet[]
}

const CURRENT = /现在|目前|当前|如今|currently|right now|\bnow\b/i
const HISTORY = /以前|曾经|过去|之前|原来|历史|used to|previously|\bbefore\b|historically/i
const EVENT =
  /什么时候|何时|哪天|哪一天|哪年|哪个月|几号|几时|多久|多长时间|发生|发生过|做过|讨论过|聊过|见过|\bwhen\b|what time|what date|which day|how long ago/i
const ENTITY =
  /是谁|是什么|什么人|哪里人|\bwho (?:is|are|was|were)\b|\bwhat (?:is|was)\b|tell me about/i
const CHANGE =
  /变化|改变|变了|变成|变为|变过|换了|换过|换成|换回|改用|改成|改为|更新|调整|不再|停止|开始使用|开始用|重新使用|重新开始使用|\bchang(?:e|es|ed|ing)\b|\bswitch(?:es|ed|ing)?\b|\breplac(?:e|es|ed|ing)\b|\bupdat(?:e|es|ed|ing)\b|\bno longer\b|\bstart(?:ed)? using\b|\bstop(?:ped)? using\b/i

const CLAUSE_BREAK = /[，,、；;。！？!?…\n\r]+/
const CONJUNCTIONS = new Set([
  '和',
  '与',
  '及',
  '以及',
  '还有',
  '并且',
  '而且',
  '或者',
  '或是',
  '还是',
  '同时',
  '然后',
  '另外',
  'and',
  'or',
  'plus',
  'also',
  'then',
])
const MAX_FACETS = 3

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

interface TokenSpan {
  token: string
  index: number
  length: number
}

export function analyzeQuery(raw: string): QueryAnalysis {
  const text = raw.normalize('NFKC')
  return {
    aspects: aspectsOf(text),
    facets: facetsOf(text),
  }
}

function aspectsOf(text: string): QueryAspect[] {
  const aspects: QueryAspect[] = []
  if (CURRENT.test(text)) aspects.push('current')
  if (CHANGE.test(text)) aspects.push('change')
  if (EVENT.test(text)) aspects.push('event_time')
  if (ENTITY.test(text)) aspects.push('entity')
  if (HISTORY.test(text)) aspects.push('history')
  if (aspects.length === 0) aspects.push('general')
  return aspects
}

function facetsOf(text: string): QueryFacet[] {
  const whole = new Set(segment(text))
  const queryKey = tokenKey(whole)
  const candidates: string[] = []
  for (const clause of text.split(CLAUSE_BREAK)) {
    const parts = splitClause(clause)
    candidates.push(...parts)
  }
  const facets: QueryFacet[] = []
  const seen = new Set<string>()
  for (const fragment of candidates) {
    const tokens = new Set(segment(fragment))
    if (tokens.size === 0) continue
    const key = tokenKey(tokens)
    if (key === queryKey) continue
    if (seen.has(key)) continue
    seen.add(key)
    facets.push({ text: fragment, tokens })
    if (facets.length >= MAX_FACETS) break
  }
  return facets
}

function splitClause(clause: string): string[] {
  const spans = tokenSpans(clause)
  const parts: string[] = []
  let start = 0
  for (const span of spans) {
    if (!CONJUNCTIONS.has(span.token)) continue
    parts.push(clause.slice(start, span.index))
    start = span.index + span.length
  }
  parts.push(clause.slice(start))
  const cleaned = parts.map(cleanFragment).filter((part) => segment(part).length > 0)
  if (cleaned.length >= 2) return cleaned
  const whole = cleanFragment(clause)
  return segment(whole).length === 0 ? [] : [whole]
}

function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = []
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue
    const token = part.segment.toLowerCase().trim()
    if (token.length === 0) continue
    spans.push({ token, index: part.index, length: part.segment.length })
  }
  return spans
}

function cleanFragment(text: string): string {
  return text
    .replace(/^[\s，,、；;。！？!?…]+/, '')
    .replace(/[\s，,、；;。！？!?…]+$/, '')
    .trim()
}

function tokenKey(tokens: ReadonlySet<string>): string {
  return [...tokens].toSorted().join('\u0001')
}
