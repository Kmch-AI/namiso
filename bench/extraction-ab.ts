import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import type {
  ExtractionDiagnostics,
  ExtractionProvider,
  ExtractionResult,
} from '../src/providers/types.ts'
import type { Claim } from '../src/types.ts'
import type { HistoryTurn } from './chat-memory-benchmark.ts'

import { Namiso } from '../src/index.ts'
import { providersFromEnv } from '../src/providers/from-env.ts'
import { Database } from '../src/storage/database.ts'
import {
  evidenceMessageIds,
  listAliasesBySpace,
  listClaims,
  listEntities,
  listEvents,
  listSpaceIds,
} from '../src/storage/memory-repo.ts'

const TURNS_PER_BATCH = 16
const BATCH_SIZE = 32
const MIN_BATCH_SIZE = 8

interface RunContext {
  persona: string
  turns: number
  history: HistoryTurn[]
  outDir: string
}

interface ArmConfig {
  name: string
  wireFormat: 'compact' | 'legacy'
  knownFacts: boolean
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      persona: { type: 'string', default: 'P17' },
      batches: { type: 'string', default: '20' },
      arms: { type: 'string', default: 'compact,legacy,compact-facts' },
      out: { type: 'string', default: 'bench/out/extraction-ab' },
      resume: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(`Namiso extraction A/B

  --dataset <path>   chat-memory-benchmark dataset directory (required)
  --persona <id>     history to extract (default P17)
  --batches <n>      consolidation batches per arm (default 20)
  --arms <list>      compact, legacy, compact-facts (default all three)
  --out <dir>        writes <arm>.json and summary.json
  --resume           keep each arm database and finish its pending messages

Run with node --env-file=.env. Extraction calls go to NAMISO_EXTRACTION_*.
`)
    process.exit(0)
  }

  if (values.dataset === undefined) {
    process.stderr.write('--dataset is required\n')
    process.exit(1)
  }

  const datasetRoot = resolve(values.dataset)
  const persona = values.persona ?? 'P17'
  const batches = Number(values.batches)
  if (!Number.isInteger(batches) || batches < 1) {
    process.stderr.write('--batches must be a positive integer\n')
    process.exit(1)
  }
  const arms = (values.arms ?? '')
    .split(',')
    .map((arm) => arm.trim())
    .filter((arm) => arm.length > 0)
  const armConfigs = arms.map((arm) => armConfig(arm))
  const history = readJsonl<HistoryTurn>(
    join(datasetRoot, 'histories', `${persona}.jsonl`),
  ).toSorted((left, right) => left.轮次 - right.轮次)
  const outDir = resolve(values.out ?? 'bench/out/extraction-ab')
  mkdirSync(outDir, { recursive: true })
  const context: RunContext = {
    persona,
    turns: Math.min(history.length, batches * TURNS_PER_BATCH),
    history,
    outDir,
  }

  const summaries: ArmSummary[] = []
  for (const config of armConfigs) {
    const summary = await runArm(config, context, values.resume)
    summaries.push(summary)
    writeFileSync(join(outDir, `${config.name}.json`), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`\n${config.name}: ${formatArm(summary)}\n`)
  }
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summaries, null, 2)}\n`)
  process.stdout.write(`\nArms: ${armConfigs.map((config) => config.name).join(', ')}\n`)
  process.stdout.write(`Output: ${outDir}\n`)
}

interface ArmSummary {
  arm: string
  persona: string
  wireFormat: string
  knownFacts: boolean
  turns: number
  messages: number
  batches: number
  retries: number
  durationMs: number
  calls: number
  usage: Record<string, number>
  diagnostics: ExtractionDiagnostics
  health: Record<string, number>
  entities: {
    total: number
    withDescription: number
    aliases: number
    self: number
    byType: Record<string, number>
  }
  claims: {
    total: number
    active: number
    superseded: number
    withoutEvidence: number
    distinctAttributes: number
    duplicateActive: number
    byModality: Record<string, number>
    private: number
    withValidFrom: number
  }
  events: {
    total: number
    withoutEvidence: number
    withOccurredAt: number
    byModality: Record<string, number>
    private: number
  }
}

function armConfig(name: string): ArmConfig {
  if (name === 'compact') return { name, wireFormat: 'compact', knownFacts: false }
  if (name === 'legacy') return { name, wireFormat: 'legacy', knownFacts: false }
  if (name === 'compact-facts') return { name, wireFormat: 'compact', knownFacts: true }
  throw new Error(`unknown arm: ${name}`)
}

async function runArm(
  config: ArmConfig,
  context: RunContext,
  resume: boolean,
): Promise<ArmSummary> {
  const databasePath = join(context.outDir, `${config.name}.db`)
  if (!resume) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${databasePath}${suffix}`)) rmSync(`${databasePath}${suffix}`)
    }
  }
  const providers = providersFromEnv({
    ...process.env,
    NAMISO_EXTRACTION_WIRE_FORMAT: config.wireFormat,
  })
  if (providers.extraction === undefined) {
    throw new Error('NAMISO_EXTRACTION_URL and NAMISO_EXTRACTION_MODEL are required')
  }
  const counting = new CountingExtractionProvider(providers.extraction)
  const namiso = await Namiso.open({
    databasePath,
    memorySpace: { name: `extraction-ab-${config.name}` },
    extraction: counting,
    knownFacts: config.knownFacts,
  })
  const startedAt = performance.now()
  const conversation = namiso.createConversation({ externalId: context.persona })
  for (const turn of context.history.slice(0, context.turns)) {
    const occurredAt = Math.floor(Date.parse(turn.逻辑时间) / 1000)
    await namiso.ingest({
      conversationId: conversation.id,
      externalMessageId: `${context.persona}:turn:${turn.轮次}:user`,
      speakerId: '用户',
      speakerName: '用户',
      role: 'user',
      content: turn.用户消息,
      occurredAt,
    })
    await namiso.ingest({
      conversationId: conversation.id,
      externalMessageId: `${context.persona}:turn:${turn.轮次}:assistant`,
      speakerId: '助手',
      speakerName: '助手',
      role: 'assistant',
      content: turn.助手回复,
      occurredAt,
    })
  }
  await namiso.drain()
  let batchSize = BATCH_SIZE
  let consecutiveFailures = 0
  let retries = 0
  let batches = 0
  for (;;) {
    if (namiso.health().counts.pendingMessages === 0) break
    try {
      const report = await namiso.consolidate({
        conversationId: conversation.id,
        batchSize,
      })
      batches += report.batches
      batchSize = BATCH_SIZE
      consecutiveFailures = 0
      if (report.batches === 0) break
    } catch (error) {
      consecutiveFailures += 1
      retries += 1
      const next = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2))
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(
        `  ${config.name} retry batchSize=${next} after ${consecutiveFailures}: ${message}\n`,
      )
      if (consecutiveFailures >= 5 || next === batchSize) throw error
      batchSize = next
    }
  }
  const health = namiso.health()
  const durationMs = Math.round(performance.now() - startedAt)
  const usage = providerUsage(providers.extraction)
  namiso.close()

  const summary = summarize(config, context, {
    batches,
    retries,
    health: health.counts,
    usage,
    calls: counting.calls,
    diagnostics: counting.totals,
  })
  summary.durationMs = durationMs
  summary.turns = context.turns
  return summary
}

function summarize(
  config: ArmConfig,
  context: RunContext,
  run: {
    batches: number
    retries: number
    health: Record<string, number>
    usage: Record<string, number>
    calls: number
    diagnostics: ExtractionDiagnostics
  },
): ArmSummary {
  const db = new Database(join(context.outDir, `${config.name}.db`))
  const spaceId = listSpaceIds(db)[0]
  if (spaceId === undefined) throw new Error('arm database has no memory space')
  const entities = listEntities(db, spaceId)
  const claims = listClaims(db, spaceId)
  const events = listEvents(db, spaceId)
  const aliases = listAliasesBySpace(db, spaceId)
  const claimStatus = countsBy(claims, (claim) => claim.status)
  const active = claims.filter((claim) => claim.status === 'active')
  const claimEvidence = new Map(
    claims.map((claim) => [claim.id, evidenceMessageIds(db, 'claim', claim.id).length]),
  )
  const eventEvidence = new Map(
    events.map((event) => [event.id, evidenceMessageIds(db, 'event', event.id).length]),
  )
  const summary: ArmSummary = {
    arm: config.name,
    persona: context.persona,
    wireFormat: config.wireFormat,
    knownFacts: config.knownFacts,
    turns: 0,
    messages: (run.health['messages'] ?? 0) - (run.health['pendingMessages'] ?? 0),
    batches: run.batches,
    retries: run.retries,
    durationMs: 0,
    calls: run.calls,
    usage: run.usage,
    diagnostics: run.diagnostics,
    health: run.health,
    entities: {
      total: entities.length,
      withDescription: entities.filter((entity) => entity.description !== null).length,
      aliases: [...aliases.values()].reduce((total, list) => total + list.length, 0),
      self: entities.filter((entity) => entity.type === 'self').length,
      byType: countsBy(entities, (entity) => entity.type),
    },
    claims: {
      total: claims.length,
      active: claimStatus['active'] ?? 0,
      superseded: claimStatus['superseded'] ?? 0,
      withoutEvidence: claims.filter((claim) => claimEvidence.get(claim.id) === 0).length,
      distinctAttributes: new Set(claims.map((claim) => claim.attribute)).size,
      duplicateActive: duplicateCount(active),
      byModality: countsBy(claims, (claim) => claim.modality),
      private: claims.filter((claim) => claim.sensitivity === 'private').length,
      withValidFrom: claims.filter((claim) => claim.validFrom !== null).length,
    },
    events: {
      total: events.length,
      withoutEvidence: events.filter((event) => eventEvidence.get(event.id) === 0).length,
      withOccurredAt: events.filter((event) => event.occurredAt !== null).length,
      byModality: countsBy(events, (event) => event.modality),
      private: events.filter((event) => event.sensitivity === 'private').length,
    },
  }
  db.close()
  return summary
}

function duplicateCount(claims: readonly Claim[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const claim of claims) {
    const object =
      claim.object.kind === 'literal'
        ? `l:${claim.object.value.trim().toLowerCase()}`
        : `e:${claim.object.entityId}`
    const key = `${claim.subjectId}\u0000${claim.attribute}\u0000${object}`
    if (seen.has(key)) duplicates += 1
    else seen.add(key)
  }
  return duplicates
}

function countsBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const item of items) {
    const value = key(item)
    result[value] = (result[value] ?? 0) + 1
  }
  return result
}

class CountingExtractionProvider implements ExtractionProvider {
  readonly version: string
  readonly totals: ExtractionDiagnostics = { evidenceFallbacks: 0, evidenceDropped: 0 }
  calls = 0
  private readonly inner: ExtractionProvider

  constructor(inner: ExtractionProvider) {
    this.inner = inner
    this.version = inner.version
  }

  async extract(input: Parameters<ExtractionProvider['extract']>[0]): Promise<ExtractionResult> {
    this.calls += 1
    const result = await this.inner.extract(input)
    if (result.diagnostics !== undefined) {
      this.totals.evidenceFallbacks += result.diagnostics.evidenceFallbacks
      this.totals.evidenceDropped += result.diagnostics.evidenceDropped
    }
    return result
  }
}

function providerUsage(provider: ExtractionProvider): Record<string, number> {
  const usage: unknown = Reflect.get(provider, 'usage')
  if (usage === null || typeof usage !== 'object') return {}
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') result[key] = value
  }
  return result
}

function readJsonl<T>(path: string): T[] {
  const rows: T[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    rows.push(JSON.parse(line) as T)
  }
  return rows
}

function formatArm(summary: ArmSummary): string {
  return [
    `entities=${summary.entities.total} aliases=${summary.entities.aliases} described=${summary.entities.withDescription}`,
    `claims=${summary.claims.total} active=${summary.claims.active} superseded=${summary.claims.superseded} dup=${summary.claims.duplicateActive}`,
    `events=${summary.events.total} noEvidence=${summary.claims.withoutEvidence + summary.events.withoutEvidence}`,
    `fallbacks=${summary.diagnostics.evidenceFallbacks} dropped=${summary.diagnostics.evidenceDropped} retries=${summary.retries}`,
    `usage=${summary.usage['totalTokens'] ?? 'n/a'} cacheHit=${summary.usage['cacheHitTokens'] ?? 'n/a'}`,
    `duration=${summary.durationMs}ms`,
  ].join(' | ')
}

await main()
