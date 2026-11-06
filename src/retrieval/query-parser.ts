export type QueryIntent = 'current_fact' | 'history' | 'event' | 'entity' | 'general'

export interface ParsedQuery {
  raw: string
  intent: QueryIntent
  wantsCurrent: boolean
  wantsHistory: boolean
}

const CURRENT_MARKERS = /现在|目前|当前|如今|currently|right now|\bnow\b/i
const HISTORY_MARKERS = /以前|曾经|过去|之前|原来|历史|used to|previously|\bbefore\b|historically/i
const EVENT_MARKERS = /什么时候|哪天|发生过|做过|讨论过|聊过|见过|when did|when was/i
const ENTITY_MARKERS = /是谁|是什么|who is|what is|tell me about/i

export function parseQuery(raw: string): ParsedQuery {
  const current = CURRENT_MARKERS.test(raw)
  const history = HISTORY_MARKERS.test(raw)
  let intent: QueryIntent = 'general'
  if (current && !history) {
    intent = 'current_fact'
  } else if (history && !current) {
    intent = 'history'
  } else if (EVENT_MARKERS.test(raw)) {
    intent = 'event'
  } else if (ENTITY_MARKERS.test(raw)) {
    intent = 'entity'
  }
  return {
    raw,
    intent,
    wantsCurrent: current && !history,
    wantsHistory: history,
  }
}
