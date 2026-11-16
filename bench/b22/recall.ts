import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Namiso } from '../../src/index.ts'
import { HttpExtractionProvider } from '../../src/providers/http.ts'

interface Turn {
  轮次: number
  逻辑时间: string
  用户消息: string
  助手回复: string
}

const turns = Number(process.env.RECALL_TURNS ?? 40)
const repeat = Number(process.env.RECALL_REPEAT ?? 3)
const batchSizes = (process.env.RECALL_BATCHES ?? '64,32,16')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)
const outDir = join(import.meta.dirname, '..', 'out', 'recall')
mkdirSync(outDir, { recursive: true })

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const rows = readFileSync(
  'D:/AI/chat-memory-benchmark/benchmark-2.2/dataset/histories/M02.jsonl',
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Turn)
  .slice(0, turns)

const target = rows.find((row) => row['用户消息'].includes('冬瓜排骨汤'))
if (target === undefined) throw new Error('target turn not found')

let responseSeq = 0
const loggingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  const clone = response.clone()
  const text = await clone.text()
  responseSeq += 1
  writeFileSync(join(outDir, `raw-${responseSeq}.json`), text)
  return response
}
const extraction = new HttpExtractionProvider({
  endpoint: process.env.NAMISO_EXTRACTION_URL ?? 'http://127.0.0.1:3425/v1/chat/completions',
  model: process.env.NAMISO_EXTRACTION_MODEL ?? 'workbuddy2api/cn:deepseek-v4.1-flash',
  ...(process.env.NAMISO_EXTRACTION_API_KEY === undefined
    ? {}
    : { apiKey: process.env.NAMISO_EXTRACTION_API_KEY }),
  reasoningEffort: 'none',
  timeoutMs: 180_000,
  fetch: loggingFetch,
})

const results: Array<Record<string, unknown>> = []

for (const batchSize of batchSizes) {
  for (let run = 1; run <= repeat; run += 1) {
    const dbPath = join(outDir, `M02-${turns}-${batchSize}-${run}.db`)
    rmSync(dbPath, { force: true })
    const namiso = await Namiso.open({
      databasePath: dbPath,
      memorySpace: { name: `recall-${batchSize}-${run}` },
      extraction,
      vectorIndex: 'exact',
    })
    try {
      const conversation = namiso.createConversation({
        externalId: `M02-recall-${turns}-${batchSize}-${run}`,
      })
      for (const row of rows) {
        const occurredAt = Math.floor(Date.parse(row['逻辑时间']) / 1000)
        for (const [role, content] of [
          ['user', row['用户消息']],
          ['assistant', row['助手回复']],
        ] as const) {
          await namiso.ingest({
            conversationId: conversation.id,
            externalMessageId: `${row['轮次']}:${role}:${batchSize}:${run}`,
            speakerId: role === 'user' ? '用户' : '助手',
            speakerName: role === 'user' ? '用户' : '小满',
            role,
            content,
            occurredAt,
          })
        }
      }
      await namiso.drain()
      const usageBefore = { ...extraction.usage }
      const report = await namiso.consolidate({ conversationId: conversation.id, batchSize })
      const usage = {
        promptTokens: extraction.usage.promptTokens - usageBefore.promptTokens,
        completionTokens: extraction.usage.completionTokens - usageBefore.completionTokens,
        totalTokens: extraction.usage.totalTokens - usageBefore.totalTokens,
      }
      namiso.close()

      const db = new DatabaseSync(dbPath, { readOnly: true })
      const events = db
        .prepare(
          `select e.id, e.type, e.summary, e.occurred_day, e.time_precision,
             (select group_concat(substr(m.content, 1, 180), ' || ')
              from memory_evidence me
              join evidence ev on ev.id = me.evidence_id
              join messages m on m.id = ev.source_id
              where me.memory_type = 'event' and me.memory_id = e.id) as evidence
           from events e
           where e.summary like '%冬瓜%' or e.summary like '%排骨%' or e.summary like '%送汤%'
              or e.description like '%冬瓜%' or e.description like '%排骨%' or e.description like '%送汤%'`,
        )
        .all() as Array<Record<string, unknown>>
      const claims = db
        .prepare(
          `select c.predicate, c.object_value, c.status, c.modality,
             (select group_concat(substr(m.content, 1, 180), ' || ')
              from memory_evidence me
              join evidence ev on ev.id = me.evidence_id
              join messages m on m.id = ev.source_id
              where me.memory_type = 'claim' and me.memory_id = c.id) as evidence
           from claims c
           where c.predicate like '%汤%' or c.object_value like '%冬瓜%' or c.object_value like '%排骨%'`,
        )
        .all() as Array<Record<string, unknown>>
      const counts = db
        .prepare(
          `select (select count(*) from events) as events, (select count(*) from claims) as claims`,
        )
        .get() as Record<string, unknown>
      db.close()

      const eventHit = events.some(
        (event) => asText(event.summary).includes('冬瓜') || asText(event.summary).includes('排骨'),
      )
      const dateHit = events.some((event) => Number(event.occurred_day) === 20260827)
      const evidenceHit = events.some((event) => asText(event.evidence).includes('冬瓜排骨汤'))
      const record = {
        batchSize,
        run,
        report,
        usage,
        counts,
        targetTurn: target['轮次'],
        eventHit,
        dateHit,
        evidenceHit,
        events,
        claims,
      }
      results.push(record)
      process.stdout.write(`${JSON.stringify(record)}\n`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      results.push({ batchSize, run, error: message })
      process.stderr.write(`${JSON.stringify({ batchSize, run, error: message })}\n`)
    } finally {
      namiso.close()
    }
  }
}

const summary = batchSizes.map((batchSize) => {
  const subset = results.filter((item) => item.batchSize === batchSize)
  return {
    batchSize,
    runs: subset.length,
    eventHit: subset.filter((item) => item.eventHit).length,
    dateHit: subset.filter((item) => item.dateHit).length,
    evidenceHit: subset.filter((item) => item.evidenceHit).length,
  }
})
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
process.stdout.write(`${JSON.stringify({ summary })}\n`)
