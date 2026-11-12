import { resolveTimeExpressions } from '../retrieval/time-expression.ts'
import {
  addDays,
  civilOf,
  dayKeyOf,
  daysInMonth,
  DEFAULT_TIME_ZONE,
  dayStart,
  zonedEpoch,
} from '../time.ts'

const MAX_DAY_OFFSET = 90
const MAX_APPROXIMATE_OFFSET = 7
const SECONDS_PER_DAY = 86_400
const RECURRING = /每(?:个)?(?:周|星期|礼拜|月|天|日|年)|天天|年年/
const BARE_MONTH_DAY = /^\d{1,2}月\d{1,2}[日号]$/

export interface StatedDay {
  day: number
  dayKey: number
  phrase: string
}

export function resolveStatedDayPhrase(
  text: string,
  base: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): StatedDay | null {
  if (base <= 0) return null
  if (RECURRING.test(text)) return null
  const windows = resolveTimeExpressions(text, base, timeZone).filter(
    (window) => window.granularity === 'day',
  )
  if (windows.length === 0) return null
  const exact = windows.filter((window) => !window.approximate)
  const picked = exact.length > 0 ? exact : windows
  const shifted = forwardYear(picked, base, timeZone)
  const days = new Map<number, string>()
  for (const window of shifted) {
    const day = dayStart(window.from, timeZone)
    if (!days.has(day)) days.set(day, window.text)
  }
  if (days.size !== 1) return null
  const [day, phrase] = days.entries().next().value as [number, string]
  const offset = Math.abs(day - dayStart(base, timeZone)) / SECONDS_PER_DAY
  const limit = shifted.every((window) => window.approximate)
    ? MAX_APPROXIMATE_OFFSET
    : MAX_DAY_OFFSET
  if (offset > limit) return null
  return { day, dayKey: dayKeyOf(civilOf(day, timeZone)), phrase }
}

export function resolveStatedDay(
  text: string,
  base: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): number | null {
  return resolveStatedDayPhrase(text, base, timeZone)?.day ?? null
}

function forwardYear(
  windows: ReturnType<typeof resolveTimeExpressions>,
  base: number,
  timeZone: string,
): ReturnType<typeof resolveTimeExpressions> {
  const baseCivil = civilOf(base, timeZone)
  return windows.map((window) => {
    if (!BARE_MONTH_DAY.test(window.text)) return window
    const civil = civilOf(window.from, timeZone)
    let best = window.from
    let bestDistance = Number.POSITIVE_INFINITY
    for (const year of [baseCivil.year - 1, baseCivil.year, baseCivil.year + 1]) {
      const day = Math.min(civil.day, daysInMonth(year, civil.month))
      const from = zonedEpoch({ year, month: civil.month, day }, timeZone)
      const distance = Math.abs(dayStart(from, timeZone) - dayStart(base, timeZone))
      if (distance < bestDistance) {
        best = from
        bestDistance = distance
      }
    }
    const picked = civilOf(best, timeZone)
    return {
      ...window,
      from: best,
      to: zonedEpoch(addDays(picked, 1), timeZone),
      approximate: false,
    }
  })
}
