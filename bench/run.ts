import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import type { BenchmarkReport, ItemResult } from './chat-memory-benchmark.ts'

import { providersFromEnv } from '../src/index.ts'
import { runBenchmark } from './chat-memory-benchmark.ts'

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'bench/fixtures/mini' },
    out: { type: 'string', default: 'bench/out' },
    limit: { type: 'string' },
    persona: { type: 'string' },
    'max-tokens': { type: 'string' },
    'top-k': { type: 'string' },
    mode: { type: 'string', default: 'hybrid' },
    models: { type: 'boolean', default: false },
    db: { type: 'string' },
    items: { type: 'string' },
    'consolidate-batch': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`Namiso benchmark runner

  --dataset <path>   chat-memory-benchmark repo, demo, or dataset directory
  --out <dir>        output directory (default bench/out)
  --limit <n>        evaluate at most n questions
  --persona <id>     restrict to one persona
  --max-tokens <n>   context token budget (default 1600)
  --top-k <n>        retrieval depth (default 12)
  --mode <mode>      hybrid (default) or raw chunk baseline
  --models           read NAMISO_* provider variables and call real models
  --db <path>        persistent database for resumable runs
  --items <path>     append every finished item; existing ids are skipped
  --consolidate-batch <n>  extraction batch size (default 32)
`)
  process.exit(0)
}

try {
  const providers = values.models ? providersFromEnv(process.env) : undefined
  if (values.models && Object.keys(providers ?? {}).length === 0) {
    process.stdout.write('No NAMISO_* provider variables found; using default providers.\n')
  }
  const databasePath = values.db === undefined ? undefined : resolve(values.db)
  const itemsPath = values.items === undefined ? undefined : resolve(values.items)
  const completedIds = new Set<string>()
  if (itemsPath !== undefined && existsSync(itemsPath)) {
    for (const line of readFileSync(itemsPath, 'utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as ItemResult
        if (parsed.error === undefined) completedIds.add(parsed.id)
      } catch {
        continue
      }
    }
  }
  if (completedIds.size > 0 && databasePath === undefined) {
    throw new Error('resuming from --items requires --db with the same persistent database')
  }
  if (itemsPath !== undefined && !existsSync(dirname(itemsPath))) {
    mkdirSync(dirname(itemsPath), { recursive: true })
  }
  const { report, results } = await runBenchmark({
    datasetPath: values.dataset,
    ...(itemsPath === undefined ? { outputDir: values.out } : {}),
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.persona === undefined ? {} : { persona: values.persona }),
    ...(values['max-tokens'] === undefined ? {} : { maxTokens: Number(values['max-tokens']) }),
    ...(values['top-k'] === undefined ? {} : { topK: Number(values['top-k']) }),
    ...(values.mode === 'raw' ? { mode: 'raw' as const } : {}),
    ...(providers === undefined ? {} : { providers }),
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(values['consolidate-batch'] === undefined
      ? {}
      : { consolidateBatch: Number(values['consolidate-batch']) }),
    ...(completedIds.size === 0 ? {} : { completedIds }),
    ...(itemsPath === undefined
      ? {}
      : {
          onItemResult: (result) => {
            if (result.error !== undefined) return
            appendFileSync(itemsPath, `${JSON.stringify(result)}\n`)
          },
        }),
    onProgress: (message) => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(`${formatReport(report)}\n`)
  const usage = providers?.extraction?.usage
  if (usage !== undefined) {
    process.stdout.write(
      `extraction usage: prompt=${usage.promptTokens} completion=${usage.completionTokens} reasoning=${usage.reasoningTokens} total=${usage.totalTokens}\n`,
    )
  }
  const failures = results.filter((result) => result.error !== undefined)
  if (failures.length > 0) {
    process.stdout.write(`\nFailures:\n`)
    for (const failure of failures) {
      process.stdout.write(`- ${failure.id}: ${failure.error ?? ''}\n`)
    }
  }
  process.stdout.write(
    itemsPath === undefined
      ? `\nContexts: ${values.out}/contexts.jsonl\n`
      : `\nItems: ${itemsPath}\n`,
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function formatReport(report: BenchmarkReport): string {
  const lines = [
    'Namiso benchmark',
    `dataset: ${report.datasetRoot}`,
    `mode: ${report.mode}`,
    `providers: embedding=${report.providers.embedding} extraction=${report.providers.extraction} reranker=${report.providers.reranker}`,
    `items: ${report.items} | scored: ${report.scoredItems} | personas: ${report.personas} | turns: ${report.turnsIngested}`,
    `ingest: ${report.ingestMs} ms`,
    `consolidation batches: ${report.consolidationBatches}`,
    `evidence recall: ${formatRate(report.evidenceRecall)}`,
    `context hit rate: ${formatRate(report.contextHitRate)}`,
    `context tokens p50/p95/max: ${report.contextTokens.p50}/${report.contextTokens.p95}/${report.contextTokens.max}`,
    `retrieval latency ms p50/p95/min/max: ${report.retrievalLatencyMs.p50}/${report.retrievalLatencyMs.p95}/${report.retrievalLatencyMs.min}/${report.retrievalLatencyMs.max}`,
    `errors: ${report.errors}`,
  ]
  for (const [label, bucket] of Object.entries(report.byInterval)) {
    lines.push(
      `  ${label}: items=${bucket.items} recall=${formatRate(bucket.evidenceRecall)} hit=${formatRate(bucket.contextHitRate)}`,
    )
  }
  lines.push('notes:')
  for (const note of report.notes) lines.push(`  - ${note}`)
  return lines.join('\n')
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}
