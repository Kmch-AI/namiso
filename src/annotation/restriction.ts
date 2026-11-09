import type { MemoryDisclosure, MemorySensitivity } from '../types.ts'

export interface Restriction {
  sensitivity: MemorySensitivity
  disclosure: MemoryDisclosure
}

const SENSITIVITY_RANK: Record<MemorySensitivity, number> = { normal: 0, private: 1 }

const DISCLOSURE_RANK: Record<MemoryDisclosure, number> = {
  allowed: 0,
  alias_only: 1,
  do_not_volunteer: 2,
}

export function restrictionOf(input: {
  sensitivity?: MemorySensitivity
  disclosure?: MemoryDisclosure
}): Restriction {
  const sensitivity = input.sensitivity ?? 'normal'
  return {
    sensitivity,
    disclosure: input.disclosure ?? (sensitivity === 'private' ? 'do_not_volunteer' : 'allowed'),
  }
}

export function mergeRestriction(current: Restriction, next: Restriction): Restriction | null {
  const sensitivity =
    SENSITIVITY_RANK[next.sensitivity] > SENSITIVITY_RANK[current.sensitivity]
      ? next.sensitivity
      : current.sensitivity
  const disclosure =
    DISCLOSURE_RANK[next.disclosure] > DISCLOSURE_RANK[current.disclosure]
      ? next.disclosure
      : current.disclosure
  return sensitivity === current.sensitivity && disclosure === current.disclosure
    ? null
    : { sensitivity, disclosure }
}

export function isRestricted(restriction: Restriction): boolean {
  return restriction.sensitivity === 'private' || restriction.disclosure !== 'allowed'
}
