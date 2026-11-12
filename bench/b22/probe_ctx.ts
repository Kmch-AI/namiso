import { DatabaseSync } from 'node:sqlite'

import { Namiso } from '../../src/namiso.ts'
import { providersFromEnv } from '../../src/providers/from-env.ts'
import { out } from './out.ts'

const databasePath = process.argv[2] ?? 'bench/out/temporal/M01-G019_s1.db'
const query = process.argv[3] ?? '今天还是周日吧，我那事儿到底去不去啊'
const now = Math.floor(Date.parse(process.argv[4] ?? '2026-11-08T11:20:47+08:00') / 1000)

const raw = new DatabaseSync(databasePath, { readOnly: true })
const spaces = raw
  .prepare(`SELECT memory_space_id AS id, COUNT(*) AS count FROM messages GROUP BY memory_space_id`)
  .all() as Array<{ id: string; count: number }>
raw.close()
out('spaces:', spaces.map((row) => `${row.id}=${row.count}`).join(' '))

const spaceId = process.env.SPACE ?? spaces[0]?.id ?? ''
const namiso = await Namiso.open({
  databasePath,
  memorySpace: { name: spaceId },
  vectorIndex: 'auto',
  ...providersFromEnv(),
})

const context = await namiso.getContext({
  query,
  maxTokens: 1600,
  topK: 12,
  now,
  timeZone: 'Asia/Shanghai',
})
out('items:', context.items.length)
for (const item of context.items) {
  const at =
    item.occurredAt === null
      ? '-'
      : new Date((item.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 16)
  out(` ${item.kind} ${at} ${item.title.slice(0, 30)}`)
}
out('---text---')
out(context.text)

namiso.close()
