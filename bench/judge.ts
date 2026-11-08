import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { chat, modelFromEnv, readJsonl } from './model.ts'

interface Packet {
  id: string
  question: string
  now: string
  rubric: { required: readonly string[]; forbidden?: readonly string[] }
  facts: readonly unknown[]
  sources: readonly unknown[]
  answer: string
  answer_sha256: string
  rubric_sha256: string
}

const FLAGS = ['错认', '错否', '越界', '编造日期', '不当私事披露'] as const
const LISTS = ['违反禁止', '未知当事实', '无关旧事'] as const

const { values } = parseArgs({
  options: {
    packets: { type: 'string', default: 'bench/out/packets.jsonl' },
    prompt: { type: 'string', required: true },
    out: { type: 'string', default: 'bench/out/reviews.jsonl' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    reasoning: { type: 'string' },
    'max-tokens': { type: 'string', default: '1500' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`Judge prepared answer packets with one chat model

  --packets <path>      packets.jsonl from grade.py prepare
  --prompt <path>       judge-prompt.md from the benchmark repository
  --out <path>          reviews.jsonl (default bench/out/reviews.jsonl)
  --limit <n>           judge only the first n packets
  --concurrency <n>     parallel requests (default 4)
  --reasoning <effort>  none, minimal, low, medium, or high
  --max-tokens <n>      review token cap (default 1500)
`)
  process.exit(0)
}

if (values.prompt === undefined) {
  throw new Error('--prompt is required')
}
const packetsPath = resolve(values.packets)
const promptPath = resolve(values.prompt)
const outputPath = resolve(values.out)
const concurrency = Math.max(1, Number(values.concurrency))
const maxTokens = Math.max(1, Number(values['max-tokens']))
const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit)
const judgePrompt = readFileSync(promptPath, 'utf8')
const model = modelFromEnv(join(process.cwd(), '.env'))
const packets = readJsonl<Packet>(packetsPath).slice(0, limit)
const done = new Set<string>()
if (existsSync(outputPath)) {
  for (const row of readJsonl<{ id: string }>(outputPath)) done.add(row.id)
}
if (!existsSync(dirname(outputPath))) mkdirSync(dirname(outputPath), { recursive: true })
if (!existsSync(outputPath)) writeFileSync(outputPath, '')

process.stdout.write(
  `judge: ${packets.length} packets, ${done.size} already done, concurrency ${concurrency}\n`,
)
const started = performance.now()
let completed = 0
let failed = 0
let cursor = 0

const workers = Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = cursor
    cursor += 1
    const packet = packets[index]
    if (packet === undefined) return
    if (done.has(packet.id)) continue
    try {
      const review = await judgeOne(packet)
      appendFileSync(outputPath, `${JSON.stringify(review)}\n`)
      completed += 1
    } catch (error) {
      failed += 1
      process.stderr.write(
        `${packet.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    if ((completed + failed) % 20 === 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1)
      process.stdout.write(`progress ${completed + failed}/${packets.length} in ${elapsed}s\n`)
    }
  }
})
await Promise.all(workers)
const elapsed = ((performance.now() - started) / 1000).toFixed(1)
process.stdout.write(`done: ${completed} judged, ${failed} failed, ${elapsed}s\n`)

async function judgeOne(packet: Packet): Promise<Record<string, unknown>> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: judgePrompt },
    { role: 'user', content: JSON.stringify(packet) },
  ]
  let lastError = 'invalid review'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = await chat(messages, model, {
      maxTokens,
      ...(values.reasoning === undefined ? {} : { reasoning: values.reasoning }),
    })
    const review = parseReview(content)
    if (review !== null && isValidReview(review, packet)) {
      return {
        ...review,
        answer_sha256: packet.answer_sha256,
        rubric_sha256: packet.rubric_sha256,
      }
    }
    lastError = review === null ? 'review is not JSON' : 'review failed validation'
    messages.push(
      { role: 'assistant', content },
      {
        role: 'user',
        content: `That output was invalid: ${lastError}. Return only one JSON object. required must contain exactly ${packet.rubric.required.length} boolean value(s), one per rubric.required entry in order. Keep reason non-empty.`,
      },
    )
  }
  throw new Error(lastError)
}

function parseReview(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isValidReview(review: Record<string, unknown>, packet: Packet): boolean {
  if (review['id'] !== packet.id) return false
  const required = review['required']
  if (!Array.isArray(required) || required.length !== packet.rubric.required.length) return false
  if (!required.every((value) => typeof value === 'boolean')) return false
  for (const flag of FLAGS) {
    if (typeof review[flag] !== 'boolean') return false
  }
  for (const list of LISTS) {
    const value = review[list]
    if (!Array.isArray(value)) return false
    if (!value.every((item) => typeof item === 'string' && item.trim().length > 0)) return false
  }
  return typeof review['reason'] === 'string' && review['reason'].trim().length > 0
}
