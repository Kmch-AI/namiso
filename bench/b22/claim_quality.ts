import { DatabaseSync } from 'node:sqlite'

import { out } from './out.ts'

const path = process.argv[2] ?? 'bench/b22/db/b22/natural-M01-0f99dd51.db'
const db = new DatabaseSync(path, { readOnly: true })
const rows = db
  .prepare(`SELECT predicate, attribute, object_value, status FROM claims`)
  .all() as Array<{
  predicate: string
  attribute: string
  object_value: string | null
  status: string
}>
const total = rows.length
const short = rows.filter((row) => Array.from(row.predicate.trim()).length <= 2)
const bare = rows.filter((row) => Array.from(row.attribute.trim()).length <= 2)
const counts = new Map<string, number>()
for (const row of short) counts.set(row.predicate, (counts.get(row.predicate) ?? 0) + 1)
const top = [...counts.entries()].toSorted((left, right) => right[1] - left[1]).slice(0, 15)
const groups = new Map<string, Set<string>>()
for (const row of rows) {
  if (row.status !== 'active') continue
  const key = `${row.predicate}\u0000${row.attribute}`
  const values = groups.get(key) ?? new Set<string>()
  values.add(row.object_value ?? '')
  groups.set(key, values)
}
const crowded = [...groups.entries()].filter(([, values]) => values.size > 3)
out(path)
out(
  `claims=${total} predicate<=2=${((short.length / total) * 100).toFixed(1)}% attribute<=2=${((bare.length / total) * 100).toFixed(1)}%`,
)
out(`top short predicates: ${top.map(([name, count]) => `${name}:${count}`).join(' ')}`)
out(
  `crowded groups=${crowded.length} claims in them=${crowded.reduce((sum, [, values]) => sum + values.size, 0)}`,
)
const objectLen = rows
  .map((row) => Array.from(row.object_value ?? '').length)
  .toSorted((left, right) => left - right)
out(`object chars p50=${objectLen[Math.floor(objectLen.length / 2)]}`)
db.close()
