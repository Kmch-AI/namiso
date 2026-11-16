export const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export interface Civil {
  year: number
  month: number
  day: number
}

export interface CivilTime extends Civil {
  hour: number
  minute: number
  second: number
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

export function civilOf(epoch: number, timeZone: string): CivilTime {
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

export function zonedEpoch(civil: Civil, timeZone: string): number {
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

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function addDays(civil: Civil, days: number): Civil {
  const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

export function addMonths(civil: Civil, months: number): Civil {
  const date = new Date(Date.UTC(civil.year, civil.month - 1 + months, 1))
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  return { year, month, day: Math.min(civil.day, daysInMonth(year, month)) }
}

export function isoWeekday(civil: Civil): number {
  const day = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay()
  return day === 0 ? 7 : day
}

export function compareCivil(left: Civil, right: Civil): number {
  return left.year - right.year || left.month - right.month || left.day - right.day
}

export function formatDay(epoch: number, timeZone: string, key: number | null = null): string {
  return formatDayKey(key === null ? dayKey(epoch, timeZone) : key)
}

export function dayStart(epoch: number, timeZone: string, offsetDays = 0): number {
  return zonedEpoch(addDays(civilOf(epoch, timeZone), offsetDays), timeZone)
}

export function dayKey(epoch: number, timeZone: string): number {
  const civil = civilOf(epoch, timeZone)
  return civil.year * 10_000 + civil.month * 100 + civil.day
}

export function dayKeyOf(civil: Civil): number {
  return civil.year * 10_000 + civil.month * 100 + civil.day
}

export function civilOfDayKey(key: number): Civil {
  return { year: Math.trunc(key / 10_000), month: Math.trunc(key / 100) % 100, day: key % 100 }
}

export function formatDayKey(key: number): string {
  const civil = civilOfDayKey(key)
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(civil.year, civil.month - 1, civil.day)),
  )
  return `${civil.year}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}（${weekday}）`
}
