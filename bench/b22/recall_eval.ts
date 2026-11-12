import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Namiso } from '../../src/namiso.ts'
import { HttpEmbeddingProvider, HttpRerankerProvider } from '../../src/providers/http.ts'
import { out } from './out.ts'

const RELEASE = 'D:\\AI\\chat-memory-benchmark\\benchmark-2.2\\dataset'
const DB_ROOT = 'bench/b22/db/b22'

const SPACES: Record<string, { db: string; space: string }> = {
  examM01: { db: join(DB_ROOT, 'exam-M01-7b0a8f5b.db'), space: 'b22-exam-M01-7b0a8f' },
  examM02: { db: join(DB_ROOT, 'exam-M02-af52a9f4.db'), space: 'b22-exam-M02-af52a9' },
  naturalM01: { db: join(DB_ROOT, 'natural-M01-0f99dd51.db'), space: 'b22-natural-M01-0f99dd' },
  naturalM02: { db: join(DB_ROOT, 'natural-M02-40134339.db'), space: 'b22-natural-M02-401343' },
}

interface ExamItem {
  id: string
  persona: string
  now: string
  cutoff_turn: number
  question: string
}

interface Case {
  id: string
  persona: string
  now: string
  cutoff: number
  query: string
  snips: string[]
  subtype?: string
}

const norm = (text: string): string => text.replace(/[\s，。！？、,.!?~…“”"'（）()：:;；\-—]+/g, '')

function snipsOf(turn: Record<string, unknown>): string[] {
  const snips: string[] = []
  for (const key of ['用户消息', '助手回复']) {
    const raw = turn[key]
    const value = norm(typeof raw === 'string' ? raw : '')
    if (value.length >= 14) snips.push(value.slice(0, 14))
  }
  return snips
}

function jsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const hits = (text: string, snips: readonly string[]): number => {
  const haystack = norm(text)
  return snips.filter((snip) => haystack.includes(snip)).length
}

async function main(): Promise<void> {
  const only = arg('only', 'both')
  const limit = Number(arg('limit', '0'))
  const verbose = process.argv.includes('--verbose')
  const histories = new Map<string, Map<number, Record<string, unknown>>>()
  for (const persona of ['M01', 'M02']) {
    const map = new Map<number, Record<string, unknown>>()
    for (const row of jsonl<Record<string, unknown>>(
      join(RELEASE, 'histories', `${persona}.jsonl`),
    )) {
      map.set(Number(row['轮次']), row)
    }
    histories.set(persona, map)
  }

  const providers = {
    embedding: new HttpEmbeddingProvider({
      endpoint: 'http://127.0.0.1:8081/v1/embeddings',
      model: 'Qwen3-Embedding-0.6B-Q8_0',
      dimensions: 1024,
      batchSize: 16,
      timeoutMs: 180_000,
    }),
    reranker: new HttpRerankerProvider({
      endpoint: 'http://127.0.0.1:8082/v1/rerank',
      model: 'Qwen3-Reranker-0.6B.Q4_K_M',
      timeoutMs: 180_000,
    }),
  }

  const open = async (key: string): Promise<Namiso> => {
    const target = SPACES[key]
    if (target === undefined) throw new Error(`unknown space ${key}`)
    return Namiso.open({
      databasePath: target.db,
      memorySpace: { name: target.space },
      vectorIndex: 'auto',
      ...providers,
    })
  }

  const results: Array<{ set: string; id: string; sub: string; any: boolean; all: boolean }> = []

  if (only !== 'exam') {
    const cases = JSON.parse(readFileSync('bench/out/x-cases.json', 'utf8')) as Case[]
    for (const persona of ['M01', 'M02']) {
      const personaLimit = limit > 0 ? limit : Number.POSITIVE_INFINITY
      const subset = cases.filter((item) => item.persona === persona).slice(0, personaLimit)
      if (subset.length === 0) continue
      const namiso = await open(persona === 'M01' ? 'naturalM01' : 'naturalM02')
      try {
        for (const item of subset) {
          const context = await namiso.getContext({
            query: item.query,
            maxTokens: 1600,
            topK: 12,
            now: Math.floor(Date.parse(item.now) / 1000),
            timeZone: 'Asia/Shanghai',
          })
          const found = hits(context.text, item.snips)
          results.push({
            set: 'x',
            id: item.id,
            sub: item.subtype ?? '',
            any: found > 0,
            all: found === item.snips.length,
          })
          if (verbose || found === 0) {
            out(`${found > 0 ? 'HIT ' : 'MISS'} ${item.id} turns=${context.items.length}`)
          }
        }
      } finally {
        namiso.close()
      }
    }
  }

  if (only !== 'x') {
    const inputs = jsonl<ExamItem>(join(RELEASE, 'exam-inputs.jsonl')).filter(
      (item) => item.cutoff_turn !== undefined,
    )
    const keys = new Map(
      jsonl<Record<string, unknown>>(join(RELEASE, 'review-only', 'answer-key.jsonl')).map(
        (row) => [String(row['id']), row],
      ),
    )
    for (const persona of ['M01', 'M02']) {
      const personaLimit = limit > 0 ? limit : Number.POSITIVE_INFINITY
      const subset = inputs.filter((item) => item.persona === persona).slice(0, personaLimit)
      if (subset.length === 0) continue
      const namiso = await open(persona === 'M01' ? 'examM01' : 'examM02')
      const history = histories.get(persona) ?? new Map<number, Record<string, unknown>>()
      try {
        for (const item of subset) {
          const key = keys.get(item.id) ?? {}
          const turns = (key['evidence_turns'] as number[] | undefined) ?? []
          const snips = turns.flatMap((turn) => {
            const row = history.get(turn)
            return row === undefined ? [] : snipsOf(row)
          })
          if (snips.length === 0) continue
          const context = await namiso.getContext({
            query: item.question,
            maxTokens: 1600,
            topK: 12,
            now: Math.floor(Date.parse(item.now) / 1000),
            timeZone: 'Asia/Shanghai',
          })
          const found = hits(context.text, snips)
          const probeType = key['probe_type']
          results.push({
            set: 'exam',
            id: item.id,
            sub: typeof probeType === 'string' ? probeType : '?',
            any: found > 0,
            all: found === snips.length,
          })
        }
      } finally {
        namiso.close()
      }
    }
  }

  const summarize = (label: string, rows: typeof results): void => {
    if (rows.length === 0) return
    const any = rows.filter((row) => row.any).length
    const all = rows.filter((row) => row.all).length
    out(
      `${label}: n=${rows.length} any=${any} (${((100 * any) / rows.length).toFixed(1)}%) all=${all} (${((100 * all) / rows.length).toFixed(1)}%)`,
    )
  }
  summarize(
    'x-cases',
    results.filter((row) => row.set === 'x'),
  )
  summarize(
    'exam',
    results.filter((row) => row.set === 'exam'),
  )
  const bySub = new Map<string, typeof results>()
  for (const row of results) {
    if (row.set !== 'exam') continue
    const list = bySub.get(row.sub) ?? []
    list.push(row)
    bySub.set(row.sub, list)
  }
  for (const [sub, rows] of [...bySub.entries()].toSorted(
    (left, right) => right[1].length - left[1].length,
  )) {
    const any = rows.filter((row) => row.any).length
    out(
      `  ${sub.padEnd(20)} n=${String(rows.length).padStart(3)} any=${((100 * any) / rows.length).toFixed(1)}%`,
    )
  }
}

await main()
