import { Namiso } from '../../src/namiso.ts'
import { providersFromEnv } from '../../src/providers/from-env.ts'
import { out } from './out.ts'

const databasePath = process.argv[2] ?? 'bench/out/temporal/M01-G019_s1.db'
const space = process.argv[3] ?? 'temporal-M01-G019/s1'
const query = process.argv[4] ?? '刚起床\n汤团在啃我脚\n烦死了'
const now = Math.floor(Date.parse(process.argv[5] ?? '2026-11-08T11:20:47+08:00') / 1000)

const namiso = await Namiso.open({
  databasePath,
  memorySpace: { name: space },
  vectorIndex: 'auto',
  ...providersFromEnv(),
})
const result = await namiso.retrieve({ query, now, timeZone: 'Asia/Shanghai', topK: 50 })
out('notes:', result.trace.notes)
out(
  'channels:',
  result.trace.channels.map((channel) => `${channel.channel}=${channel.count}`).join(' '),
)
out('fused', result.trace.fusedCount, 'reranked', result.trace.rerankedCount)
for (const item of result.candidates.slice(0, 12)) {
  const at =
    item.occurredAt === null
      ? '-'
      : new Date((item.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 16)
  out(` ${item.score.toFixed(4)} ${item.kind} ${at} ${item.title.slice(0, 26)}`)
}
namiso.close()
