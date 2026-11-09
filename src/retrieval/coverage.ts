import type { CoverageTrace, MemoryCandidate } from '../types.ts'
import type { QueryFacet } from './query-analysis.ts'

import { segment } from '../text.ts'

const COVERAGE_FLOOR_RATIO = 0.25
const MMR_LAMBDA = 0.7

interface CoverageEntry {
  item: MemoryCandidate
  tokens: ReadonlySet<string>
  entities: ReadonlySet<string>
}

export interface CoverageInput {
  topK: number
  facets: readonly QueryFacet[]
  entityIds: readonly string[]
}

export interface CoverageResult {
  selected: MemoryCandidate[]
  trace: CoverageTrace
}

export function selectWithCoverage(
  ranked: readonly MemoryCandidate[],
  input: CoverageInput,
): CoverageResult {
  const requested = Number.isFinite(input.topK) ? Math.floor(input.topK) : 1
  const limit = Math.min(Math.max(1, requested), ranked.length)
  if (limit <= 0) {
    return {
      selected: [],
      trace: { floor: 0, facets: [], entities: [] },
    }
  }
  const entries = ranked.map(toEntry)
  const first = entries[0]
  if (first === undefined) {
    return {
      selected: [],
      trace: { floor: 0, facets: [], entities: [] },
    }
  }
  const floor = first.item.score * COVERAGE_FLOOR_RATIO
  const picked = new Set<number>()
  const selected: CoverageEntry[] = []
  const take = (index: number): void => {
    const entry = entries[index]
    if (entry === undefined) return
    picked.add(index)
    selected.push(entry)
  }
  take(0)

  const facetTrace: CoverageTrace['facets'] = []
  for (const facet of input.facets) {
    const need = Math.max(1, Math.ceil(facet.tokens.size / 2))
    const covered = selected.find((entry) => overlap(entry.tokens, facet.tokens) >= need)
    if (covered !== undefined) {
      facetTrace.push({ text: facet.text, key: covered.item.key, added: false })
      continue
    }
    if (selected.length >= limit) {
      facetTrace.push({ text: facet.text, key: null, added: false })
      continue
    }
    const index = entries.findIndex(
      (entry, position) =>
        !picked.has(position) &&
        entry.item.score >= floor &&
        overlap(entry.tokens, facet.tokens) >= need,
    )
    if (index === -1) {
      facetTrace.push({ text: facet.text, key: null, added: false })
      continue
    }
    take(index)
    facetTrace.push({ text: facet.text, key: entries[index]?.item.key ?? null, added: true })
  }

  const entityTrace: CoverageTrace['entities'] = []
  for (const entityId of input.entityIds) {
    const covered = selected.find((entry) => entry.entities.has(entityId))
    if (covered !== undefined) {
      entityTrace.push({ entityId, key: covered.item.key, added: false })
      continue
    }
    if (selected.length >= limit) {
      entityTrace.push({ entityId, key: null, added: false })
      continue
    }
    const index = entries.findIndex(
      (entry, position) =>
        !picked.has(position) && entry.item.score >= floor && entry.entities.has(entityId),
    )
    if (index === -1) {
      entityTrace.push({ entityId, key: null, added: false })
      continue
    }
    take(index)
    entityTrace.push({ entityId, key: entries[index]?.item.key ?? null, added: true })
  }

  while (selected.length < limit) {
    let bestIndex = -1
    let bestValue = -Infinity
    for (const [position, entry] of entries.entries()) {
      if (picked.has(position)) continue
      const similarity = maxSimilarity(entry.tokens, selected)
      const value = MMR_LAMBDA * entry.item.score - (1 - MMR_LAMBDA) * similarity
      const bestEntry = bestIndex === -1 ? undefined : entries[bestIndex]
      if (
        value > bestValue ||
        (value === bestValue && bestEntry !== undefined && entry.item.score > bestEntry.item.score)
      ) {
        bestValue = value
        bestIndex = position
      }
    }
    if (bestIndex === -1) break
    take(bestIndex)
  }

  return {
    selected: selected
      .map((entry) => entry.item)
      .toSorted((left, right) => right.score - left.score),
    trace: { floor, facets: facetTrace, entities: entityTrace },
  }
}

function toEntry(item: MemoryCandidate): CoverageEntry {
  return {
    item,
    tokens: new Set(segment(`${item.title}\n${item.text}`)),
    entities: structuredEntityIds(item),
  }
}

function structuredEntityIds(item: MemoryCandidate): ReadonlySet<string> {
  const ids = new Set<string>()
  if (item.record.kind === 'claim') {
    ids.add(item.record.claim.subjectId)
    if (item.record.claim.object.kind === 'entity') {
      ids.add(item.record.claim.object.entityId)
    }
  } else if (item.record.kind === 'event') {
    for (const participant of item.record.participants) {
      ids.add(participant.entity.id)
    }
  } else if (item.record.kind === 'entity') {
    ids.add(item.record.entity.id)
  }
  return ids
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let count = 0
  for (const token of small) {
    if (large.has(token)) count += 1
  }
  return count
}

function maxSimilarity(tokens: ReadonlySet<string>, selected: readonly CoverageEntry[]): number {
  let best = 0
  for (const entry of selected) {
    const union = tokens.size + entry.tokens.size - overlap(tokens, entry.tokens)
    if (union === 0) continue
    const similarity = overlap(tokens, entry.tokens) / union
    if (similarity > best) best = similarity
  }
  return best
}
