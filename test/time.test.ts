import assert from 'node:assert/strict'
import { test } from 'vitest'

import { civilOfDayKey, dayKey, dayStart, formatDayKey } from '../src/time.ts'

const EPOCH = 1_788_601_500

test('a calendar day reads the same in every time zone', () => {
  for (const zone of ['Asia/Shanghai', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    assert.equal(dayKey(EPOCH, zone), 20_260_905)
  }
})

test('a day key renders without a zone shift', () => {
  assert.equal(formatDayKey(20_260_905), '2026-09-05（周二）')
  assert.deepEqual(civilOfDayKey(20_260_905), { year: 2026, month: 9, day: 5 })
})

test('day bounds still resolve in the reader zone', () => {
  assert.equal(dayStart(EPOCH, 'Asia/Shanghai'), 1_788_537_600)
  assert.equal(dayStart(EPOCH, 'UTC'), 1_788_566_400)
  assert.equal(dayStart(EPOCH, 'Asia/Shanghai', 2) - dayStart(EPOCH, 'Asia/Shanghai'), 172_800)
})
