import { DatabaseSync } from 'node:sqlite'

import { out } from './out.ts'

const path = process.argv[2] ?? 'bench/out/temporal/M01-G019_s1.db'
const db = new DatabaseSync(path, { readOnly: true })
const rows = db
  .prepare(
    `SELECT status, time_precision, occurred_at, summary, description FROM events
     ORDER BY COALESCE(occurred_at, 0) DESC LIMIT 12`,
  )
  .all() as Array<{
  status: string
  time_precision: string
  occurred_at: number | null
  summary: string
  description: string | null
}>
for (const row of rows) {
  const at =
    row.occurred_at === null
      ? '-'
      : new Date((row.occurred_at + 8 * 3600) * 1000).toISOString().slice(0, 16)
  out(
    row.status,
    row.time_precision,
    at,
    row.summary.slice(0, 30),
    '|',
    (row.description ?? '').slice(0, 40),
  )
}
const hits = db
  .prepare(
    `SELECT summary, occurred_at, time_precision FROM events WHERE summary LIKE '%营业%' OR description LIKE '%营业%'`,
  )
  .all() as Array<{ summary: string; occurred_at: number | null; time_precision: string }>
out('---营业 hits', hits.length)
for (const row of hits) {
  const at =
    row.occurred_at === null
      ? '-'
      : new Date((row.occurred_at + 8 * 3600) * 1000).toISOString().slice(0, 16)
  out(row.time_precision, at, row.summary.slice(0, 40))
}
db.close()
