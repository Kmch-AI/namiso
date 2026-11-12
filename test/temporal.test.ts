import assert from 'node:assert/strict'
import { test } from 'vitest'

import { resolveStatedDay } from '../src/annotation/temporal.ts'
import { resolveTimeExpressions } from '../src/retrieval/time-expression.ts'

const ZONE = 'Asia/Shanghai'

function at(text: string): number {
  return Date.parse(text) / 1000
}

function day(epoch: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epoch * 1000))
}

test('a stated day resolves to the day the sentence means', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(day(resolveStatedDay('快递后天到驿站', base, ZONE) ?? 0), '2026-09-07')
})

test('weekday qualifiers pick this week or next week', () => {
  const base = at('2026-04-16T10:00:00+08:00')
  assert.equal(day(resolveStatedDay('这周日我自己跑一趟', base, ZONE) ?? 0), '2026-04-19')
  assert.equal(day(resolveStatedDay('下周二考科目二', base, ZONE) ?? 0), '2026-04-21')
})

test('a resolution that lands far from the statement is refused', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(resolveStatedDay('去年冬天去过一次', base, ZONE), null)
})

test('no day expression means no day', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(resolveStatedDay('汤团啃了一下午脚', base, ZONE), null)
})

test('two different days in one sentence are ambiguous', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(resolveStatedDay('昨天没去，明天再去', base, ZONE), null)
})

test('the day a window starts on is the day it names', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  const [window] = resolveTimeExpressions('后天', base, ZONE)
  assert.ok(window !== undefined)
  assert.equal(day(window.from), '2026-09-07')
})

test('a bare month-day lands on the nearest year', () => {
  const spring = at('2026-03-10T10:00:00+08:00')
  assert.equal(day(resolveStatedDay('4月15日交房租', spring, ZONE) ?? 0), '2026-04-15')
  const summer = at('2026-05-10T10:00:00+08:00')
  assert.equal(day(resolveStatedDay('4月15日交房租', summer, ZONE) ?? 0), '2026-04-15')
})

test('a recurrence is not a single day', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(resolveStatedDay('每周三打羽毛球', base, ZONE), null)
})

test('the ninety day boundary counts calendar days', () => {
  const base = at('2026-09-05T10:00:00+08:00')
  assert.equal(day(resolveStatedDay('90天前体检', base, ZONE) ?? 0), '2026-06-07')
  assert.equal(resolveStatedDay('91天前体检', base, ZONE), null)
})
