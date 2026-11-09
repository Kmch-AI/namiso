import type { EntityResolver } from '../annotation/entity-resolver.ts'
import type { EmbeddingProvider, RerankerProvider } from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type { VectorStore } from '../storage/vector-store.ts'
import type {
  CandidateRecord,
  Entity,
  MemoryCandidate,
  MemorySourceType,
  MemorySpaceId,
  QueryAspect,
  RetrievalChannel,
  RetrievalTimeRange,
  RetrievalTrace,
  RetrieveResult,
  TimeWindow,
} from '../types.ts'
import type { ParsedQuery } from './query-parser.ts'

import { asDocumentId, asMessageId, newId, nowSeconds } from '../ids.ts'
import { getMessagesByIds, latestUserSpeakerId } from '../storage/conversation-repo.ts'
import {
  listClaimsForEntities,
  listEventsForEntities,
  listRecentEvents,
} from '../storage/memory-repo.ts'
import { getDocument, searchFts, searchFtsNgrams } from '../storage/search-repo.ts'
import { segment, toNgramQuery } from '../text.ts'
import {
  candidateFromSource,
  claimCandidate,
  eventCandidate,
  messageCandidate,
} from './candidates.ts'
import { selectWithCoverage } from './coverage.ts'
import { analyzeQuery } from './query-analysis.ts'
import { parseQuery } from './query-parser.ts'
import { resolveTimeExpressions } from './time-expression.ts'

export interface RetrieveOptions {
  memorySpaceId: MemorySpaceId
  query: string
  entityIds?: readonly string[]
  memoryTypes?: readonly ('conversation' | 'entity' | 'claim' | 'event')[]
  timeRange?: RetrievalTimeRange
  topK?: number
  rerank?: boolean
  rerankPool?: number
  includeEvidence?: boolean
  includeRelations?: boolean
  now?: number
  timeZone?: string
}

interface ChannelResult {
  channel: RetrievalChannel
  items: MemoryCandidate[]
}

const RRF_K = 60
const CANDIDATES_PER_CHANNEL = 80
const SOURCE_EVIDENCE_POOL = 8
const RERANK_POOL_LIMIT = 50
const TIME_BOOST = 0.1
const FTS_STAGE_MIN = 3
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export class Retriever {
  private readonly db: Database
  private readonly vectors: VectorStore
  private readonly embedding: EmbeddingProvider
  private readonly reranker: RerankerProvider
  private readonly resolver: EntityResolver

  constructor(
    db: Database,
    vectors: VectorStore,
    embedding: EmbeddingProvider,
    reranker: RerankerProvider,
    resolver: EntityResolver,
  ) {
    this.db = db
    this.vectors = vectors
    this.embedding = embedding
    this.reranker = reranker
    this.resolver = resolver
  }

  async retrieve(options: RetrieveOptions): Promise<RetrieveResult> {
    const started = performance.now()
    const query = options.query.trim()
    if (query.length === 0) {
      throw new Error('query cannot be empty')
    }
    const parsed = parseQuery(query)
    const analysis = analyzeQuery(query)
    const queryTokens = new Set(segment(query))
    const now = options.now ?? nowSeconds()
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
    const windows = resolveTimeExpressions(query, now, timeZone)
    const notes: string[] = []
    const mentioned = this.resolveMentioned(options.memorySpaceId, query, options.entityIds)
    const allowed = allowedKinds(options.memoryTypes)
    const sqlItems = this.sqlChannel(
      options,
      parsed,
      analysis.aspects,
      mentioned.entities,
      queryTokens,
      windows,
    ).filter((item) => allowed.has(item.kind))
    const ftsItems = this.ftsChannel(options.memorySpaceId, query, allowed, notes)
    let vectorItems: MemoryCandidate[] = []
    let facetItems: MemoryCandidate[] = []
    try {
      const texts = [query, ...analysis.facets.map((facet) => facet.text)]
      const vectors = await this.embedding.embed(texts)
      const raw = vectors[0]
      if (raw !== undefined) {
        vectorItems = this.searchVector(options.memorySpaceId, raw).filter((item) =>
          allowed.has(item.kind),
        )
      }
      if (analysis.facets.length > 0) {
        facetItems = this.facetChannel(options.memorySpaceId, vectors.slice(1), allowed)
      }
    } catch (error) {
      notes.push(`向量召回不可用：${error instanceof Error ? error.message : String(error)}`)
    }

    const channelResults: ChannelResult[] = [
      { channel: 'sql', items: sqlItems },
      { channel: 'fts', items: ftsItems },
      { channel: 'vector', items: vectorItems },
      ...(analysis.facets.length === 0 ? [] : [{ channel: 'facet' as const, items: facetItems }]),
    ]
    const fused = this.fuse(channelResults)
    const validated = this.validate(fused, parsed, analysis.aspects, options.timeRange)
    notes.push(...validated.notes)
    const topK = Math.max(1, Math.min(options.topK ?? 10, 50))
    const rerank = options.rerank !== false
    const rerankPool = Math.max(
      1,
      Math.min(options.rerankPool ?? RERANK_POOL_LIMIT, RERANK_POOL_LIMIT),
    )
    const ranked = await this.rank(query, validated.candidates, rerank, rerankPool, notes, windows)
    const renderable = ranked.filter((candidate) => isRenderableKind(candidate.kind))
    const sourceOnly = ranked.filter((candidate) => !isRenderableKind(candidate.kind))
    const coverage = selectWithCoverage(renderable, {
      topK,
      facets: analysis.facets,
      entityIds: mentioned.coverageIds,
    })
    const selected = [...coverage.selected]
    if (selected.length < topK) {
      selected.push(...sourceOnly.slice(0, topK - selected.length))
      notes.push('可渲染记录不足，已用原始对话补足 topK。')
    }
    const sources =
      options.includeRelations === false ? [] : sourceOnly.slice(0, SOURCE_EVIDENCE_POOL)
    const expansion =
      options.includeRelations === false
        ? { items: [], count: 0 }
        : this.expand(options.memorySpaceId, selected, options.includeEvidence === true, sources)
    const merged = new Map<string, MemoryCandidate>()
    for (const candidate of [...selected, ...expansion.items, ...sources]) {
      if (!merged.has(candidate.key)) merged.set(candidate.key, candidate)
    }
    const resultCandidates = [...merged.values()].toSorted(
      (left, right) => right.score - left.score,
    )
    const trace: RetrievalTrace = {
      id: newId(),
      query,
      intent: parsed.intent,
      entityIds: mentioned.entities.map((entity) => entity.id),
      channels: channelResults.map((result) => ({
        channel: result.channel,
        count: result.items.length,
        topKeys: result.items.slice(0, 5).map((candidate) => candidate.key),
      })),
      fusedCount: fused.length,
      rerankedCount: rerank ? Math.min(validated.candidates.length, rerankPool) : 0,
      expandedCount: expansion.count,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      notes,
      aspects: analysis.aspects,
      ...(analysis.facets.length === 0
        ? {}
        : { facets: analysis.facets.map((facet) => facet.text) }),
      coverage: coverage.trace,
      ...(windows.length === 0 ? {} : { time: { now, timeZone, windows } }),
    }
    return { candidates: resultCandidates, total: fused.length, trace }
  }

  private resolveMentioned(
    spaceId: MemorySpaceId,
    query: string,
    entityIds: readonly string[] | undefined,
  ): { entities: Entity[]; coverageIds: string[] } {
    if (entityIds !== undefined && entityIds.length > 0) {
      const resolved: Entity[] = []
      for (const id of entityIds) {
        const entity = candidateFromSource(this.db, spaceId, 'entity', id)
        if (entity?.record.kind === 'entity') {
          resolved.push(entity.record.entity)
        }
      }
      return { entities: resolved, coverageIds: resolved.map((entity) => entity.id) }
    }
    const named = this.resolver.findMentioned(spaceId, query, 5)
    const coverageIds = named.map((entity) => entity.id)
    const mentioned = [...named]
    if (/你|您|you\b|your\b/i.test(query)) {
      const self = this.resolver.self(spaceId)
      if (self !== null && !mentioned.some((entity) => entity.id === self.id)) {
        mentioned.unshift(self)
      }
    }
    if (!/我|I\b|my\b/i.test(query)) return { entities: mentioned, coverageIds }
    const speakerId = latestUserSpeakerId(this.db, spaceId)
    if (speakerId === null) return { entities: mentioned, coverageIds }
    const speaker = this.resolver.findSpeaker(spaceId, speakerId)
    if (speaker === null || mentioned.some((entity) => entity.id === speaker.id)) {
      return { entities: mentioned, coverageIds }
    }
    return { entities: [speaker, ...mentioned], coverageIds }
  }

  private sqlChannel(
    options: RetrieveOptions,
    parsed: ParsedQuery,
    aspects: readonly QueryAspect[],
    mentioned: readonly Entity[],
    queryTokens: ReadonlySet<string>,
    windows: readonly TimeWindow[],
  ): MemoryCandidate[] {
    const spaceId = options.memorySpaceId
    const includeInactive =
      parsed.wantsHistory || aspects.includes('change') || !parsed.wantsCurrent
    const wantsEvents =
      aspects.includes('event_time') ||
      aspects.includes('history') ||
      aspects.includes('change') ||
      windows.length > 0
    const entityIds = mentioned.map((entity) => entity.id)
    const entities = mentioned.flatMap((entity) => {
      const candidate = candidateFromSource(this.db, spaceId, 'entity', entity.id)
      return candidate === null ? [] : [candidate]
    })
    const claims =
      entityIds.length === 0
        ? []
        : listClaimsForEntities(this.db, spaceId, entityIds, {
            includeInactive,
            limit: 80,
          })
    const claimItems = claims.flatMap((claim) => {
      const candidate = claimCandidate(this.db, claim)
      return candidate === null ? [] : [candidate]
    })
    const events =
      entityIds.length === 0
        ? wantsEvents
          ? listRecentEvents(this.db, spaceId, 20)
          : []
        : listEventsForEntities(this.db, spaceId, entityIds, {
            includeInactive,
            limit: 60,
            ...(options.timeRange?.from === undefined ? {} : { from: options.timeRange.from }),
            ...(options.timeRange?.to === undefined ? {} : { to: options.timeRange.to }),
          })
    const eventItems = events.flatMap((event) => {
      const candidate = eventCandidate(this.db, event)
      return candidate === null ? [] : [candidate]
    })
    const rankedClaims = rankStructured(claimItems, queryTokens, parsed, windows)
    const rankedEvents = rankStructured(eventItems, queryTokens, parsed, windows)
    const ordered =
      parsed.intent === 'entity'
        ? [...entities, ...rankedClaims, ...rankedEvents]
        : [...rankedClaims, ...entities, ...rankedEvents]
    const items = new Map<string, MemoryCandidate>()
    for (const candidate of ordered) {
      if (!items.has(candidate.key)) items.set(candidate.key, candidate)
    }
    return [...items.values()].slice(0, CANDIDATES_PER_CHANNEL)
  }

  private ftsChannel(
    spaceId: MemorySpaceId,
    query: string,
    allowed: ReadonlySet<CandidateRecord['kind']>,
    notes: string[],
  ): MemoryCandidate[] {
    const word = this.ftsHits(spaceId, query, allowed)
    if (word.length >= FTS_STAGE_MIN) return word
    if (toNgramQuery(query).length === 0) return word
    notes.push('FTS 词级命中不足，已尝试 CJK 二元组检索。')
    const seen = new Set(word.map((item) => item.key))
    const merged = [...word]
    for (const hit of searchFtsNgrams(this.db, spaceId, query, 30, ftsKinds(allowed))) {
      if (merged.length >= CANDIDATES_PER_CHANNEL) break
      const item = candidateFromSource(this.db, spaceId, hit.kind, hit.sourceId)
      if (item === null || seen.has(item.key) || !allowed.has(item.kind)) continue
      item.score = hit.score
      seen.add(item.key)
      merged.push(item)
    }
    return merged
  }

  private ftsHits(
    spaceId: MemorySpaceId,
    query: string,
    allowed: ReadonlySet<CandidateRecord['kind']>,
  ): MemoryCandidate[] {
    const items = new Map<string, MemoryCandidate>()
    for (const hit of searchFts(this.db, spaceId, query, 30, ftsKinds(allowed))) {
      const item = candidateFromSource(this.db, spaceId, hit.kind, hit.sourceId)
      if (item === null || items.has(item.key) || !allowed.has(item.kind)) continue
      item.score = hit.score
      items.set(item.key, item)
    }
    return [...items.values()].slice(0, CANDIDATES_PER_CHANNEL)
  }

  private searchVector(spaceId: MemorySpaceId, vector: readonly number[]): MemoryCandidate[] {
    const hits = this.vectors.search(vector, spaceId, 40)
    const items = new Map<string, MemoryCandidate>()
    for (const hit of hits) {
      const document = getDocument(this.db, asDocumentId(hit.documentId))
      if (document === null || document.memorySpaceId !== spaceId) continue
      const item = candidateFromSource(this.db, spaceId, document.sourceType, document.sourceId)
      if (item === null || items.has(item.key)) continue
      item.score = hit.score
      items.set(item.key, item)
    }
    return [...items.values()].slice(0, CANDIDATES_PER_CHANNEL)
  }

  private facetChannel(
    spaceId: MemorySpaceId,
    vectors: readonly (readonly number[])[],
    allowed: ReadonlySet<CandidateRecord['kind']>,
  ): MemoryCandidate[] {
    const best = new Map<string, { item: MemoryCandidate; rank: number }>()
    for (const vector of vectors) {
      for (const [rank, item] of this.searchVector(spaceId, vector).entries()) {
        if (!allowed.has(item.kind)) continue
        const existing = best.get(item.key)
        if (existing === undefined || rank < existing.rank) {
          best.set(item.key, { item, rank })
        }
      }
    }
    return [...best.values()]
      .toSorted((left, right) => left.rank - right.rank)
      .slice(0, CANDIDATES_PER_CHANNEL)
      .map((entry) => entry.item)
  }

  private fuse(results: readonly ChannelResult[]): MemoryCandidate[] {
    const merged = new Map<
      string,
      { candidate: MemoryCandidate; score: number; channels: Set<RetrievalChannel> }
    >()
    for (const result of results) {
      const seen = new Set<string>()
      for (const [rank, candidate] of result.items.entries()) {
        if (seen.has(candidate.key)) continue
        seen.add(candidate.key)
        const existing = merged.get(candidate.key)
        const contribution = 1 / (RRF_K + rank + 1)
        if (existing === undefined) {
          merged.set(candidate.key, {
            candidate: { ...candidate, channels: [], score: 0 },
            score: contribution,
            channels: new Set([result.channel]),
          })
          continue
        }
        existing.score += contribution
        existing.channels.add(result.channel)
      }
    }
    const fused: MemoryCandidate[] = []
    for (const entry of merged.values()) {
      entry.candidate.score = entry.score
      entry.candidate.channels = [...entry.channels]
      fused.push(entry.candidate)
    }
    return fused.toSorted((left, right) => right.score - left.score)
  }

  private validate(
    candidates: readonly MemoryCandidate[],
    parsed: ParsedQuery,
    aspects: readonly QueryAspect[],
    timeRange: RetrievalTimeRange | undefined,
  ): { candidates: MemoryCandidate[]; notes: string[] } {
    const notes: string[] = []
    const kept: MemoryCandidate[] = []
    const keepInactive = aspects.includes('change')
    for (const candidate of candidates) {
      if (
        parsed.wantsCurrent &&
        !keepInactive &&
        candidate.kind === 'claim' &&
        candidate.status !== 'active'
      ) {
        continue
      }
      if (
        timeRange !== undefined &&
        (candidate.kind === 'event' || candidate.kind === 'claim') &&
        candidate.occurredAt !== null
      ) {
        if (timeRange.from !== undefined && candidate.occurredAt < timeRange.from) continue
        if (timeRange.to !== undefined && candidate.occurredAt > timeRange.to) continue
      }
      kept.push(candidate)
    }
    const conflicts = new Map<string, Set<string>>()
    for (const candidate of kept) {
      if (candidate.record.kind !== 'claim') continue
      const claim = candidate.record.claim
      if (claim.status !== 'active') continue
      const key = `${claim.subjectId}:${claim.predicate}`
      const values = conflicts.get(key) ?? new Set<string>()
      values.add(claim.object.kind === 'literal' ? claim.object.value : claim.object.entityId)
      conflicts.set(key, values)
    }
    for (const [key, values] of conflicts) {
      if (values.size > 1) {
        notes.push(`存在多个同时有效的事实声明（${key}），需要确认冲突。`)
      }
    }
    for (const candidate of kept) {
      if (candidate.record.kind !== 'event') continue
      const modality = candidate.record.event.metadata?.['modality']
      if (modality === 'uncertain') {
        notes.push(`事件 ${candidate.record.event.id} 来自不确定陈述。`)
      }
    }
    return { candidates: kept, notes: notes.slice(0, 10) }
  }

  private async rank(
    query: string,
    candidates: readonly MemoryCandidate[],
    rerank: boolean,
    rerankPool: number,
    notes: string[],
    windows: readonly TimeWindow[],
  ): Promise<MemoryCandidate[]> {
    const maxRrf = candidates[0]?.score ?? 1
    const pool = candidates.slice(0, RERANK_POOL_LIMIT)
    const rerankCount = Math.min(rerankPool, pool.length)
    let scores: Map<number, number> | null = null
    if (rerank && rerankCount > 0) {
      try {
        const reranked = await this.reranker.rerank({
          query,
          documents: pool
            .slice(0, rerankCount)
            .map((candidate) => `${candidate.title}\n${candidate.text}`),
        })
        if (isDegenerate(reranked)) {
          notes.push('Reranker 分数无区分度，保留 RRF 排序。')
        } else {
          scores = new Map(reranked.map((item) => [item.index, item.score]))
        }
      } catch (error) {
        notes.push(
          `Reranker 不可用，保留 RRF 排序：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    for (const [index, entry] of pool.entries()) {
      const relevance = index < rerankCount ? scores?.get(index) : undefined
      const normalizedRrf = maxRrf === 0 ? 0 : entry.score / maxRrf
      const base =
        relevance === undefined
          ? normalizedRrf
          : Math.max(0, Math.min(1, relevance)) * 0.7 + normalizedRrf * 0.3
      entry.score = base + (inTimeWindow(entry.occurredAt, windows) ? TIME_BOOST : 0)
    }
    return pool.toSorted((left, right) => right.score - left.score)
  }

  private expand(
    spaceId: MemorySpaceId,
    selected: readonly MemoryCandidate[],
    includeEvidence: boolean,
    sourcePool: readonly MemoryCandidate[] = [],
  ): { items: MemoryCandidate[]; count: number } {
    const seen = new Set(selected.map((candidate) => candidate.key))
    const extras = new Map<string, MemoryCandidate>()
    const queue: Array<{ candidate: MemoryCandidate; depth: number }> = selected
      .slice(0, 5)
      .map((candidate) => ({ candidate, depth: 0 }))
    while (queue.length > 0 && extras.size < 30) {
      const current = queue.shift()
      if (current === undefined) break
      for (const relation of current.candidate.relations) {
        if (extras.size >= 30) break
        if (!isExpandableKind(relation.targetKind)) continue
        const key = `${relation.targetKind}:${relation.targetId}`
        if (seen.has(key)) continue
        const target = candidateFromSource(this.db, spaceId, relation.targetKind, relation.targetId)
        if (target === null) continue
        seen.add(key)
        target.channels = ['graph']
        target.score = current.candidate.score * 0.8
        extras.set(key, target)
        if (current.depth < 1) queue.push({ candidate: target, depth: current.depth + 1 })
      }
      if (current.candidate.record.kind === 'event' && extras.size < 30) {
        const participant = current.candidate.record.participants[0]
        if (participant !== undefined) {
          const timeline = listEventsForEntities(this.db, spaceId, [participant.entity.id], {
            limit: 4,
          })
          for (const event of timeline) {
            const key = `event:${event.id}`
            if (seen.has(key) || extras.size >= 30) continue
            const candidate = eventCandidate(this.db, event)
            if (candidate === null) continue
            seen.add(key)
            candidate.channels = ['timeline']
            candidate.score = current.candidate.score * 0.7
            extras.set(key, candidate)
          }
        }
      }
    }
    if (includeEvidence) {
      const evidenceIds = new Set<string>()
      for (const candidate of [...selected, ...sourcePool]) {
        for (const id of candidate.evidenceMessageIds) evidenceIds.add(id)
      }
      const messages = getMessagesByIds(this.db, [...evidenceIds].slice(0, 20).map(asMessageId))
      for (const message of messages) {
        const candidate = messageCandidate(message)
        if (seen.has(candidate.key) || extras.size >= 40) continue
        candidate.channels = ['graph']
        candidate.score = 0.1
        extras.set(candidate.key, candidate)
      }
    }
    return { items: [...extras.values()], count: extras.size }
  }
}

function rankStructured(
  items: readonly MemoryCandidate[],
  queryTokens: ReadonlySet<string>,
  parsed: ParsedQuery,
  windows: readonly TimeWindow[],
): MemoryCandidate[] {
  return items
    .map((item) => ({
      item,
      score: structuredRelevance(item, queryTokens, parsed, windows),
    }))
    .toSorted((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      const leftAt = left.item.occurredAt ?? 0
      const rightAt = right.item.occurredAt ?? 0
      if (leftAt !== rightAt) return rightAt - leftAt
      return left.item.key.localeCompare(right.item.key)
    })
    .map((entry) => entry.item)
}

function structuredRelevance(
  item: MemoryCandidate,
  queryTokens: ReadonlySet<string>,
  parsed: ParsedQuery,
  windows: readonly TimeWindow[],
): number {
  let score = 0
  for (const token of segment(`${item.title}\n${item.text}`)) {
    if (queryTokens.has(token)) score += 1
  }
  if (item.status === 'active' && (parsed.wantsCurrent || parsed.intent === 'general')) {
    score += 0.25
  }
  if (parsed.intent === 'event' && item.kind === 'event') score += 0.5
  if (parsed.intent === 'entity' && item.kind === 'entity') score += 0.5
  if (inTimeWindow(item.occurredAt, windows)) score += 0.5
  return score
}

function inTimeWindow(occurredAt: number | null, windows: readonly TimeWindow[]): boolean {
  if (occurredAt === null) return false
  return windows.some((window) => occurredAt >= window.from && occurredAt < window.to)
}

function allowedKinds(
  memoryTypes: readonly ('conversation' | 'entity' | 'claim' | 'event')[] | undefined,
): Set<CandidateRecord['kind']> {
  if (memoryTypes === undefined) {
    return new Set(['chunk', 'message', 'entity', 'claim', 'event'])
  }
  const kinds = new Set<CandidateRecord['kind']>()
  for (const type of memoryTypes) {
    if (type === 'conversation') {
      kinds.add('chunk')
      kinds.add('message')
    } else {
      kinds.add(type)
    }
  }
  return kinds
}

function isRenderableKind(kind: CandidateRecord['kind']): boolean {
  return kind === 'entity' || kind === 'claim' || kind === 'event'
}

function isExpandableKind(kind: string): kind is 'entity' | 'claim' | 'event' {
  return kind === 'entity' || kind === 'claim' || kind === 'event'
}

const FTS_SOURCE_TYPES: readonly MemorySourceType[] = ['chunk', 'entity', 'claim', 'event']

function ftsKinds(allowed: ReadonlySet<CandidateRecord['kind']>): MemorySourceType[] {
  return FTS_SOURCE_TYPES.filter((kind) => allowed.has(kind))
}

function isDegenerate(scores: readonly { score: number }[]): boolean {
  if (scores.length < 2) return true
  let min = Infinity
  let max = -Infinity
  for (const item of scores) {
    if (!Number.isFinite(item.score)) return true
    min = Math.min(min, item.score)
    max = Math.max(max, item.score)
  }
  return max <= 1e-9 || max - min <= 1e-9
}
