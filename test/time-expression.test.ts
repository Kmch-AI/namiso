import assert from 'node:assert/strict'
import { test } from 'vitest'

import { resolveTimeExpressions } from '../src/retrieval/time-expression.ts'

const NOW = Date.parse('2026-04-16T10:00:00+08:00') / 1000
const ZONE = 'Asia/Shanghai'

function resolve(query: string) {
  return resolveTimeExpressions(query, NOW, ZONE)
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function first(query: string) {
  const [window] = resolve(query)
  assert.ok(window !== undefined, `no window for ${query}`)
  return window
}

test('relative days resolve to local half-open days', () => {
  assert.equal(iso(first('今天做了什么').from), '2026-04-15T16:00:00.000Z')
  assert.equal(iso(first('昨天做了什么').from), '2026-04-14T16:00:00.000Z')
  assert.equal(iso(first('前天做了什么').from), '2026-04-13T16:00:00.000Z')
  assert.equal(iso(first('明天做什么').from), '2026-04-16T16:00:00.000Z')
  assert.equal(iso(first('后天做什么').from), '2026-04-17T16:00:00.000Z')
  const yesterday = first('昨天做了什么')
  assert.equal(yesterday.to - yesterday.from, 86_400)
  assert.equal(yesterday.granularity, 'day')
  assert.equal(yesterday.approximate, false)
})

test('weekday expressions respect the qualifier', () => {
  assert.equal(iso(first('上周三').from), '2026-04-07T16:00:00.000Z')
  assert.equal(iso(first('这周三').from), '2026-04-14T16:00:00.000Z')
  assert.equal(iso(first('下周三').from), '2026-04-21T16:00:00.000Z')
  assert.equal(iso(first('last friday').from), '2026-04-09T16:00:00.000Z')
})

test('counted and calendar expressions resolve', () => {
  assert.equal(iso(first('3天前发生了什么').from), '2026-04-12T16:00:00.000Z')
  assert.equal(iso(first('两周后').from), '2026-04-26T16:00:00.000Z')
  const lastMonth = first('上个月')
  assert.equal(iso(lastMonth.from), '2026-02-28T16:00:00.000Z')
  assert.equal(iso(lastMonth.to), '2026-03-31T16:00:00.000Z')
  const lastYear = first('去年')
  assert.equal(iso(lastYear.from), '2024-12-31T16:00:00.000Z')
  assert.equal(iso(lastYear.to), '2025-12-31T16:00:00.000Z')
})

test('absolute dates keep their bounds and mark an implied year approximate', () => {
  const exact = first('2026-03-02')
  assert.equal(iso(exact.from), '2026-03-01T16:00:00.000Z')
  assert.equal(exact.granularity, 'day')
  assert.equal(exact.approximate, false)
  const implied = first('3月2日')
  assert.equal(iso(implied.from), '2026-03-01T16:00:00.000Z')
  assert.equal(implied.approximate, true)
  const month = first('2025年12月')
  assert.equal(iso(month.from), '2025-11-30T16:00:00.000Z')
  assert.equal(iso(month.to), '2025-12-31T16:00:00.000Z')
  assert.equal(month.granularity, 'month')
})

test('english expressions resolve', () => {
  assert.equal(iso(first('yesterday').from), '2026-04-14T16:00:00.000Z')
  assert.equal(iso(first('3 days ago').from), '2026-04-12T16:00:00.000Z')
  const lastWeek = first('last week')
  assert.equal(iso(lastWeek.from), '2026-04-05T16:00:00.000Z')
  assert.equal(iso(lastWeek.to), '2026-04-12T16:00:00.000Z')
})

test('open ranges and memory-free queries produce no window', () => {
  assert.deepEqual(resolve('4月15日之前发生了什么'), [])
  assert.deepEqual(resolve('2026-03-02以后'), [])
  assert.deepEqual(resolve('我喜欢评弹'), [])
  assert.deepEqual(resolve('我的储物柜密码是什么'), [])
})

test('multiple expressions are returned in source order', () => {
  const windows = resolve('上个月去了苏州，这个月去了杭州')
  assert.equal(windows.length, 2)
  assert.equal(windows[0]?.text, '上个月')
  assert.equal(windows[1]?.text, '这个月')
})

test('the day boundary follows the requested zone', () => {
  const lateNight = Date.parse('2026-04-16T00:30:00+08:00') / 1000
  const [window] = resolveTimeExpressions('今天', lateNight, ZONE)
  assert.ok(window !== undefined)
  assert.equal(iso(window.from), '2026-04-15T16:00:00.000Z')
  const utc = resolveTimeExpressions('今天', Date.parse('2026-04-16T00:30:00Z') / 1000, 'UTC')
  assert.equal(iso(utc[0]?.from ?? 0), '2026-04-16T00:00:00.000Z')
})
