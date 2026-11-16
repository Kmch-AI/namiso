import type { EntityResolver } from '../annotation/entity-resolver.ts'
import type {
  EmbeddingProvider,
  EvidenceJudgeProvider,
  RerankerProvider,
} from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type { VectorStore } from '../storage/vector-store.ts'
import type {
  CandidateRecord,
  Entity,
  Event,
  MemoryCandidate,
  MemorySourceType,
  MemorySpaceId,
  RetrievalChannel,
  RetrievalTimeRange,
  RetrievalTrace,
  RetrieveResult,
  TimeWindow,
} from '../types.ts'

import { asDocumentId, asMessageId, newId, nowSeconds } from '../ids.ts'
import { getMessagesByIds, latestUserSpeakerId } from '../storage/conversation-repo.ts'
import {
  listClaimsForEntities,
  listEntities,
  listEvents,
  listEventsForEntities,
  listEventsForEntity,
  listRecentEvents,
  listUpcomingEvents,
} from '../storage/memory-repo.ts'
import { getDocument, searchFts, searchFtsNgrams } from '../storage/search-repo.ts'
import { segment, toNgramTerms } from '../text.ts'
import { dayKey, dayStart } from '../time.ts'
import {
  candidateFromSource,
  claimCandidate,
  eventCandidate,
  messageCandidate,
} from './candidates.ts'
import { selectWithCoverage } from './coverage.ts'
import { analyzeQuery, type QueryAnalysis } from './query-analysis.ts'
import { resolveTimeExpressions } from './time-expression.ts'

export interface MultiHopOptions {
  seeds?: number
  terms?: number
  perTerm?: number
}

export interface RetrieveOptions {
  memorySpaceId: MemorySpaceId
  query: string
  context?: string
  entityIds?: readonly string[]
  memoryTypes?: readonly ('conversation' | 'entity' | 'claim' | 'event')[]
  timeRange?: RetrievalTimeRange
  topK?: number
  rerank?: boolean
  rerankPool?: number
  includeEvidence?: boolean
  includeRelations?: boolean
  multiHop?: boolean | MultiHopOptions
  salientProfile?: boolean
  chunkExpansion?: boolean
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
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const CONTEXT_MENTION_LIMIT = 2
const CONTEXT_TAIL_CHARS = 240
const UPCOMING_SLOTS = 2
const UPCOMING_SCAN = 24
const MULTIHOP_SEEDS = 6
const MULTIHOP_TERMS = 8
const MULTIHOP_PER_TERM = 3
const MULTIHOP_STOP_WORDS = new Set([
  '用户',
  '助手',
  '今天',
  '昨天',
  '明天',
  '现在',
  '时候',
  '什么',
  '怎么',
  '这个',
  '那个',
  '自己',
  '觉得',
  '知道',
  '一个',
  '没有',
  '可以',
  '就是',
  '还是',
  '因为',
  '所以',
  '但是',
  '然后',
  '已经',
  '不是',
  '他们',
  '我们',
  '你们',
  '东西',
  '事情',
  '地方',
  '一次',
  '有点',
  '有些',
  '这么',
  '那么',
  '说',
  '做',
  '去',
  '来',
  '给',
  '把',
  '被',
  '让',
  '对',
  '和',
  '与',
  '也',
  '都',
  '就',
  '还',
  '又',
  '很',
  '太',
  '更',
  '最',
  '会',
  '能',
  '要',
  '想',
  '看',
  '听',
  '问',
  '答',
])
const ACTION_MARKERS =
  /修|磨|锉|做|干|弄|搞|装|拆|调|试|改|查|画|写|煮|炒|种|搬|洗|擦|收拾|准备|处理|解决|完成|学|练|教|带|帮|送|取|买|卖|开|关|跑|走|爬|蹲|量|切|焊|锯|钻|拧/g
const NUMBER_MARKERS =
  /\d+(?:\.\d+)?|[一二三四五六七八九十百千万两]+(?:个|小时|钟头|分钟|毫米|厘米|米|页|岁|年|天|次|回)/g
const CONTEXT_PERSON_REFERENCE = /(?:^|[^其])他(?!人)|她|对方|此人|这人|那人|这位|那位/
const CONTEXT_THING_REFERENCE = /(?:^|[^其])它/

export class Retriever {
  private readonly db: Database
  private readonly vectors: VectorStore
  private readonly embedding: EmbeddingProvider
  private readonly reranker: RerankerProvider
  private readonly resolver: EntityResolver
  private readonly evidenceJudge: EvidenceJudgeProvider | undefined

  constructor(
    db: Database,
    vectors: VectorStore,
    embedding: EmbeddingProvider,
    reranker: RerankerProvider,
    resolver: EntityResolver,
    evidenceJudge?: EvidenceJudgeProvider,
  ) {
    this.db = db
    this.vectors = vectors
    this.embedding = embedding
    this.reranker = reranker
    this.resolver = resolver
    this.evidenceJudge = evidenceJudge
  }

  async retrieve(options: RetrieveOptions): Promise<RetrieveResult> {
    const started = performance.now()
    const query = options.query.trim()
    if (query.length === 0) {
      throw new Error('query cannot be empty')
    }
    const analysis = analyzeQuery(query)
    const queryTokens = new Set(segment(query))
    const now = options.now ?? nowSeconds()
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
    const windows = resolveTimeExpressions(query, now, timeZone)
    const notes: string[] = []
    const mentioned = this.resolveMentioned(
      options.memorySpaceId,
      query,
      options.entityIds,
      options.context,
    )
    const allowed = allowedKinds(options.memoryTypes)
    const sqlItems = this.sqlChannel(
      options,
      analysis,
      mentioned.entities,
      queryTokens,
      windows,
    ).filter((item) => allowed.has(item.kind))
    const ftsItems = this.ftsChannel(options.memorySpaceId, query, allowed, notes)
    const multiHopItems =
      options.multiHop === undefined || options.multiHop === false
        ? []
        : await this.multiHopChannel(
            options.memorySpaceId,
            query,
            queryTokens,
            ftsItems,
            allowed,
            typeof options.multiHop === 'object' ? options.multiHop : {},
            options.context,
          )
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
    const messageItems =
      options.chunkExpansion === false
        ? []
        : this.messageChannel(options.memorySpaceId, query, queryTokens, vectorItems, allowed)

    const channelResults: ChannelResult[] = [
      { channel: 'sql', items: sqlItems },
      { channel: 'fts', items: ftsItems },
      { channel: 'vector', items: vectorItems },
      { channel: 'message', items: messageItems },
      ...(multiHopItems.length === 0
        ? []
        : [{ channel: 'multihop' as const, items: multiHopItems }]),
      ...(analysis.facets.length === 0 ? [] : [{ channel: 'facet' as const, items: facetItems }]),
    ]
    const fused = this.fuse(channelResults)
    const validated = this.validate(fused, analysis, options.timeRange)
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
    const profile =
      options.salientProfile === true
        ? this.salientProfile(
            options.memorySpaceId,
            query,
            queryTokens,
            mentioned.entities,
            allowed,
            now,
            timeZone,
            selected,
          )
        : []
    if (profile.length > 0) {
      selected.push(...profile)
      notes.push('显著实体：已补入实体档案与近期事件。')
    }
    const rawEvidencePool = [
      ...new Map(
        [...ftsItems, ...messageItems].flatMap((candidate) =>
          candidate.record.kind === 'message'
            ? [
                [
                  candidate.key,
                  {
                    message: candidate.record.message,
                    overlap: uniqueOverlap(queryTokens, candidate.record.message.content),
                    density:
                      uniqueOverlap(queryTokens, candidate.record.message.content) /
                      Math.sqrt(Math.max(1, [...segment(candidate.record.message.content)].length)),
                    digits: candidate.record.message.content.match(/\d+/g)?.length ?? 0,
                    score: candidate.score,
                  },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ]
    const rankedRaw = rawEvidencePool.toSorted(
      (left, right) =>
        right.density - left.density || right.overlap - left.overlap || right.score - left.score,
    )
    const rawEvidence = rankedRaw.slice(0, 4).map((entry) => entry.message)
    if (/第几|几页|多少|数字|编号|日期|时间/.test(query)) {
      const numeric = rankedRaw
        .filter((entry) => !rawEvidence.includes(entry.message) && entry.digits > 0)
        .toSorted(
          (left, right) =>
            right.digits - left.digits ||
            right.density - left.density ||
            right.overlap - left.overlap,
        )[0]
      if (numeric !== undefined && rawEvidence.length === 4) rawEvidence[3] = numeric.message
    }
    const upcoming =
      options.timeRange === undefined
        ? this.upcomingEvents(options.memorySpaceId, now, timeZone, allowed)
        : []
    const chosen = new Set(selected.map((candidate) => candidate.key))
    const extra = upcoming.filter((candidate) => !chosen.has(candidate.key))
    if (extra.length > 0) {
      selected.push(
        ...extra.slice(0, UPCOMING_SLOTS).map((candidate) => ({ ...candidate, pinned: true })),
      )
      notes.push('临近事项：已补入当天或次日的事项。')
    }
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
      intent: analysis.intent,
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
    return {
      candidates: resultCandidates,
      total: fused.length,
      trace,
      ...(rawEvidence.length === 0 ? {} : { evidence: rawEvidence }),
    }
  }

  private resolveMentioned(
    spaceId: MemorySpaceId,
    query: string,
    entityIds: readonly string[] | undefined,
    context: string | undefined,
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
    this.addContextMentioned(spaceId, query, context, mentioned)
    if (/你|您|you\b|your\b/i.test(query)) {
      const self = this.resolver.self(spaceId)
      if (self !== null && !mentioned.some((entity) => entity.id === self.id)) {
        mentioned.unshift(self)
      }
    }
    if (!/我|(\bI\b)|(\bmy\b)|(\bme\b)|(\bmine\b)/i.test(query)) {
      return { entities: mentioned, coverageIds }
    }
    const speakerId = latestUserSpeakerId(this.db, spaceId)
    if (speakerId === null) return { entities: mentioned, coverageIds }
    const speaker = this.resolver.findSpeaker(spaceId, speakerId)
    if (speaker === null || mentioned.some((entity) => entity.id === speaker.id)) {
      return { entities: mentioned, coverageIds }
    }
    return { entities: [speaker, ...mentioned], coverageIds }
  }

  private addContextMentioned(
    spaceId: MemorySpaceId,
    query: string,
    context: string | undefined,
    mentioned: Entity[],
  ): void {
    if (context === undefined) return
    const trimmed = context.trim()
    if (trimmed.length === 0) return
    const person = CONTEXT_PERSON_REFERENCE.test(query)
    const thing = CONTEXT_THING_REFERENCE.test(query)
    if (!person && !thing) return
    const personOnly = person && !thing
    const recent =
      trimmed.length > CONTEXT_TAIL_CHARS ? trimmed.slice(-CONTEXT_TAIL_CHARS) : trimmed
    const recentMatches = this.resolver.findMentioned(spaceId, recent, 8)
    const candidates =
      recentMatches.length > 0 ? recentMatches : this.resolver.findMentioned(spaceId, trimmed, 8)
    const picked = candidates
      .filter((entity) => entity.type !== 'self')
      .filter((entity) => !personOnly || entity.type === 'person')
      .filter((entity) => !mentioned.some((item) => item.id === entity.id))
      .slice(0, CONTEXT_MENTION_LIMIT)
    mentioned.push(...picked)
  }

  private sqlChannel(
    options: RetrieveOptions,
    analysis: QueryAnalysis,
    mentioned: readonly Entity[],
    queryTokens: ReadonlySet<string>,
    windows: readonly TimeWindow[],
  ): MemoryCandidate[] {
    const spaceId = options.memorySpaceId
    const includeInactive =
      analysis.wantsHistory || analysis.aspects.includes('change') || !analysis.wantsCurrent
    const wantsEvents =
      analysis.aspects.includes('event_time') ||
      analysis.aspects.includes('history') ||
      analysis.aspects.includes('change') ||
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
    const rankedClaims = rankStructured(claimItems, queryTokens, analysis, windows)
    const rankedEvents = rankStructured(eventItems, queryTokens, analysis, windows)
    const ordered =
      analysis.intent === 'entity'
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
    const terms = toNgramTerms(query)
    if (terms.length === 0) return word
    const kinds = ftsKinds(allowed)
    const wordKeys = new Set(word.map((item) => item.key))
    const uncovered = terms.find(
      (term) =>
        !searchFtsNgrams(this.db, spaceId, term, CANDIDATES_PER_CHANNEL, kinds).some((hit) =>
          wordKeys.has(`${hit.kind}:${hit.sourceId}`),
        ),
    )
    if (uncovered === undefined) return word
    notes.push('FTS 词级命中未覆盖查询的全部二元组，已补充 CJK 二元组检索。')
    const seen = new Set(wordKeys)
    const merged = [...word]
    for (const hit of searchFtsNgrams(this.db, spaceId, query, 30, kinds)) {
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

  private async multiHopChannel(
    spaceId: MemorySpaceId,
    query: string,
    queryTokens: ReadonlySet<string>,
    ftsItems: readonly MemoryCandidate[],
    allowed: ReadonlySet<CandidateRecord['kind']>,
    options: MultiHopOptions,
    context?: string,
  ): Promise<MemoryCandidate[]> {
    if (!allowed.has('message')) return []
    const seedLimit = Math.max(1, Math.min(options.seeds ?? MULTIHOP_SEEDS, 10))
    let seeds = ftsItems
      .filter((candidate) => candidate.record.kind === 'message')
      .slice(0, seedLimit)
    if (this.evidenceJudge !== undefined && seeds.length > 0) {
      const judged = await this.judgeCandidates(query, seeds, context)
      if (judged !== undefined) {
        seeds = seeds
          .map((seed) => ({ seed, score: judged.get(seed.key) ?? 0 }))
          .toSorted((left, right) => right.score - left.score)
          .slice(0, seedLimit)
          .map((entry) => entry.seed)
      }
    }
    if (seeds.length === 0) return []
    const termScores = new Map<string, number>()
    for (const [index, seed] of seeds.entries()) {
      if (seed.record.kind !== 'message') continue
      const weight = 1 / (index + 1)
      const content = seed.record.message.content
      for (const token of new Set([...segment(content), ...toNgramTerms(content)])) {
        if (token.length < 2 || queryTokens.has(token) || MULTIHOP_STOP_WORDS.has(token)) continue
        if (/^\d+$/.test(token)) continue
        termScores.set(
          token,
          (termScores.get(token) ?? 0) + weight * (1 + (token.length - 2) * 0.05),
        )
      }
    }
    const terms = [...termScores.entries()]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, Math.max(1, Math.min(options.terms ?? MULTIHOP_TERMS, 12)))
      .map(([term]) => term)
    if (terms.length === 0) return []
    const perTerm = Math.max(1, Math.min(options.perTerm ?? MULTIHOP_PER_TERM, 5))
    const hits = terms.map((term) =>
      searchFts(this.db, spaceId, term, perTerm, ['message']).flatMap((hit) => {
        const candidate = candidateFromSource(this.db, spaceId, hit.kind, hit.sourceId)
        return candidate === null ? [] : [candidate]
      }),
    )
    const seen = new Set<string>()
    const expanded: MemoryCandidate[] = []
    for (let rank = 0; rank < perTerm; rank += 1) {
      for (const list of hits) {
        const candidate = list[rank]
        if (candidate === undefined || seen.has(candidate.key)) continue
        seen.add(candidate.key)
        candidate.channels = ['multihop']
        candidate.score = 1 / (rank + 1)
        expanded.push(candidate)
        if (expanded.length >= CANDIDATES_PER_CHANNEL) break
      }
      if (expanded.length >= CANDIDATES_PER_CHANNEL) break
    }
    if (this.evidenceJudge !== undefined && expanded.length > 0) {
      const judged = await this.judgeCandidates(query, expanded, context)
      if (judged !== undefined) {
        for (const candidate of expanded) {
          candidate.score = judged.get(candidate.key) ?? 0
        }
        expanded.sort((left, right) => right.score - left.score)
      }
    }
    return expanded
  }

  private async judgeCandidates(
    query: string,
    candidates: readonly MemoryCandidate[],
    context: string | undefined,
  ): Promise<Map<string, number> | undefined> {
    if (this.evidenceJudge === undefined) return undefined
    try {
      const scores = await this.evidenceJudge.judge({
        query,
        ...(context === undefined ? {} : { context }),
        candidates: candidates.map((candidate) => ({
          id: candidate.key,
          text:
            candidate.record.kind === 'message'
              ? `${candidate.record.message.speakerId}（${candidate.record.message.role}）：${candidate.record.message.content}`
              : candidate.text,
        })),
      })
      return new Map(scores.map((score) => [score.id, score.score]))
    } catch {
      return undefined
    }
  }

  private messageChannel(
    spaceId: MemorySpaceId,
    query: string,
    queryTokens: ReadonlySet<string>,
    vectorItems: readonly MemoryCandidate[],
    allowed: ReadonlySet<CandidateRecord['kind']>,
  ): MemoryCandidate[] {
    if (!allowed.has('message') || !allowed.has('chunk')) return []
    const chunks = new Map<string, MemoryCandidate>()
    for (const item of this.ftsHits(spaceId, query, new Set(['chunk']))) {
      chunks.set(item.key, item)
    }
    for (const hit of searchFtsNgrams(this.db, spaceId, query, 30, ['chunk'])) {
      const item = candidateFromSource(this.db, spaceId, hit.kind, hit.sourceId)
      if (item === null || chunks.has(item.key)) continue
      item.score = hit.score
      chunks.set(item.key, item)
    }
    for (const item of vectorItems) {
      if (item.kind === 'chunk' && !chunks.has(item.key)) chunks.set(item.key, item)
    }
    const messages = new Map<string, MemoryCandidate>()
    for (const chunk of chunks.values()) {
      if (chunk.record.kind !== 'chunk') continue
      for (const message of getMessagesByIds(this.db, chunk.record.chunk.messageIds)) {
        const overlap = countOverlap(queryTokens, message.content)
        if (overlap === 0) continue
        const candidate = messageCandidate(message)
        candidate.score = chunk.score * (1 + overlap * 0.15)
        const existing = messages.get(candidate.key)
        if (existing === undefined || candidate.score > existing.score) {
          messages.set(candidate.key, candidate)
        }
      }
    }
    return [...messages.values()]
      .toSorted((left, right) => right.score - left.score)
      .slice(0, CANDIDATES_PER_CHANNEL)
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
    analysis: QueryAnalysis,
    timeRange: RetrievalTimeRange | undefined,
  ): { candidates: MemoryCandidate[]; notes: string[] } {
    const notes: string[] = []
    const kept: MemoryCandidate[] = []
    const keepInactive = analysis.aspects.includes('change')
    for (const candidate of candidates) {
      if (
        analysis.wantsCurrent &&
        !keepInactive &&
        candidate.kind === 'claim' &&
        candidate.status !== 'active'
      ) {
        continue
      }
      if (timeRange !== undefined) {
        const bounds = candidateBounds(candidate)
        if (bounds !== null) {
          if (timeRange.from !== undefined && bounds.end !== null && bounds.end < timeRange.from) {
            continue
          }
          if (timeRange.to !== undefined && bounds.start !== null && bounds.start > timeRange.to) {
            continue
          }
        }
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

  private salientProfile(
    spaceId: MemorySpaceId,
    query: string,
    queryTokens: ReadonlySet<string>,
    mentioned: readonly Entity[],
    allowed: ReadonlySet<CandidateRecord['kind']>,
    now: number,
    timeZone: string,
    selected: readonly MemoryCandidate[],
  ): MemoryCandidate[] {
    if (!allowed.has('entity') || !allowed.has('event')) return []
    const today = dayKey(now, timeZone)
    const processQuery = /怎么|如何|做法|过程|干活|工作|样子|步骤|经过|细节/.test(query)
    const eventScore = (event: Event): number => {
      const text = `${event.type} ${event.summary} ${event.description ?? ''}`
      let score = countOverlap(queryTokens, text) * 4
      if (processQuery) {
        const actions = text.match(ACTION_MARKERS)?.length ?? 0
        const numbers = text.match(NUMBER_MARKERS)?.length ?? 0
        score += Math.min(actions, 6) * 3 + Math.min(numbers, 4)
      }
      return score
    }
    const aliases = this.resolver.aliasMap(spaceId)
    const allEntities = listEntities(this.db, spaceId)
    const allEvents = listEvents(this.db, spaceId)
    const relatedIds = (entity: Entity): Entity['id'][] => {
      const ids = [entity.id]
      for (const other of allEntities) {
        if (other.id === entity.id) continue
        const names = [other.name, ...(aliases.get(other.id) ?? [])].filter(
          (name) => name.length >= 3,
        )
        if (names.some((name) => (entity.description ?? '').includes(name))) ids.push(other.id)
      }
      return ids
    }
    const bestEvent = (entity: Entity) => {
      const events = new Map<string, Event>()
      const add = (event: Event): void => {
        if (event.status !== 'active' || event.modality !== 'asserted') return
        const inTime =
          event.occurredDay !== null
            ? event.occurredDay <= today
            : event.occurredAt !== null && event.occurredAt <= now
        if (inTime) events.set(event.id, event)
      }
      for (const id of relatedIds(entity)) {
        for (const event of listEventsForEntity(this.db, spaceId, id, { limit: 8 })) add(event)
      }
      const names = [entity.name, ...(aliases.get(entity.id) ?? [])]
        .map((name) => name.split('的').at(-1) ?? name)
        .filter((name) => name.length >= 2)
      for (const event of allEvents) {
        if (events.has(event.id)) continue
        const text = `${event.summary} ${event.description ?? ''}`
        if (names.some((name) => text.includes(name))) add(event)
      }
      let best: Event | undefined
      let bestScore = 0
      for (const event of events.values()) {
        const score = eventScore(event)
        if (best === undefined || score > bestScore) {
          best = event
          bestScore = score
        }
      }
      return best
    }
    const entityScore = (entity: Entity): number => {
      const names = [entity.name, entity.description ?? '', ...(aliases.get(entity.id) ?? [])]
      const text = names.join(' ')
      let roleMatch = false
      for (let index = 0; index < query.length - 1; index += 1) {
        const gram = query.slice(index, index + 2)
        if (/^[\u4e00-\u9fff]{2}$/.test(gram) && text.includes(gram)) {
          roleMatch = true
          break
        }
      }
      return countOverlap(queryTokens, text) * 4 + (roleMatch ? 30 : 0)
    }
    const ordered = new Map<string, Entity>()
    const hits = searchFts(this.db, spaceId, query, 8, ['entity']).filter((hit) => hit.score > 0)
    for (const hit of hits) {
      const entityCandidate = candidateFromSource(this.db, spaceId, 'entity', hit.sourceId)
      if (entityCandidate?.record.kind === 'entity') {
        ordered.set(entityCandidate.record.entity.id, entityCandidate.record.entity)
      }
    }
    for (const entity of mentioned) {
      if (!isSpeakerEntity(entity) && !ordered.has(entity.id)) ordered.set(entity.id, entity)
    }
    for (const entity of allEntities) {
      if (isSpeakerEntity(entity) || ordered.has(entity.id)) continue
      if (entityScore(entity) > 0) ordered.set(entity.id, entity)
    }
    const ranked: { entity: Entity; event: Event; score: number }[] = []
    for (const entity of ordered.values()) {
      if (isSpeakerEntity(entity)) continue
      const event = bestEvent(entity)
      if (event === undefined) continue
      const score = entityScore(entity) + eventScore(event)
      if (score <= 0) continue
      ranked.push({ entity, event, score })
    }
    ranked.sort((left, right) => right.score - left.score)
    const unique: typeof ranked = []
    const eventIds = new Set<string>()
    for (const profile of ranked) {
      if (eventIds.has(profile.event.id)) continue
      eventIds.add(profile.event.id)
      unique.push(profile)
    }
    const limit = processQuery ? 4 : 1
    const topScore = unique[0]?.score ?? 0
    const chosen = unique
      .slice(0, limit)
      .filter((profile, index) => index === 0 || profile.score >= topScore * 0.6)
    const result: MemoryCandidate[] = []
    const seen = new Set<string>()
    for (const profile of chosen) {
      const entitySelected = selected.some((item) => item.key === `entity:${profile.entity.id}`)
      if (!entitySelected) {
        const entityCandidate = candidateFromSource(this.db, spaceId, 'entity', profile.entity.id)
        if (entityCandidate?.record.kind === 'entity' && !seen.has(entityCandidate.key)) {
          result.push(entityCandidate)
          seen.add(entityCandidate.key)
        }
      }
      const eventItem = eventCandidate(this.db, profile.event)
      if (eventItem !== null && !seen.has(eventItem.key)) {
        result.push(eventItem)
        seen.add(eventItem.key)
      }
    }
    for (const candidate of result) {
      candidate.pinned = true
      candidate.channels = ['fts']
    }
    return result
  }

  private upcomingEvents(
    spaceId: MemorySpaceId,
    now: number,
    timeZone: string,
    allowed: ReadonlySet<CandidateRecord['kind']>,
  ): MemoryCandidate[] {
    if (!allowed.has('event')) return []
    return listUpcomingEvents(this.db, spaceId, {
      fromDay: dayKey(now, timeZone),
      toDay: dayKey(dayStart(now, timeZone, 2), timeZone),
      fromEpoch: dayStart(now, timeZone),
      toEpoch: dayStart(now, timeZone, 2),
      limit: UPCOMING_SCAN,
    })
      .map((event) => eventCandidate(this.db, event))
      .filter((candidate): candidate is MemoryCandidate => candidate !== null)
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
          notes.push('Reranker 分数无可用区分度，保留 RRF 排序。')
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
        appendClosureEvidence(current.candidate, target)
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
            appendClosureEvidence(current.candidate, candidate)
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
  analysis: QueryAnalysis,
  windows: readonly TimeWindow[],
): MemoryCandidate[] {
  return items
    .map((item) => ({
      item,
      score: structuredRelevance(item, queryTokens, analysis, windows),
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
  analysis: QueryAnalysis,
  windows: readonly TimeWindow[],
): number {
  let score = 0
  for (const token of segment(`${item.title}\n${item.text}`)) {
    if (queryTokens.has(token)) score += 1
  }
  if (item.status === 'active' && (analysis.wantsCurrent || analysis.intent === 'general')) {
    score += 0.25
  }
  if (analysis.intent === 'event' && item.kind === 'event') score += 0.5
  if (analysis.intent === 'entity' && item.kind === 'entity') score += 0.5
  if (inTimeWindow(item.occurredAt, windows)) score += 0.5
  return score
}

function inTimeWindow(occurredAt: number | null, windows: readonly TimeWindow[]): boolean {
  if (occurredAt === null) return false
  return windows.some((window) => occurredAt >= window.from && occurredAt < window.to)
}

function candidateBounds(
  candidate: MemoryCandidate,
): { start: number | null; end: number | null } | null {
  if (candidate.record.kind === 'claim') {
    const claim = candidate.record.claim
    const start = claim.validFrom ?? candidate.occurredAt
    const end = claim.validUntil
    if (start === null && end === null) return null
    return { start, end }
  }
  if (candidate.kind === 'event' && candidate.occurredAt !== null) {
    return { start: candidate.occurredAt, end: candidate.occurredAt }
  }
  return null
}

function appendClosureEvidence(parent: MemoryCandidate, target: MemoryCandidate): void {
  const seen = new Set(parent.closureEvidenceMessageIds)
  for (const id of target.evidenceMessageIds) {
    if (seen.has(id)) continue
    seen.add(id)
    parent.closureEvidenceMessageIds.push(id)
  }
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

const FTS_SOURCE_TYPES: readonly MemorySourceType[] = [
  'message',
  'chunk',
  'entity',
  'claim',
  'event',
]

function ftsKinds(allowed: ReadonlySet<CandidateRecord['kind']>): MemorySourceType[] {
  return FTS_SOURCE_TYPES.filter((kind) => allowed.has(kind))
}

function countOverlap(tokens: ReadonlySet<string>, text: string): number {
  let count = 0
  for (const token of segment(text)) {
    if (tokens.has(token)) count += 1
  }
  return count
}

function isSpeakerEntity(entity: Entity): boolean {
  return (
    typeof entity.metadata?.['speakerId'] === 'string' ||
    entity.name === '用户' ||
    entity.name === '助手'
  )
}

function uniqueOverlap(tokens: ReadonlySet<string>, text: string): number {
  const matched = new Set<string>()
  for (const token of segment(text)) {
    if (tokens.has(token)) matched.add(token)
  }
  return matched.size
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
  return max < 1e-3 || max - min <= 1e-9
}
