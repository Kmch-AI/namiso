import { existsSync, readFileSync } from 'node:fs'

export interface ModelConfig {
  endpoint: string
  apiKey: string
  model: string
}

export interface ChatOptions {
  reasoning?: string
  maxTokens?: number
}

export interface ChatUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface ChatResult {
  content: string
  usage: ChatUsage
}

export function emptyUsage(): ChatUsage {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
}

export function addUsage(target: ChatUsage, source: ChatUsage): void {
  target.calls += source.calls
  target.promptTokens += source.promptTokens
  target.completionTokens += source.completionTokens
  target.reasoningTokens += source.reasoningTokens
  target.totalTokens += source.totalTokens
  target.cacheHitTokens += source.cacheHitTokens
  target.cacheMissTokens += source.cacheMissTokens
}

export function modelFromEnv(envPath: string): ModelConfig {
  const env = loadEnv(envPath)
  const endpoint = env['NAMISO_EXTRACTION_URL']
  const apiKey = env['NAMISO_EXTRACTION_API_KEY']
  const model = env['NAMISO_EXTRACTION_MODEL']
  if (endpoint === undefined || apiKey === undefined || model === undefined) {
    throw new Error(
      'NAMISO_EXTRACTION_URL, NAMISO_EXTRACTION_API_KEY, and NAMISO_EXTRACTION_MODEL are required',
    )
  }
  return { endpoint, apiKey, model }
}

export async function chat(
  messages: ReadonlyArray<{ role: string; content: string }>,
  config: ModelConfig,
  options: ChatOptions = {},
): Promise<string> {
  return (await chatWithUsage(messages, config, options)).content
}

export async function chatWithUsage(
  messages: ReadonlyArray<{ role: string; content: string }>,
  config: ModelConfig,
  options: ChatOptions = {},
): Promise<ChatResult> {
  const usage = emptyUsage()
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    usage.calls += 1
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        temperature: 0,
        messages,
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(options.reasoning === undefined ? {} : { reasoning_effort: options.reasoning }),
      }
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      addUsage(usage, parseUsage(payload))
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('empty model response')
      }
      return { content, usage }
    } catch (error) {
      lastError = error
      await new Promise((finish) => setTimeout(finish, 1500 * (attempt + 1)))
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), {
    usage,
  })
}

function parseUsage(payload: unknown): ChatUsage {
  const usage = emptyUsage()
  if (payload === null || typeof payload !== 'object') return usage
  const record = (payload as Record<string, unknown>)['usage']
  if (record === null || typeof record !== 'object') return usage
  const usageRecord = record as Record<string, unknown>
  const details = usageRecord['completion_tokens_details']
  const promptDetails = usageRecord['prompt_tokens_details']
  const detailRecord =
    details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {}
  const promptRecord =
    promptDetails !== null && typeof promptDetails === 'object'
      ? (promptDetails as Record<string, unknown>)
      : {}
  usage.promptTokens = tokenCount(usageRecord['prompt_tokens'])
  usage.completionTokens = tokenCount(usageRecord['completion_tokens'])
  usage.totalTokens = tokenCount(usageRecord['total_tokens'])
  usage.reasoningTokens = tokenCount(detailRecord['reasoning_tokens'])
  usage.cacheHitTokens = tokenCount(
    usageRecord['prompt_cache_hit_tokens'] ?? promptRecord['cached_tokens'],
  )
  usage.cacheMissTokens = tokenCount(
    usageRecord['prompt_cache_miss_tokens'] ??
      Math.max(0, usage.promptTokens - usage.cacheHitTokens),
  )
  return usage
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8')
  const rows: T[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    rows.push(JSON.parse(line) as T)
  }
  return rows
}

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key.length > 0) result[key] = value
  }
  return result
}
