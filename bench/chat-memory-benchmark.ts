import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ProviderSet } from '../src/providers/from-env.ts'

import { Namiso } from '../src/index.ts'

export interface HistoryTurn {
  轮次: number
  逻辑时间: string
  用户消息: string
  助手回复: string
  日: number
}

export interface ExamItem {
  id: string
  persona: string
  history_file: string
  history_sha256?: string
  now: string
  cutoff_turn: number
  question: string
}

export interface AnswerKey {
  id: string
  interval_days?: number
  anchors?: Array<{ last_turn?: number; time?: string }>
  retrieval_required?: boolean
  rubric?: Record<string, unknown>
}

export interface BenchmarkDataset {
  root: string
  examItems: ExamItem[]
  answerKey: Map<string, AnswerKey>
}

export interface ItemResult {
  id: string
  persona: string
  question: string
  cutoffTurn: number
  intervalDays: number | null
  context: string
  contextTokens: number
  latencyMs: number
  evidenceMessageIds: string[]
  anchorHits: number
  anchorTotal: number
  contextHit: boolean
  retrievalRequired: boolean
  error?: string
}

export interface IntervalSummary {
  items: number
  evidenceRecall: number | null
  contextHitRate: number | null
}

export interface BenchmarkReport {
  datasetRoot: string
  generatedAt: string
  mode: BenchmarkMode
  providers: { embedding: string; extraction: string; reranker: string }
  items: number
  scoredItems: number
  personas: number
  turnsIngested: number
  consolidationBatches: number
  ingestMs: number
  evidenceRecall: number | null
  contextHitRate: number | null
  contextTokens: { p50: number; p95: number; max: number }
  retrievalLatencyMs: { p50: number; p95: number; min: number; max: number }
  byInterval: Record<string, IntervalSummary>
  errors: number
  notes: string[]
}

export type BenchmarkMode = 'hybrid' | 'raw'

export interface RunOptions {
  datasetPath: string
  outputDir?: string
  limit?: number
  persona?: string
  maxTokens?: number
  topK?: number
  mode?: BenchmarkMode
  providers?: ProviderSet
}

export interface RunOutput {
  report: BenchmarkReport
  results: ItemResult[]
}

export function loadDataset(inputPath: string): BenchmarkDataset {
  const root = resolve(inputPath)
  const candidates = [root, join(root, 'demo')]
  const found = candidates.find((candidate) => existsSync(join(candidate, 'exam-inputs.jsonl')))
  if (found === undefined) {
    throw new Error(`exam-inputs.jsonl not found under ${root}`)
  }
  const examItems = readJsonl<ExamItem>(join(found, 'exam-inputs.jsonl'))
  const answerKeyPath = join(found, 'review-only', 'answer-key.jsonl')
  const answerKey = new Map<string, AnswerKey>()
  if (existsSync(answerKeyPath)) {
    for (const entry of readJsonl<AnswerKey>(answerKeyPath)) {
      answerKey.set(entry.id, entry)
    }
  }
  return { root: found, examItems, answerKey }
}

export async function runBenchmark(options: RunOptions): Promise<RunOutput> {
  const dataset = loadDataset(options.datasetPath)
  const selected = dataset.examItems
    .filter((item) => options.persona === undefined || item.persona === options.persona)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
  const byPersona = new Map<string, ExamItem[]>()
  for (const item of selected) {
    const items = byPersona.get(item.persona) ?? []
    items.push(item)
    byPersona.set(item.persona, items)
  }
  const results: ItemResult[] = []
  let turnsIngested = 0
  let consolidationBatches = 0
  let ingestMs = 0
  let providerIdentity: BenchmarkReport['providers'] | null = null
  const startedAt = new Date().toISOString()

  for (const [persona, items] of byPersona) {
    items.sort(
      (left, right) => left.cutoff_turn - right.cutoff_turn || left.id.localeCompare(right.id),
    )
    const historyFile = items[0]?.history_file
    if (historyFile === undefined) continue
    const history = readJsonl<HistoryTurn>(join(dataset.root, historyFile)).toSorted(
      (left, right) => left.轮次 - right.轮次,
    )
    const namiso = await Namiso.open({
      databasePath: ':memory:',
      memorySpace: { name: `bench-${persona}` },
      vectorIndex: 'auto',
      ...options.providers,
    })
    const health = namiso.health()
    providerIdentity ??= {
      embedding: health.embedding.model,
      extraction: health.extraction.version,
      reranker: health.reranker.model,
    }
    const conversation = namiso.createConversation({ externalId: persona })
    let ingestedTurns = 0
    for (const item of items) {
      try {
        const ingestStarted = performance.now()
        while (ingestedTurns < item.cutoff_turn) {
          const turn = history[ingestedTurns]
          if (turn === undefined) break
          const occurredAt = Math.floor(Date.parse(turn.逻辑时间) / 1000)
          await ingestTurn(namiso, conversation.id, persona, turn, occurredAt)
          ingestedTurns += 1
          turnsIngested += 1
        }
        await namiso.drain()
        const consolidation = await namiso.consolidate({ conversationId: conversation.id })
        consolidationBatches += consolidation.batches
        ingestMs += performance.now() - ingestStarted
        const messages = namiso.getMessages({
          conversationId: conversation.id,
          limit: 10_000,
        })
        const indexById = new Map(messages.map((message) => [message.id, message.messageIndex]))
        const retrievalStarted = performance.now()
        const context = await namiso.getContext({
          query: item.question,
          maxTokens: options.maxTokens ?? 1600,
          topK: options.topK ?? 12,
          ...(options.mode === 'raw'
            ? { memoryTypes: ['conversation'] as const, includeRelations: false }
            : {}),
        })
        const latencyMs = performance.now() - retrievalStarted
        const key = dataset.answerKey.get(item.id)
        const anchors = key?.anchors ?? []
        let anchorHits = 0
        for (const anchor of anchors) {
          if (anchor.last_turn === undefined) continue
          const expected = new Set([2 * (anchor.last_turn - 1), 2 * (anchor.last_turn - 1) + 1])
          const hit = context.evidence.some((message) => {
            const index = indexById.get(message.id)
            return index !== undefined && expected.has(index)
          })
          if (hit) anchorHits += 1
        }
        results.push({
          id: item.id,
          persona,
          question: item.question,
          cutoffTurn: item.cutoff_turn,
          intervalDays: key?.interval_days ?? null,
          context: context.text,
          contextTokens: context.tokenEstimate,
          latencyMs,
          evidenceMessageIds: context.evidence.map((message) => message.id),
          anchorHits,
          anchorTotal: anchors.length,
          contextHit: anchorHits > 0,
          retrievalRequired: key?.retrieval_required !== false,
        })
      } catch (error) {
        results.push({
          id: item.id,
          persona,
          question: item.question,
          cutoffTurn: item.cutoff_turn,
          intervalDays: dataset.answerKey.get(item.id)?.interval_days ?? null,
          context: '',
          contextTokens: 0,
          latencyMs: 0,
          evidenceMessageIds: [],
          anchorHits: 0,
          anchorTotal: dataset.answerKey.get(item.id)?.anchors?.length ?? 0,
          contextHit: false,
          retrievalRequired: true,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    namiso.close()
  }

  const report = summarize({
    datasetRoot: dataset.root,
    generatedAt: startedAt,
    mode: options.mode ?? 'hybrid',
    providers: providerIdentity ?? {
      embedding: 'unknown',
      extraction: 'unknown',
      reranker: 'unknown',
    },
    results,
    personas: byPersona.size,
    turnsIngested,
    consolidationBatches,
    ingestMs,
    hasAnswerKey: dataset.answerKey.size > 0,
  })
  if (options.outputDir !== undefined) {
    writeOutputs(options.outputDir, results, report)
  }
  return { report, results }
}

async function ingestTurn(
  namiso: Namiso,
  conversationId: string,
  persona: string,
  turn: HistoryTurn,
  occurredAt: number,
): Promise<void> {
  await namiso.ingest({
    conversationId,
    externalMessageId: `${persona}:turn:${turn.轮次}:user`,
    speakerId: '用户',
    speakerName: '用户',
    role: 'user',
    content: turn.用户消息,
    occurredAt,
    metadata: { turn: turn.轮次, day: turn.日 },
  })
  await namiso.ingest({
    conversationId,
    externalMessageId: `${persona}:turn:${turn.轮次}:assistant`,
    speakerId: '助手',
    speakerName: '助手',
    role: 'assistant',
    content: turn.助手回复,
    occurredAt,
    metadata: { turn: turn.轮次, day: turn.日 },
  })
}

function summarize(input: {
  datasetRoot: string
  generatedAt: string
  mode: BenchmarkMode
  providers: BenchmarkReport['providers']
  results: ItemResult[]
  personas: number
  turnsIngested: number
  consolidationBatches: number
  ingestMs: number
  hasAnswerKey: boolean
}): BenchmarkReport {
  const scored = input.results.filter(
    (result) => result.error === undefined && result.anchorTotal > 0 && result.retrievalRequired,
  )
  const evidenceRecall =
    scored.length === 0
      ? null
      : round(
          scored.reduce((sum, result) => sum + result.anchorHits / result.anchorTotal, 0) /
            scored.length,
        )
  const contextHitRate =
    scored.length === 0
      ? null
      : round(scored.filter((result) => result.contextHit).length / scored.length)
  const tokens = input.results
    .filter((result) => result.error === undefined)
    .map((result) => result.contextTokens)
  const latencies = input.results
    .filter((result) => result.error === undefined)
    .map((result) => result.latencyMs)
  const byInterval: Record<string, IntervalSummary> = {}
  for (const result of scored) {
    const label = result.intervalDays === null ? 'unknown' : `d${result.intervalDays}`
    const bucket = byInterval[label] ?? {
      items: 0,
      evidenceRecall: 0,
      contextHitRate: 0,
    }
    bucket.items += 1
    bucket.evidenceRecall = (bucket.evidenceRecall ?? 0) + result.anchorHits / result.anchorTotal
    bucket.contextHitRate = (bucket.contextHitRate ?? 0) + (result.contextHit ? 1 : 0)
    byInterval[label] = bucket
  }
  for (const [label, bucket] of Object.entries(byInterval)) {
    const count = bucket.items
    byInterval[label] = {
      items: count,
      evidenceRecall: round((bucket.evidenceRecall ?? 0) / count),
      contextHitRate: round((bucket.contextHitRate ?? 0) / count),
    }
  }
  const notes = [
    'This harness measures retrieval evidence recall, not end-to-end answer correctness.',
    "Contexts are written for an external answer model and the benchmark's own grader.",
  ]
  if (!input.hasAnswerKey) {
    notes.push('No answer key found; evidence recall was not scored.')
  }
  return {
    datasetRoot: input.datasetRoot,
    generatedAt: input.generatedAt,
    mode: input.mode,
    providers: input.providers,
    items: input.results.length,
    scoredItems: scored.length,
    personas: input.personas,
    turnsIngested: input.turnsIngested,
    consolidationBatches: input.consolidationBatches,
    ingestMs: round(input.ingestMs),
    evidenceRecall,
    contextHitRate,
    contextTokens: {
      p50: percentile(tokens, 50),
      p95: percentile(tokens, 95),
      max: tokens.length === 0 ? 0 : Math.max(...tokens),
    },
    retrievalLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      min: latencies.length === 0 ? 0 : round(Math.min(...latencies)),
      max: latencies.length === 0 ? 0 : round(Math.max(...latencies)),
    },
    byInterval,
    errors: input.results.filter((result) => result.error !== undefined).length,
    notes,
  }
}

function writeOutputs(
  outputDir: string,
  results: readonly ItemResult[],
  report: BenchmarkReport,
): void {
  const directory = resolve(outputDir)
  mkdirSync(directory, { recursive: true })
  const contexts = results
    .map((result) =>
      JSON.stringify({
        id: result.id,
        persona: result.persona,
        question: result.question,
        cutoff_turn: result.cutoffTurn,
        context: result.context,
        tokens: result.contextTokens,
        anchor_hits: result.anchorHits,
        anchor_total: result.anchorTotal,
        error: result.error ?? null,
      }),
    )
    .join('\n')
  writeFileSync(join(directory, 'contexts.jsonl'), `${contexts}\n`, 'utf8')
  writeFileSync(
    join(directory, 'report.json'),
    `${JSON.stringify({ report, results }, null, 2)}\n`,
    'utf8',
  )
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return round(sorted[Math.max(0, index)] ?? 0)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
