import type { EntityKind, EntityType } from '../types.ts'
import type {
  ExtractedClaim,
  ExtractedEntity,
  ExtractedEvent,
  ExtractedObject,
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from './types.ts'

const UNCERTAIN =
  /可能|也许|大概|应该|说不定|打算|准备|考虑|想|maybe|might|probably|perhaps|plan to|thinking about/i

export class RuleExtractionProvider implements ExtractionProvider {
  readonly version = 'rule-v2'

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const focus = input.messages.find((message) => message.id === input.focusMessageId)
    if (focus === undefined) {
      return { entities: [], claims: [], events: [] }
    }
    const speakerName = focus.speakerName.length > 0 ? focus.speakerName : focus.speakerId
    const speakerType: EntityKind =
      focus.role === 'assistant' ? 'self' : focus.role === 'user' ? 'person' : 'other'
    const entities = new Map<string, ExtractedEntity>()
    const claims: ExtractedClaim[] = []
    const events: ExtractedEvent[] = []

    const addEntity = (name: string, type: EntityKind, aliases?: readonly string[]): void => {
      const cleaned = cleanValue(name)
      if (cleaned.length === 0) return
      const key = cleaned.toLowerCase()
      const existing = entities.get(key)
      if (existing !== undefined) {
        if (aliases !== undefined && aliases.length > 0) {
          entities.set(key, {
            ...existing,
            aliases: [...new Set([...(existing.aliases ?? []), ...aliases])],
          })
        }
        return
      }
      entities.set(key, {
        name: cleaned,
        type,
        ...(aliases === undefined ? {} : { aliases }),
        evidenceMessageIds: [focus.id],
      })
    }

    addEntity(speakerName, speakerType)

    if (focus.role !== 'user') {
      return { entities: [...entities.values()], claims: [], events: [] }
    }

    const content = focus.content.trim()
    const uncertain = UNCERTAIN.test(content)
    const modality = uncertain ? 'uncertain' : 'asserted'

    const addClaim = (predicate: string, object: ExtractedObject, confidence: number): void => {
      if (uncertain) return
      const duplicate = claims.some(
        (claim) =>
          claim.predicate === predicate &&
          claim.object.kind === object.kind &&
          (object.kind === 'literal'
            ? claim.object.kind === 'literal' && claim.object.value === object.value
            : claim.object.kind === 'entity' && claim.object.name === object.name),
      )
      if (duplicate) return
      claims.push({
        subject: { name: speakerName, type: speakerType },
        predicate,
        object,
        modality,
        confidence,
        validFrom: focus.occurredAt,
        evidenceMessageIds: [focus.id],
      })
      if (object.kind === 'entity') {
        addEntity(object.name, object.type)
      }
    }

    const nameMatch = content.match(/(?:我叫|我的名字(?:是|叫))\s*([^，。！？,!?\s]{1,20})/)
    const nameValue = nameMatch?.[1]
    if (nameValue !== undefined) {
      addClaim('name', { kind: 'literal', value: cleanValue(nameValue) }, 0.95)
    }

    const likeMatch =
      content.match(/(?:我喜欢|我热爱|我偏爱)\s*([^，。！？,!?\s]{1,30})/) ??
      content.match(/I (?:like|love) ([^.,!?]+)/i)
    const likeValue = likeMatch?.[1]
    if (likeValue !== undefined) {
      addClaim('likes', { kind: 'literal', value: cleanValue(likeValue) }, 0.8)
    }

    const useMatch =
      content.match(/(?:我正在使用|我在使用|我使用|我正在用|我在用)\s*([^，。！？,!?\s]{1,40})/) ??
      content.match(/I (?:use|am using) ([^.,!?]+)/i)
    const useValue = useMatch?.[1]
    if (useValue !== undefined) {
      addClaim(
        'uses',
        { kind: 'entity', name: cleanValue(useValue), type: guessType(useValue) },
        0.85,
      )
    }

    const occupationMatch = content.match(
      /(?:我是|我做)((?:一名|一个|位)?[^，。！？,!?\s]{1,12}(?:工程师|程序员|设计师|老师|学生|医生|律师))/,
    )
    const occupation = occupationMatch?.[1]?.replace(/^(?:一名|一个|位)/, '')
    if (occupation !== undefined) {
      addClaim('occupation', { kind: 'literal', value: cleanValue(occupation) }, 0.9)
    }

    const locationMatch = content.match(/(?:我住在|我搬到|我搬家到)\s*([^，。！？,!?\s]{1,20})/)
    const location = locationMatch?.[1]
    if (location !== undefined) {
      addClaim('location', { kind: 'literal', value: cleanValue(location) }, 0.85)
    }

    const ageMatch = content.match(/我(?:今年)?(\d{1,3})岁/)
    const age = ageMatch?.[1]
    if (age !== undefined) {
      addClaim('age', { kind: 'literal', value: age }, 0.9)
    }

    const friendMatch =
      content.match(/([^，。！？,!?\s]{1,20})是我的朋友/) ?? content.match(/my friend ([^.,!?]+)/i)
    const friend = friendMatch?.[1]
    if (friend !== undefined) {
      addClaim('friend_of', { kind: 'entity', name: cleanValue(friend), type: 'person' }, 0.85)
    }

    const workMatch = content.match(/我在\s*([^，。！？,!?\s]{1,30})\s*(?:工作|上班)/)
    const workplace = workMatch?.[1]
    if (workplace !== undefined) {
      addClaim('works_at', { kind: 'entity', name: cleanValue(workplace), type: 'group' }, 0.85)
    }

    const time = eventTime(content, focus.occurredAt)

    const usageMatch = content.match(
      /(重新开始使用|重新使用|开始使用|开始用|换回|换成|改用|换用|不再使用|不再用|停止使用)\s*([^，。！？,!?\s]{1,40})/,
    )
    if (usageMatch !== null) {
      const verb = usageMatch[1] ?? ''
      const objectName = cleanValue(usageMatch[2] ?? '')
      const stops = /不再|停止/.test(verb)
      addEntity(objectName, guessType(objectName))
      events.push({
        type: stops ? 'usage_stop' : 'usage_change',
        summary: truncate(content, 160),
        occurredAt: time.occurredAt,
        timePrecision: time.precision,
        participants: [
          { name: speakerName, type: speakerType, role: 'actor' },
          { name: objectName, type: guessType(objectName), role: 'object' },
        ],
        modality,
        confidence: uncertain ? 0.5 : 0.85,
        evidenceMessageIds: [focus.id],
      })
    }

    const recommendationMatch = content.match(/(?:推荐|安利)(?:了)?\s*([^，。！？,!?\s]{1,40})/)
    const recommended = recommendationMatch?.[1]
    if (recommended !== undefined) {
      const objectName = cleanValue(recommended)
      addEntity(objectName, guessType(objectName))
      events.push({
        type: 'recommendation',
        summary: truncate(content, 160),
        occurredAt: time.occurredAt,
        timePrecision: time.precision,
        participants: [
          { name: speakerName, type: speakerType, role: 'actor' },
          { name: objectName, type: guessType(objectName), role: 'object' },
        ],
        modality,
        confidence: 0.8,
        evidenceMessageIds: [focus.id],
      })
    }

    const loanMatch = content.match(/(?:借了|借给)([^，。！？,!?\s]{1,20})/)
    const borrowed = loanMatch?.[1]
    if (borrowed !== undefined) {
      const objectName = cleanValue(borrowed)
      addEntity(objectName, guessType(objectName))
      events.push({
        type: 'loan',
        summary: truncate(content, 160),
        occurredAt: time.occurredAt,
        timePrecision: time.precision,
        participants: [
          { name: speakerName, type: speakerType, role: 'actor' },
          { name: objectName, type: guessType(objectName), role: 'object' },
        ],
        modality,
        confidence: 0.8,
        evidenceMessageIds: [focus.id],
      })
    }

    for (const claim of claims) {
      if (claim.object.kind === 'entity') {
        addEntity(claim.object.name, claim.object.type)
      }
    }

    return {
      entities: [...entities.values()],
      claims,
      events,
    }
  }
}

function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/^[「『"']|[」』"']$/g, '')
    .replace(/[。！？!?，,；;：:、]+$/g, '')
    .replace(/[了的啊呢吧]+$/g, '')
    .trim()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function guessType(name: string): EntityType {
  if (/公司|集团|工作室|团队|组织|机构|部门/.test(name)) return 'group'
  if (/项目|计划|工程/.test(name)) return 'artifact'
  if (/市|省|区|县|国|城市|街|路|镇/.test(name)) return 'place'
  if (/[A-Za-z].*\d|\d.*[A-Za-z]|TTS|GPT|LLM|SDK|API|模型/.test(name)) return 'artifact'
  return 'other'
}

function eventTime(
  content: string,
  base: number,
): { occurredAt: number; precision: 'day' | 'approximate' } {
  if (content.includes('前天')) return { occurredAt: base - 2 * 86_400, precision: 'day' }
  if (content.includes('昨天')) return { occurredAt: base - 86_400, precision: 'day' }
  if (content.includes('上周')) return { occurredAt: base - 7 * 86_400, precision: 'approximate' }
  if (content.includes('去年')) return { occurredAt: base - 365 * 86_400, precision: 'approximate' }
  return { occurredAt: base, precision: 'day' }
}
