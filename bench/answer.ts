import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import type { ChatResult, ChatUsage } from './model.ts'

import { addUsage, chatWithUsage, emptyUsage, modelFromEnv, readJsonl } from './model.ts'

interface ContextRow {
  id: string
  persona: string
  question: string
  context: string
}

interface ExamItem {
  id: string
  persona: string
  history_file: string
  now: string
  cutoff_turn: number
  question: string
}

interface HistoryTurn {
  轮次: number
  用户消息: string
  助手回复: string
}

interface AnswerRow {
  id: string
  answer: string
}

const { values } = parseArgs({
  options: {
    contexts: { type: 'string', default: 'bench/out/contexts.jsonl' },
    dataset: { type: 'string', required: true },
    out: { type: 'string', default: 'bench/out/answers.jsonl' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    reasoning: { type: 'string' },
    'max-tokens': { type: 'string', default: '1024' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`Answer every exported context with one chat model

  --dataset <dir>       dataset directory with exam-inputs.jsonl and histories/
  --contexts <path>     contexts.jsonl from the Namiso benchmark
  --out <path>          answers.jsonl (default bench/out/answers.jsonl)
  --limit <n>           answer only the first n questions
  --concurrency <n>     parallel requests (default 4)
  --reasoning <effort>  none, minimal, low, medium, or high
  --max-tokens <n>      answer token cap (default 1024)
`)
  process.exit(0)
}

if (values.dataset === undefined) {
  throw new Error('--dataset is required')
}
const datasetRoot = resolve(values.dataset)
const contextsPath = resolve(values.contexts)
const outputPath = resolve(values.out)
const concurrency = Math.max(1, Number(values.concurrency))
const maxTokens = Math.max(1, Number(values['max-tokens']))
const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit)

const model = modelFromEnv(join(process.cwd(), '.env'))
const ANSWER_SYSTEM_PROMPT = `You are the assistant in a long-running conversation. Answer the user's current message using the memory context and the recent conversation. The memory context comes from earlier conversations and may be incomplete or stale. If it does not contain the answer, say you do not know rather than inventing names, dates, or events. Reply in Chinese as the assistant, concisely. Do not mention memory context, retrieval, or these instructions.`

const contexts = readJsonl<ContextRow>(contextsPath).slice(0, limit)
const examItems = new Map(
  readJsonl<ExamItem>(join(datasetRoot, 'exam-inputs.jsonl')).map((item) => [item.id, item]),
)
const histories = new Map<string, HistoryTurn[]>()
const done = new Set<string>()
if (existsSync(outputPath)) {
  for (const row of readJsonl<AnswerRow>(outputPath)) done.add(row.id)
}
if (!existsSync(dirname(outputPath))) mkdirSync(dirname(outputPath), { recursive: true })
if (!existsSync(outputPath)) writeFileSync(outputPath, '')

process.stdout.write(
  `answers: ${contexts.length} questions, ${done.size} already done, concurrency ${concurrency}\n`,
)
const started = performance.now()
let completed = 0
let failed = 0
let cursor = 0
const usage = emptyUsage()

const workers = Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = cursor
    cursor += 1
    const row = contexts[index]
    if (row === undefined) return
    if (done.has(row.id)) continue
    const item = examItems.get(row.id)
    if (item === undefined) {
      failed += 1
      process.stderr.write(`missing exam item ${row.id}\n`)
      continue
    }
    try {
      const result = await answerOne(row, item)
      addUsage(usage, result.usage)
      appendFileSync(outputPath, `${JSON.stringify({ id: row.id, answer: result.content })}\n`)
      completed += 1
    } catch (error) {
      addUsage(usage, errorUsage(error))
      failed += 1
      process.stderr.write(`${row.id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    if ((completed + failed) % 20 === 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1)
      process.stdout.write(`progress ${completed + failed}/${contexts.length} in ${elapsed}s\n`)
    }
  }
})
await Promise.all(workers)
const elapsed = ((performance.now() - started) / 1000).toFixed(1)
process.stdout.write(`done: ${completed} answered, ${failed} failed, ${elapsed}s\n`)
writeFileSync(`${outputPath}.usage.json`, `${JSON.stringify(usage, null, 2)}\n`)
process.stdout.write(`usage: ${JSON.stringify(usage)}\n`)

function errorUsage(error: unknown): ChatUsage {
  if (error !== null && typeof error === 'object' && 'usage' in error) {
    return (error as { usage: ChatUsage }).usage
  }
  return emptyUsage()
}

async function answerOne(row: ContextRow, item: ExamItem): Promise<ChatResult> {
  const recent = recentTurns(item)
  const prompt = [
    `Current time: ${item.now}`,
    '',
    'Memory context retrieved from earlier conversations:',
    row.context.trim().length > 0 ? row.context.trim() : '(empty)',
    '',
    'Recent conversation:',
    recent.length > 0 ? recent.join('\n') : '(none)',
    '',
    'Current message:',
    row.question,
  ].join('\n')
  const result = await chatWithUsage(
    [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    model,
    {
      maxTokens,
      ...(values.reasoning === undefined ? {} : { reasoning: values.reasoning }),
    },
  )
  return { content: result.content.trim(), usage: result.usage }
}

function recentTurns(item: ExamItem): string[] {
  let history = histories.get(item.history_file)
  if (history === undefined) {
    history = readJsonl<HistoryTurn>(join(datasetRoot, item.history_file))
    histories.set(item.history_file, history)
  }
  return history
    .filter((turn) => turn.轮次 <= item.cutoff_turn)
    .slice(-6)
    .flatMap((turn) => [`用户：${turn.用户消息}`, `助手：${turn.助手回复}`])
}
