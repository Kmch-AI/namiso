import { ProviderError } from '../errors.ts'
import { ENTITY_KINDS, type EntityKind } from '../types.ts'

export async function postJson(
  endpoint: string,
  body: unknown,
  options: {
    apiKey?: string
    headers?: Record<string, string>
    fetch?: typeof fetch
    timeoutMs?: number
  },
): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  }
  if (options.apiKey !== undefined) {
    headers.authorization = `Bearer ${options.apiKey}`
  }
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (error) {
    throw new ProviderError(`request to ${endpoint} failed`, { cause: error })
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new ProviderError(
      `request to ${endpoint} returned ${response.status}: ${raw.slice(0, 500)}`,
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new ProviderError(`response from ${endpoint} is not JSON`, { cause: error })
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProviderError(`${label} must be an array`)
  }
  return value
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const value = record[key]
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new ProviderError(`field ${key} must be a string`)
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

export function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

export function entityTypeField(
  record: Record<string, unknown>,
  key: string,
  fallback: EntityKind = 'other',
): EntityKind {
  const value = record[key]
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if ((ENTITY_KINDS as readonly string[]).includes(normalized)) {
    return normalized as EntityKind
  }
  return fallback
}
