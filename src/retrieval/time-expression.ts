import type { TimeWindow } from '../types.ts'

interface Civil {
  year: number
  month: number
  day: number
}

interface CivilTime extends Civil {
  hour: number
  minute: number
  second: number
}

const DAY_SECONDS = 86_400

const WEEKDAYS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
}

const ENGLISH_WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
}

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const OPEN_BEFORE = /(?:之前|以前|以前|之前|以来|before|until|since)\s*$/i
const OPEN_AFTER = /^\s*(?:之前|以前|之后|以后|以来|after|before|since)/i

export function resolveTimeExpressions(query: string, now: number, timeZone: string): TimeWindow[] {
  const text = query.normalize('NFKC')
  const nowCivil = civilOf(now, timeZone)
  const matches: TimeWindow[] = []
  const consumed: Array<[number, number]> = []

  const free = (start: number, end: number): boolean =>
    !consumed.some(([left, right]) => start < right && end > left)

  const take = (pattern: RegExp, build: (match: RegExpMatchArray) => TimeWindow | null): void => {
    for (const match of text.matchAll(pattern)) {
      const index = match.index
      if (index === undefined) continue
      const end = index + match[0].length
      if (!free(index, end)) continue
      consumed.push([index, end])
      if (isOpenRange(text, index, end)) continue
      const expression = build(match)
      if (expression !== null) matches.push(expression)
    }
  }

  take(/(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g, (match) => {
    const civil = civilFrom(match[1], match[2], match[3])
    return civil === null ? null : dayExpression(match[0], civil, false, timeZone)
  })
  take(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g, (match) => {
    const civil = civilFrom(match[1], match[2], match[3])
    return civil === null ? null : dayExpression(match[0], civil, false, timeZone)
  })
  take(/(\d{4})年(\d{1,2})月/g, (match) => {
    const year = Number(match[1])
    const month = Number(match[2])
    return month >= 1 && month <= 12
      ? monthExpression(match[0], { year, month }, false, timeZone)
      : null
  })
  take(/(?<!\d)(\d{4})年/g, (match) => {
    const year = Number(match[1])
    return year >= 1900 && year <= 2200 ? yearExpression(match[0], year, false, timeZone) : null
  })
  take(/(\d{1,2})月(\d{1,2})[日号]/g, (match) => {
    const civil = pastCivil(nowCivil, Number(match[1]), Number(match[2]))
    return civil === null ? null : dayExpression(match[0], civil, true, timeZone)
  })
  take(/(\d{1,2})月/g, (match) => {
    const month = Number(match[1])
    return month >= 1 && month <= 12
      ? monthExpression(match[0], { year: nowCivil.year, month }, true, timeZone)
      : null
  })
  take(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g, (match) => {
    const civil = pastCivil(nowCivil, Number(match[1]), Number(match[2]))
    return civil === null ? null : dayExpression(match[0], civil, true, timeZone)
  })
  take(/今天|今日|今晚|今早|today/gi, (match) => dayExpression(match[0], nowCivil, false, timeZone))
  take(/昨天|昨日|昨晚|yesterday/gi, (match) =>
    dayExpression(match[0], addDays(nowCivil, -1), false, timeZone),
  )
  take(/前天|the day before yesterday/gi, (match) =>
    dayExpression(match[0], addDays(nowCivil, -2), false, timeZone),
  )
  take(/明天|明日|明晚|tomorrow/gi, (match) =>
    dayExpression(match[0], addDays(nowCivil, 1), false, timeZone),
  )
  take(/后天|the day after tomorrow/gi, (match) =>
    dayExpression(match[0], addDays(nowCivil, 2), false, timeZone),
  )
  take(/(上|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g, (match) => {
    const weekday = WEEKDAYS[match[2] ?? '']
    if (weekday === undefined) return null
    return weekdayExpression(match[0], nowCivil, weekday, match[1], timeZone)
  })
  take(
    /\b(last|next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    (match) => {
      const weekday = ENGLISH_WEEKDAYS[(match[2] ?? '').toLowerCase()]
      if (weekday === undefined) return null
      return weekdayExpression(match[0], nowCivil, weekday, match[1]?.toLowerCase(), timeZone)
    },
  )
  take(
    /(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|个?月|年)\s*(?:前|以前|之前|后|以后|之后)/g,
    (match) => {
      const count = parseCount(match[1] ?? '')
      if (count === null) return null
      const unit = match[2] ?? ''
      const future = /后/.test(match[0])
      return relativeExpression(match[0], nowCivil, count, unit, future, timeZone)
    },
  )
  take(/\b(\d+)\s*(days?|weeks?|months?|years?)\s*(ago|later|from now)\b/gi, (match) => {
    const count = Number(match[1])
    const future = (match[3] ?? '').toLowerCase() !== 'ago'
    return relativeExpression(match[0], nowCivil, count, match[2] ?? '', future, timeZone)
  })
  take(/(?:本月|这个月|当月|this month)/gi, (match) =>
    monthExpression(match[0], { year: nowCivil.year, month: nowCivil.month }, false, timeZone),
  )
  take(/(?:上个月|上月|last month)/gi, (match) =>
    monthExpression(match[0], addMonths(nowCivil, -1), false, timeZone),
  )
  take(/(?:下个月|下月|next month)/gi, (match) =>
    monthExpression(match[0], addMonths(nowCivil, 1), false, timeZone),
  )
  take(/(?:今年|本年|this year)/gi, (match) =>
    yearExpression(match[0], nowCivil.year, false, timeZone),
  )
  take(/(?:去年|last year)/gi, (match) =>
    yearExpression(match[0], nowCivil.year - 1, false, timeZone),
  )
  take(/(?:明年|next year)/gi, (match) =>
    yearExpression(match[0], nowCivil.year + 1, false, timeZone),
  )
  take(/(?:这周|本周|这个星期|this week)/gi, (match) =>
    weekExpression(match[0], nowCivil, 0, timeZone),
  )
  take(/(?:上周|上个星期|last week)/gi, (match) => weekExpression(match[0], nowCivil, -1, timeZone))
  take(/(?:下周|下个星期|next week)/gi, (match) => weekExpression(match[0], nowCivil, 1, timeZone))

  return matches.toSorted((left, right) => left.from - right.from)
}

function isOpenRange(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 8), start)
  const after = text.slice(end, Math.min(text.length, end + 8))
  return OPEN_BEFORE.test(before) || OPEN_AFTER.test(after)
}

function civilFrom(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): Civil | null {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null
  if (!Number.isInteger(m) || m < 1 || m > 12) return null
  if (!Number.isInteger(d) || d < 1 || d > daysInMonth(y, m)) return null
  return { year: y, month: m, day: d }
}

function pastCivil(now: Civil, month: number, day: number): Civil | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(now.year, month)) return null
  const candidateCivil = { year: now.year, month, day }
  if (compareCivil(candidateCivil, now) > 0) return { year: now.year - 1, month, day }
  return candidateCivil
}

function compareCivil(left: Civil, right: Civil): number {
  return left.year - right.year || left.month - right.month || left.day - right.day
}

function dayExpression(
  text: string,
  civil: Civil,
  approximate: boolean,
  timeZone: string,
): TimeWindow {
  const from = zonedEpoch(civil, timeZone)
  return {
    text,
    from,
    to: from + DAY_SECONDS,
    granularity: 'day',
    approximate,
  }
}

function monthExpression(
  text: string,
  civil: { year: number; month: number },
  approximate: boolean,
  timeZone: string,
): TimeWindow {
  const from = zonedEpoch({ year: civil.year, month: civil.month, day: 1 }, timeZone)
  const next = addMonths({ year: civil.year, month: civil.month, day: 1 }, 1)
  return {
    text,
    from,
    to: zonedEpoch(next, timeZone),
    granularity: 'month',
    approximate,
  }
}

function yearExpression(
  text: string,
  year: number,
  approximate: boolean,
  timeZone: string,
): TimeWindow {
  return {
    text,
    from: zonedEpoch({ year, month: 1, day: 1 }, timeZone),
    to: zonedEpoch({ year: year + 1, month: 1, day: 1 }, timeZone),
    granularity: 'year',
    approximate,
  }
}

function weekExpression(text: string, now: Civil, offset: number, timeZone: string): TimeWindow {
  const start = addDays(now, -isoWeekday(now) + 1 + offset * 7)
  const from = zonedEpoch(start, timeZone)
  return {
    text,
    from,
    to: from + 7 * DAY_SECONDS,
    granularity: 'week',
    approximate: false,
  }
}

function weekdayExpression(
  text: string,
  now: Civil,
  weekday: number,
  qualifier: string | undefined,
  timeZone: string,
): TimeWindow {
  let delta = weekday - isoWeekday(now)
  if (qualifier === '上' || qualifier === 'last') delta -= 7
  if (qualifier === '下' || qualifier === 'next') delta += 7
  return dayExpression(text, addDays(now, delta), false, timeZone)
}

function relativeExpression(
  text: string,
  now: Civil,
  count: number,
  unit: string,
  future: boolean,
  timeZone: string,
): TimeWindow | null {
  if (count < 0) return null
  const direction = future ? 1 : -1
  if (unit === '天' || unit === '日' || unit.startsWith('day')) {
    return dayExpression(text, addDays(now, direction * count), false, timeZone)
  }
  if (unit === '周' || unit.startsWith('week')) {
    return weekExpression(text, addDays(now, direction * count * 7), 0, timeZone)
  }
  if (unit === '月' || unit === '个月' || unit.startsWith('month')) {
    const target = addMonths(now, direction * count)
    return monthExpression(text, target, false, timeZone)
  }
  if (unit === '年' || unit.startsWith('year')) {
    return yearExpression(text, now.year + direction * count, false, timeZone)
  }
  return null
}

function parseCount(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value)
  const ten = value.indexOf('十')
  if (ten === -1) {
    const digit = CHINESE_DIGITS[value]
    return digit === undefined ? null : digit
  }
  const left = value.slice(0, ten)
  const right = value.slice(ten + 1)
  const tens = left.length === 0 ? 1 : (CHINESE_DIGITS[left] ?? 0)
  const ones = right.length === 0 ? 0 : (CHINESE_DIGITS[right] ?? -100)
  if (ones < 0) return null
  return tens * 10 + ones
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function addDays(civil: Civil, days: number): Civil {
  const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

function addMonths(civil: Civil, months: number): Civil {
  const date = new Date(Date.UTC(civil.year, civil.month - 1 + months, 1))
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  return { year, month, day: Math.min(civil.day, daysInMonth(year, month)) }
}

function isoWeekday(civil: Civil): number {
  const day = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay()
  return day === 0 ? 7 : day
}

const CIVIL_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function civilFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = CIVIL_FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  CIVIL_FORMATTERS.set(timeZone, formatter)
  return formatter
}

function civilOf(epoch: number, timeZone: string): CivilTime {
  const parts = civilFormatter(timeZone).formatToParts(new Date(epoch * 1000))
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value ?? 0)
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  }
}

function zonedEpoch(civil: Civil, timeZone: string): number {
  const target = Date.UTC(civil.year, civil.month - 1, civil.day) / 1000
  let epoch = target
  for (let step = 0; step < 3; step += 1) {
    const local = civilOf(epoch, timeZone)
    const asUtc =
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) /
      1000
    const difference = target - asUtc
    if (difference === 0) break
    epoch += difference
  }
  return epoch
}
