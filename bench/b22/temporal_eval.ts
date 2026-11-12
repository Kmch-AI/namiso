import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Namiso } from '../../src/namiso.ts'
import { providersFromEnv } from '../../src/providers/from-env.ts'
import { out } from './out.ts'

const RELEASE = 'D:/AI/chat-memory-benchmark/benchmark-2.2'
const DATASET = join(RELEASE, 'dataset')
const OUT = join(import.meta.dirname, '..', 'out', 'temporal')
const WINDOW = Number(process.env.TEMPORAL_WINDOW ?? 120)
const LIMIT = Number(process.env.TEMPORAL_LIMIT ?? 2)

const normalize = (text: string): string =>
  text.replace(/[\s，。！？、,.!?~…“”"'（）()：:;；\-—]+/g, '')

const dayOf = (epoch: number): string =>
  new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 10)

interface ExamRow {
  id: string
  persona: string
  history_file: string
  now: string
  cutoff_turn: number
  question: string
}

interface KeyRow {
  id: string
  kind: string
  probe_type: string
  evidence_turns: number[]
  anchors: Array<{ fact_id: string; last_turn: number }>
}

interface HistoryTurn {
  轮次: number
  逻辑时间: string
  用户消息: string
  助手回复: string
  日: string
  会话: string
}

function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8').trim()
  if (text.length === 0) return []
  return text.split(/\r?\n/).map((line) => JSON.parse(line) as T)
}

const KEYWORDS: Record<string, string> = {
  'M01-G059/s1': '驿站',
  'M01-G019/s1': '营业',
  'M01-G171/s1': '科目二',
}

function keywordOf(id: string, question: string): string {
  const configured = process.env.TEMPORAL_KEYWORD
  if (configured !== undefined && configured.length > 0) return configured
  const mapped = KEYWORDS[id]
  if (mapped !== undefined) return mapped
  const candidates = ['饮水机', '面馆', '科目二']
  const hit = candidates.find((word) => question.includes(word))
  if (hit !== undefined) return hit
  return question.slice(0, 4)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const rows = readJsonl<ExamRow>(join(DATASET, 'exam-inputs.jsonl'))
  const keys = new Map(
    readJsonl<KeyRow>(join(DATASET, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]),
  )
  const targets = rows.filter((row) => keys.get(row.id)?.probe_type === 'due_day').slice(0, LIMIT)

  for (const row of targets) {
    const key = keys.get(row.id)
    const keyword = keywordOf(row.id, row.question)
    const evidenceTurn = key?.evidence_turns[0] ?? row.cutoff_turn
    const history = readJsonl<HistoryTurn>(join(DATASET, row.history_file))
      .filter((turn) => turn.轮次 > evidenceTurn - WINDOW && turn.轮次 <= evidenceTurn)
      .toSorted((left, right) => left.轮次 - right.轮次)
    const databasePath = join(OUT, `${row.id.replace(/[^\w-]+/g, '_')}.db`)
    if (existsSync(databasePath)) rmSync(databasePath)

    const providers = providersFromEnv()
    const namiso = await Namiso.open({
      databasePath,
      memorySpace: { name: `temporal-${row.id}` },
      vectorIndex: 'auto',
      ...providers,
    })
    const started = Date.now()
    const conversation = namiso.createConversation({ externalId: row.persona })
    for (const turn of history) {
      const occurredAt = Math.floor(Date.parse(turn.逻辑时间) / 1000)
      const base = {
        conversationId: conversation.id,
        occurredAt,
        timeZone: 'Asia/Shanghai',
        metadata: { turn: turn.轮次, day: turn.日 },
        role: 'user' as const,
      }
      await namiso.ingest({
        ...base,
        speakerId: '用户',
        speakerName: '用户',
        content: turn.用户消息,
        externalMessageId: `${row.persona}:turn:${turn.轮次}:user`,
      })
      await namiso.ingest({
        ...base,
        role: 'assistant' as const,
        speakerId: '助手',
        speakerName: '助手',
        content: turn.助手回复,
        externalMessageId: `${row.persona}:turn:${turn.轮次}:assistant`,
      })
    }
    await namiso.drain()
    await namiso.consolidate({ conversationId: conversation.id })
    namiso.close()

    const db = new DatabaseSync(databasePath)
    const events = db
      .prepare(
        `SELECT summary, occurred_at, time_precision FROM events
         WHERE occurred_at IS NOT NULL ORDER BY occurred_at ASC`,
      )
      .all() as Array<{
      summary: string
      occurred_at: number | null
      time_precision: string | null
    }>
    db.close()

    const reopened = await Namiso.open({
      databasePath,
      memorySpace: { name: `temporal-${row.id}` },
      vectorIndex: 'auto',
      ...providers,
    })
    const context = await reopened.getContext({
      query: row.question,
      maxTokens: 1600,
      topK: 12,
      now: Math.floor(Date.parse(row.now) / 1000),
      timeZone: 'Asia/Shanghai',
    })
    reopened.close()

    const dueDay = new Date(Date.parse(row.now) + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const dueEvents = events.filter(
      (event) => event.occurred_at !== null && dayOf(event.occurred_at) === dueDay,
    )
    const rendered = normalize(context.text)
    const dueInContext = dueEvents.some((event) =>
      rendered.includes(normalize(event.summary).slice(0, 12)),
    )
    const keywordInContext = rendered.includes(normalize(keyword))
    out(`\n== ${row.id} now=${row.now} due=${dueDay} keyword=${keyword}`)
    out(`ingested ${history.length} turns in ${Math.round((Date.now() - started) / 1000)}s`)
    out(
      `dueEvents=${dueEvents.length} dueInContext=${dueInContext} keywordInContext=${keywordInContext} tokens=${context.tokenEstimate}`,
    )
    for (const event of dueEvents) {
      out(`  DUE ${event.time_precision ?? '-'} ${event.summary.slice(0, 44)}`)
    }
  }
}

await main()
