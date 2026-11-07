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
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('empty model response')
      }
      return content
    } catch (error) {
      lastError = error
      await new Promise((finish) => setTimeout(finish, 1500 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
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
