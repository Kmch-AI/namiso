import type { Restriction } from '../annotation/restriction.ts'
import type { Database } from '../storage/database.ts'
import type {
  Claim,
  MemoryCandidate,
  MemoryContext,
  MemoryDisclosure,
  MemoryModality,
  MemoryRef,
  MemorySensitivity,
  MemorySpaceId,
  Message,
  MessageId,
  RetrievalTimeTrace,
  RetrievalTrace,
} from '../types.ts'

import { isRestricted, restrictionOf } from '../annotation/restriction.ts'
import { asMessageId } from '../ids.ts'
import { getMessagesByIds, listMessages } from '../storage/conversation-repo.ts'
import { estimateTokens, excerpt, segment, truncate } from '../text.ts'

export interface BuildContextInput {
  memorySpaceId: MemorySpaceId
  query: string
  candidates: readonly MemoryCandidate[]
  trace: RetrievalTrace
  maxTokens?: number
  includeEvidence?: boolean
  idMode?: 'short' | 'full'
  timeZone?: string
}

const MAX_EVENTS = 12
const MAX_EVIDENCE = 12
const MAX_RELATIONS = 12

interface DetailLevel {
  evidence: number
  summary: number
  description: number
  literal: number
}

const FULL_DETAIL: DetailLevel = {
  evidence: 320,
  summary: 240,
  description: 240,
  literal: 240,
}

const MIN_DETAIL: DetailLevel = {
  evidence: 64,
  summary: 48,
  description: 32,
  literal: 40,
}

const SCALE_STEPS = 8

const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const REF_PREFIX: Record<MemoryRef['kind'], string> = {
  claim: 'c',
  entity: 'n',
  event: 'e',
  message: 'm',
}

const MODALITY_LABELS: Record<string, string> = {
  uncertain: '未确认',
  hypothetical: '计划或假设',
  quoted: '据述',
  negated: '否定',
  reported: '据述',
}

interface RenderState {
  idMode: 'short' | 'full'
  timeZone: string
  refs: Record<string, MemoryRef>
  next: Record<MemoryRef['kind'], number>
}

interface ClaimDate {
  at: number
  fromValidFrom: boolean
}

interface DateLookup {
  claims: Map<string, ClaimDate | null>
  events: Map<string, number | null>
}

export function buildContext(db: Database, input: BuildContextInput): MemoryContext {
  const maxTokens = input.maxTokens ?? 1200
  const state: RenderState = {
    idMode: input.idMode ?? 'short',
    timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    refs: {},
    next: { claim: 0, entity: 0, event: 0, message: 0 },
  }
  const entities = input.candidates.filter((candidate) => candidate.kind === 'entity')
  const claims = input.candidates.filter((candidate) => candidate.kind === 'claim')
  const publicClaims = claims.filter((candidate) => !isRestricted(candidateRestriction(candidate)))
  const privateClaims = claims
    .filter((candidate) => isRestricted(candidateRestriction(candidate)))
    .toSorted(comparePrivateClaims)
  const activeClaims = publicClaims.filter(
    (candidate) => candidate.status === 'active' && claimModalityOf(candidate) === 'asserted',
  )
  const unconfirmedClaims = publicClaims.filter((candidate) => {
    const modality = claimModalityOf(candidate)
    return candidate.status === 'active' && modality !== null && modality !== 'asserted'
  })
  const historicalClaims = publicClaims.filter((candidate) => candidate.status !== 'active')
  const events = input.candidates.filter((candidate) => candidate.kind === 'event')
  const publicEvents = events
    .filter((candidate) => !isRestricted(candidateRestriction(candidate)))
    .slice(0, MAX_EVENTS)
    .toSorted(compareEvents)
  const privateEvents = events
    .filter((candidate) => isRestricted(candidateRestriction(candidate)))
    .slice(0, MAX_EVENTS)
    .toSorted(compareEvents)
  const restrictedEvidenceIds = collectRestrictedEvidenceIds(claims, events)
  const relations = collectRelations(input.candidates, state)
  const evidence =
    input.includeEvidence === false
      ? []
      : collectEvidence(db, input.memorySpaceId, input.candidates, input.query)
  const dates = collectDates(db, input.candidates)
  const described = describedEntities(input.candidates)
  const renderedEntities = entities.filter((candidate) => entityHasDetails(candidate, described))
  const conflicts = collectConflicts(activeClaims, dates, state.timeZone)
  const uncertainEvents = collectUncertainEvents(publicEvents, dates, state.timeZone)

  const text = assemble({
    maxTokens,
    query: input.query,
    activeClaims,
    unconfirmedClaims,
    privateClaims,
    privateEvents,
    entities: renderedEntities,
    events: publicEvents,
    historicalClaims,
    relations,
    evidence,
    restrictedEvidenceIds,
    conflicts,
    uncertainEvents,
    dates,
    described,
    ...(input.trace.time === undefined ? {} : { time: input.trace.time }),
    state,
  })

  return {
    text: text.text,
    items: [
      ...activeClaims,
      ...unconfirmedClaims,
      ...renderedEntities,
      ...publicEvents,
      ...historicalClaims,
      ...privateClaims,
      ...privateEvents,
    ],
    evidence,
    tokenEstimate: estimateTokens(text.text),
    compressed: text.compressed,
    overBudget: text.overBudget,
    uncertainties: [...conflicts, ...uncertainEvents],
    refs: state.refs,
    trace: input.trace,
  }
}

interface SectionsInput {
  maxTokens: number
  query: string
  activeClaims: readonly MemoryCandidate[]
  unconfirmedClaims: readonly MemoryCandidate[]
  privateClaims: readonly MemoryCandidate[]
  privateEvents: readonly MemoryCandidate[]
  entities: readonly MemoryCandidate[]
  events: readonly MemoryCandidate[]
  historicalClaims: readonly MemoryCandidate[]
  relations: readonly string[]
  evidence: readonly Message[]
  restrictedEvidenceIds: ReadonlySet<MessageId>
  conflicts: readonly string[]
  uncertainEvents: readonly string[]
  dates: DateLookup
  described: ReadonlySet<string>
  time?: RetrievalTimeTrace
  state: RenderState
}

interface Rendered {
  text: string
  cost: number
}

function assemble(input: SectionsInput): {
  text: string
  compressed: boolean
  overBudget: boolean
} {
  const tokens = new Set(segment(input.query))
  const full = renderSections(input, FULL_DETAIL, tokens)
  if (full.cost <= input.maxTokens) {
    return { text: full.text, compressed: false, overBudget: false }
  }
  let best = renderSections(input, MIN_DETAIL, tokens)
  let low = 0
  let high = 1
  for (let step = 0; step < SCALE_STEPS; step += 1) {
    const scale = (low + high) / 2
    const candidate = renderSections(input, detailAt(scale), tokens)
    if (candidate.cost <= input.maxTokens) {
      best = candidate
      low = scale
    } else {
      high = scale
    }
  }
  return {
    text: best.text,
    compressed: true,
    overBudget: best.cost > input.maxTokens,
  }
}

function detailAt(scale: number): DetailLevel {
  const mix = (min: number, max: number): number => Math.round(min + (max - min) * scale)
  return {
    evidence: mix(MIN_DETAIL.evidence, FULL_DETAIL.evidence),
    summary: mix(MIN_DETAIL.summary, FULL_DETAIL.summary),
    description: mix(MIN_DETAIL.description, FULL_DETAIL.description),
    literal: mix(MIN_DETAIL.literal, FULL_DETAIL.literal),
  }
}

function renderSections(
  input: SectionsInput,
  detail: DetailLevel,
  tokens: ReadonlySet<string>,
): Rendered {
  const blocks: string[] = [
    '[Memory Contract]\n以下区块是本次检索到的记录。不要补充未出现的事实、日期、原因或状态。记录不完整时，按已有内容回答；没有记录时，说“没有记录”，不要推断“从未发生”。',
  ]
  const addSection = (header: string, lines: readonly string[]): void => {
    if (lines.length === 0) return
    blocks.push(`${header}\n${lines.join('\n')}`)
  }

  addSection('[Query Time]', queryTimeLines(input.time))
  addSection(
    '[Current Claims]',
    input.activeClaims.map((candidate) => claimLine(candidate, detail, input.state, input.dates)),
  )
  addSection(
    '[Unconfirmed]',
    input.unconfirmedClaims.map((candidate) =>
      claimLine(candidate, detail, input.state, input.dates, 'unconfirmed'),
    ),
  )
  addSection(
    '[Relevant Entities]',
    input.entities
      .map((candidate) => entityLine(candidate, detail, input.state, input.described))
      .filter((line) => line.length > 0),
  )
  addSection('[Unresolved Conflicts]', input.conflicts)
  addSection('[Uncertain Events]', input.uncertainEvents)
  addSection(
    '[Historical Events]',
    input.events.map((candidate) => eventLine(candidate, detail, tokens, input.state, input.dates)),
  )
  addSection(
    '[Historical Claims]',
    input.historicalClaims.map((candidate) =>
      claimLine(candidate, detail, input.state, input.dates),
    ),
  )
  addSection('[Memory Relations]', input.relations.slice(0, MAX_RELATIONS))
  const privateLines = [
    ...input.privateClaims.map((candidate) =>
      claimLine(candidate, detail, input.state, input.dates, 'private'),
    ),
    ...input.privateEvents.map((candidate) =>
      eventLine(candidate, detail, tokens, input.state, input.dates, 'private'),
    ),
    ...privateEntityLines(input.entities, detail, input.state),
  ]
  addSection(
    '[Private]',
    privateLines.length === 0 ? [] : ['仅在问题直接询问时引用，不要主动复述。', ...privateLines],
  )
  addSection(
    '[Evidence]',
    input.evidence
      .slice(0, MAX_EVIDENCE)
      .map((message) =>
        evidenceLine(message, detail, tokens, input.state, input.restrictedEvidenceIds),
      ),
  )
  const text = blocks.join('\n\n')
  return { text, cost: estimateTokens(text) }
}

function claimLine(
  candidate: MemoryCandidate,
  detail: DetailLevel,
  state: RenderState,
  dates: DateLookup,
  section: 'current' | 'history' | 'unconfirmed' | 'private' = 'current',
): string {
  if (candidate.record.kind !== 'claim') return ''
  const { claim, subject, objectEntity } = candidate.record
  const object =
    claim.object.kind === 'literal'
      ? truncate(claim.object.value, detail.literal)
      : (objectEntity?.name ?? '未知主体')
  const negative = claim.polarity === 'negative' ? '≠ ' : ''
  const date = dates.claims.get(claim.id) ?? null
  const recorded =
    date === null
      ? ''
      : `，${date.fromValidFrom ? '始于' : '记录于'} ${formatDate(date.at, state.timeZone)}`
  const privacy =
    section === 'private' ? `${privacyLabel(claim.sensitivity, claim.disclosure)}，` : ''
  const status =
    section === 'unconfirmed' || (section === 'private' && claim.modality !== 'asserted')
      ? `${privacy}${MODALITY_LABELS[claim.modality] ?? '未确认'}${recorded}`
      : `${privacy}${statusLabel(claim.status)}${recorded}`
  return `- [claim:${refOf(state, 'claim', claim.id)}] ${subject.name} ${claim.predicate} ${negative}${object}（${status}）`
}

function entityHasDetails(candidate: MemoryCandidate, described: ReadonlySet<string>): boolean {
  if (candidate.record.kind !== 'entity') return false
  const { entity, aliases } = candidate.record
  if (aliases.length > 0) return true
  if (entity.description === null) return false
  return isRestricted(restrictionOf(entity)) || !described.has(entity.id)
}

function entityLine(
  candidate: MemoryCandidate,
  detail: DetailLevel,
  state: RenderState,
  described: ReadonlySet<string>,
): string {
  if (candidate.record.kind !== 'entity') return ''
  const { entity, aliases } = candidate.record
  const details: string[] = []
  if (
    entity.description !== null &&
    !isRestricted(restrictionOf(entity)) &&
    !described.has(entity.id)
  ) {
    details.push(`${truncate(entity.description, detail.description)}（早期摘要，可能过时）`)
  }
  if (aliases.length > 0) {
    details.push(truncate(`别名：${aliases.join('、')}`, detail.description))
  }
  if (details.length === 0) return ''
  return `- [entity:${refOf(state, 'entity', entity.id)}] ${entity.name}（${entity.type}）：${details.join('；')}`
}

function eventLine(
  candidate: MemoryCandidate,
  detail: DetailLevel,
  tokens: ReadonlySet<string>,
  state: RenderState,
  dates: DateLookup,
  section: 'history' | 'private' = 'history',
): string {
  if (candidate.record.kind !== 'event') return ''
  const { event, participants } = candidate.record
  const mentioned = dates.events.get(event.id) ?? null
  const date =
    event.occurredAt === null
      ? mentioned === null
        ? '时间未知'
        : `时间未知（提及于 ${formatDate(mentioned, state.timeZone)}）`
      : formatDate(event.occurredAt, state.timeZone)
  const modality = event.modality
  const qualifier =
    MODALITY_LABELS[modality] === undefined ? '' : `（${MODALITY_LABELS[modality]}）`
  const privacy =
    section === 'private' ? `${privacyLabel(event.sensitivity, event.disclosure)}，` : ''
  const people = participants.map((item) => `${item.entity.name}（${item.role}）`).join('、')
  return `- [event:${refOf(state, 'event', event.id)}] ${privacy}${date} ${event.type}${qualifier}：${excerpt(event.summary, tokens, detail.summary)}${
    people.length > 0 ? `；参与者：${people}` : ''
  }`
}

function privateEntityLines(
  entities: readonly MemoryCandidate[],
  detail: DetailLevel,
  state: RenderState,
): string[] {
  return entities.flatMap((candidate) => {
    if (candidate.record.kind !== 'entity') return []
    const { entity, aliases } = candidate.record
    if (!isRestricted(restrictionOf(entity))) return []
    const details: string[] = []
    if (entity.description !== null) {
      details.push(truncate(entity.description, detail.description))
    }
    if (aliases.length > 0) {
      details.push(truncate(`别名：${aliases.join('、')}`, detail.description))
    }
    const suffix = details.length > 0 ? `：${details.join('；')}` : ''
    if (suffix.length === 0) return []
    return [
      `- [entity:${refOf(state, 'entity', entity.id)}] ${privacyLabel(entity.sensitivity, entity.disclosure)}${suffix}`,
    ]
  })
}

function privacyLabel(sensitivity: MemorySensitivity, disclosure: MemoryDisclosure): string {
  if (disclosure === 'alias_only') return '仅用别名'
  if (disclosure === 'do_not_volunteer') return sensitivity === 'private' ? '私密' : '不主动提及'
  return '私密'
}

function evidenceLine(
  message: Message,
  detail: DetailLevel,
  tokens: ReadonlySet<string>,
  state: RenderState,
  restrictedIds: ReadonlySet<MessageId>,
): string {
  const date = formatDate(message.occurredAt, state.timeZone)
  const marker = restrictedIds.has(message.id) ? '私密原文 ' : ''
  return `- [message:${refOf(state, 'message', message.id)}] ${date} ${marker}${message.speakerId}：${excerpt(message.content, tokens, detail.evidence)}`
}

function refOf(state: RenderState, kind: MemoryRef['kind'], id: string): string {
  if (state.idMode === 'full') return id
  for (const [ref, value] of Object.entries(state.refs)) {
    if (value.kind === kind && value.id === id) return ref
  }
  state.next[kind] += 1
  const ref = `${REF_PREFIX[kind]}${state.next[kind]}`
  state.refs[ref] = { kind, id }
  return ref
}

function collectDates(db: Database, candidates: readonly MemoryCandidate[]): DateLookup {
  const ids = new Set<MessageId>()
  for (const candidate of candidates) {
    for (const id of candidate.evidenceMessageIds) ids.add(id)
    if (ids.size >= 600) break
  }
  const messages = ids.size === 0 ? [] : getMessagesByIds(db, [...ids].slice(0, 600))
  const byId = new Map(messages.map((message) => [String(message.id), message.occurredAt]))
  const earliest = (evidenceIds: readonly MessageId[]): number | null => {
    let min: number | null = null
    for (const id of evidenceIds) {
      const occurredAt = byId.get(String(id))
      if (occurredAt === undefined) continue
      if (min === null || occurredAt < min) min = occurredAt
    }
    return min
  }
  const claims = new Map<string, ClaimDate | null>()
  const events = new Map<string, number | null>()
  for (const candidate of candidates) {
    if (candidate.record.kind === 'claim') {
      const claim = candidate.record.claim
      claims.set(
        claim.id,
        claim.validFrom === null
          ? claimDate(earliest(candidate.evidenceMessageIds), false)
          : { at: claim.validFrom, fromValidFrom: true },
      )
    } else if (candidate.record.kind === 'event') {
      events.set(candidate.record.event.id, earliest(candidate.evidenceMessageIds))
    }
  }
  return { claims, events }
}

function claimDate(at: number | null, fromValidFrom: boolean): ClaimDate | null {
  return at === null ? null : { at, fromValidFrom }
}

function describedEntities(candidates: readonly MemoryCandidate[]): Set<string> {
  const described = new Set<string>()
  for (const candidate of candidates) {
    if (isRestricted(candidateRestriction(candidate))) continue
    if (candidate.record.kind === 'claim') {
      described.add(candidate.record.claim.subjectId)
      if (candidate.record.claim.object.kind === 'entity') {
        described.add(candidate.record.claim.object.entityId)
      }
    } else if (candidate.record.kind === 'event') {
      for (const participant of candidate.record.participants) {
        described.add(participant.entity.id)
      }
    }
  }
  return described
}

function collectConflicts(
  claims: readonly MemoryCandidate[],
  dates: DateLookup,
  timeZone: string,
): string[] {
  const groups = new Map<
    string,
    { subject: string; predicate: string; values: Map<string, ClaimDate | null> }
  >()
  for (const candidate of claims) {
    if (candidate.record.kind !== 'claim') continue
    const { claim, subject, objectEntity } = candidate.record
    if (
      claim.status !== 'active' ||
      claim.modality !== 'asserted' ||
      claim.polarity !== 'positive'
    ) {
      continue
    }
    const value =
      claim.object.kind === 'literal' ? claim.object.value.trim() : (objectEntity?.name ?? '')
    if (value.length === 0) continue
    const key = `${claim.subjectId}\n${claim.predicate.trim().toLowerCase()}`
    const group = groups.get(key) ?? {
      subject: subject.name,
      predicate: claim.predicate,
      values: new Map(),
    }
    if (!group.values.has(value)) {
      group.values.set(value, dates.claims.get(claim.id) ?? null)
    }
    groups.set(key, group)
  }
  const lines: string[] = []
  for (const group of groups.values()) {
    if (group.values.size < 2) continue
    const parts = [...group.values.entries()].map(([value, date]) =>
      date === null
        ? value
        : `${value}（${date.fromValidFrom ? '始于' : '记录于'} ${formatDate(date.at, timeZone)}）`,
    )
    lines.push(
      `- ${group.subject} ${group.predicate}：${parts.join('；')}。记录未判定哪个正确，不要自行选择。`,
    )
  }
  return lines.slice(0, 8)
}

function claimModalityOf(candidate: MemoryCandidate): MemoryModality | null {
  return candidate.record.kind === 'claim' ? candidate.record.claim.modality : null
}

function candidateRestriction(candidate: MemoryCandidate): Restriction {
  switch (candidate.record.kind) {
    case 'claim':
      return restrictionOf(candidate.record.claim)
    case 'event':
      return restrictionOf(candidate.record.event)
    case 'entity':
      return restrictionOf(candidate.record.entity)
    default:
      return { sensitivity: 'normal', disclosure: 'allowed' }
  }
}

function collectRestrictedEvidenceIds(
  claims: readonly MemoryCandidate[],
  events: readonly MemoryCandidate[],
): Set<MessageId> {
  const ids = new Set<MessageId>()
  for (const candidate of [...claims, ...events]) {
    if (!isRestricted(candidateRestriction(candidate))) continue
    for (const id of candidate.evidenceMessageIds) ids.add(id)
  }
  return ids
}

function comparePrivateClaims(left: MemoryCandidate, right: MemoryCandidate): number {
  return privateClaimRank(left) - privateClaimRank(right)
}

function privateClaimRank(candidate: MemoryCandidate): number {
  if (candidate.record.kind !== 'claim') return 3
  const claim = candidate.record.claim
  if (claim.status !== 'active') return 2
  return claim.modality === 'asserted' ? 0 : 1
}

function collectUncertainEvents(
  events: readonly MemoryCandidate[],
  dates: DateLookup,
  timeZone: string,
): string[] {
  const lines: string[] = []
  for (const candidate of events) {
    if (candidate.record.kind !== 'event') continue
    const { event } = candidate.record
    if (event.modality !== 'uncertain') continue
    const date = dates.events.get(event.id) ?? null
    lines.push(
      `- ${date === null ? '时间未知' : formatDate(date, timeZone)} 事件来自不确定陈述：${event.summary}`,
    )
  }
  return lines.slice(0, 8)
}

function compareEvents(left: MemoryCandidate, right: MemoryCandidate): number {
  if (left.record.kind !== 'event' || right.record.kind !== 'event') return 0
  const leftAt = left.record.event.occurredAt
  const rightAt = right.record.event.occurredAt
  if (leftAt === null && rightAt === null) return 0
  if (leftAt === null) return 1
  if (rightAt === null) return -1
  return leftAt - rightAt
}

function collectRelations(candidates: readonly MemoryCandidate[], state: RenderState): string[] {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    for (const relation of candidate.relations) {
      seen.add(
        relation.direction === 'outgoing'
          ? `- ${relationRef(candidate.key, state)} --${relation.relation}--> ${relationRef(`${relation.targetKind}:${relation.targetId}`, state)}`
          : `- ${relationRef(`${relation.targetKind}:${relation.targetId}`, state)} --${relation.relation}--> ${relationRef(candidate.key, state)}`,
      )
    }
  }
  return [...seen]
}

function relationRef(key: string, state: RenderState): string {
  const separator = key.indexOf(':')
  if (separator === -1) return key
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (kind !== 'claim' && kind !== 'entity' && kind !== 'event') return key
  return `${kind}:${refOf(state, kind, id)}`
}

function collectEvidence(
  db: Database,
  spaceId: MemorySpaceId,
  candidates: readonly MemoryCandidate[],
  query: string,
): Message[] {
  const ids = new Set<MessageId>()
  for (const candidate of candidates) {
    for (const id of candidate.evidenceMessageIds) ids.add(id)
    for (const id of candidate.closureEvidenceMessageIds) ids.add(id)
    if (ids.size >= 120) break
  }
  const messages = getMessagesByIds(db, [...ids].slice(0, 120))
  const byId = new Map(messages.map((message) => [message.id, message]))
  const queryTokens = new Set(segment(query))
  const scored = (messageIds: readonly MessageId[]): Array<{ message: Message; score: number }> =>
    messageIds
      .flatMap((id) => {
        const message = byId.get(asMessageId(id))
        return message === undefined || message.memorySpaceId !== spaceId ? [] : [message]
      })
      .map((message) => ({ message, score: overlapScore(message, queryTokens) }))
      .toSorted((left, right) => {
        if (left.score !== right.score) return right.score - left.score
        return right.message.occurredAt - left.message.occurredAt
      })
  const prepared = candidates.map((candidate) => {
    const perCandidateLimit = candidate.kind === 'chunk' ? 3 : 4
    const linked = candidate.kind === 'claim' || candidate.kind === 'event'
    const closure = scored(candidate.closureEvidenceMessageIds).slice(0, 1)
    return {
      messages: [...closure, ...scored(candidate.evidenceMessageIds)],
      perCandidateLimit,
      linked,
    }
  })
  const chosen: Message[] = []
  const seen = new Set<string>()
  const take = (onlyMatching: boolean): void => {
    const cursors = prepared.map(() => 0)
    const added = prepared.map(() => 0)
    let progress = true
    while (progress && chosen.length < MAX_EVIDENCE) {
      progress = false
      for (const [index, item] of prepared.entries()) {
        if (chosen.length >= MAX_EVIDENCE) return
        if ((added[index] ?? 0) >= item.perCandidateLimit) continue
        while ((cursors[index] ?? 0) < item.messages.length) {
          const cursor = cursors[index] ?? 0
          const entry = item.messages[cursor]
          cursors[index] = cursor + 1
          if (entry === undefined) break
          if (onlyMatching && entry.score === 0 && !item.linked) continue
          if (seen.has(entry.message.id)) continue
          seen.add(entry.message.id)
          chosen.push(entry.message)
          added[index] = (added[index] ?? 0) + 1
          progress = true
          break
        }
      }
    }
  }
  take(true)
  const initial = chosen.slice()
  for (const message of initial) {
    if (chosen.length >= MAX_EVIDENCE) break
    for (const index of [message.messageIndex - 1, message.messageIndex + 1]) {
      if (chosen.length >= MAX_EVIDENCE) break
      if (index < 0) continue
      const neighbor = listMessages(db, {
        memorySpaceId: spaceId,
        conversationId: message.conversationId,
        fromIndex: index,
        toIndex: index,
        limit: 1,
      })[0]
      if (neighbor === undefined || seen.has(neighbor.id)) continue
      seen.add(neighbor.id)
      chosen.push(neighbor)
    }
  }
  take(false)
  return chosen.toSorted((left, right) => left.occurredAt - right.occurredAt)
}

function overlapScore(message: Message, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0
  let score = 0
  for (const token of segment(message.content)) {
    if (queryTokens.has(token)) score += 1
  }
  return score
}

const CLAIM_STATUS_LABELS: Record<Claim['status'], string> = {
  active: '当前有效',
  superseded: '已被取代',
  disputed: '存在冲突',
  retracted: '已撤回',
  invalid: '无效',
}

function statusLabel(status: Claim['status']): string {
  return CLAIM_STATUS_LABELS[status]
}

function queryTimeLines(time: RetrievalTimeTrace | undefined): string[] {
  if (time === undefined) return []
  const window = time.windows[0]
  if (window === undefined) return []
  const start = formatDay(window.from, time.timeZone)
  const end = formatDay(window.to - 1, time.timeZone)
  const range = start === end ? formatDate(window.from, time.timeZone) : `${start} 至 ${end}`
  return [`- ${range}（${window.text}${window.approximate ? '，约' : ''}）`]
}

function formatDay(seconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(seconds * 1000))
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function formatDate(seconds: number, timeZone: string): string {
  const date = new Date(seconds * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? ''
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(date)
  return `${part('year')}-${part('month')}-${part('day')}（${weekday}）`
}
