import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'

import { Namiso } from '../../src/index.ts'
import {
  HttpEmbeddingProvider,
  HttpExtractionProvider,
  HttpRerankerProvider,
} from '../../src/providers/http.ts'

interface Turn {
  turn: number
  time: string
  user: string
  assistant: string
}

type Board = 'exam' | 'natural'

interface Scope {
  run: string
  system: string
  board: Board
  split: string
}

interface Session {
  sid: string
  turns: Turn[]
  tailStart: number | null
  persisted: number
  scope: Scope | null
  persona: string | null
  namiso: Namiso | null
  conversationId: string | null
  extractionBatches: number
}

const PORT = Number(process.env.BRIDGE_PORT ?? 18878)
const GATEWAY = process.env.SHIM_GATEWAY ?? 'http://127.0.0.1:18877/v1'
const CHAT_KEY = process.env.NAMISO_EXTRACTION_API_KEY ?? ''
const EMBED_DIM = Number(process.env.NAMISO_EMBEDDING_DIMENSIONS ?? 1024)
const DATA_DIR = process.env.B22_DATA ?? join(import.meta.dirname, 'db')
const DB_TAG = process.env.B22_DB_TAG ?? ''

const sessions = new Map<string, Session>()

function sessionOf(sid: string): Session {
  const existing = sessions.get(sid)
  if (existing !== undefined) return existing
  const created: Session = {
    sid,
    turns: [],
    tailStart: null,
    persisted: 0,
    scope: null,
    persona: null,
    namiso: null,
    conversationId: null,
    extractionBatches: 0,
  }
  sessions.set(sid, created)
  return created
}

function scopedEndpoint(scope: Scope, route: string, phase: string, tag: string): string {
  const params = new URLSearchParams({
    run: scope.run,
    system: scope.system,
    phase,
    tag,
  })
  return `${GATEWAY}${route}?${params.toString()}`
}

function providers(scope: Scope) {
  return {
    extraction: new HttpExtractionProvider({
      endpoint: scopedEndpoint(scope, '/chat/completions', 'ingest', 'extract'),
      model: process.env.NAMISO_EXTRACTION_MODEL ?? 'workbuddy2api/cn:deepseek-v4.1-flash',
      ...(CHAT_KEY.length === 0 ? {} : { apiKey: CHAT_KEY }),
      reasoningEffort: 'none',
      timeoutMs: 180_000,
    }),
    embedding: new HttpEmbeddingProvider({
      endpoint: scopedEndpoint(scope, '/embeddings', 'ingest', 'embed'),
      model: process.env.NAMISO_EMBEDDING_MODEL ?? 'Qwen3-Embedding-0.6B-Q8_0',
      dimensions: EMBED_DIM,
      batchSize: 16,
      timeoutMs: 180_000,
    }),
    reranker: new HttpRerankerProvider({
      endpoint: scopedEndpoint(scope, '/rerank', 'retrieve', 'rerank'),
      model: process.env.NAMISO_RERANK_MODEL ?? 'Qwen3-Reranker-0.6B.Q4_K_M',
      timeoutMs: 180_000,
    }),
  }
}

async function openMemory(session: Session, scope: Scope, persona: string): Promise<void> {
  const databasePath = join(
    DATA_DIR,
    scope.run,
    `${scope.board}-${persona}-${session.sid.slice(0, 8)}${DB_TAG}.db`,
  )
  mkdirSync(dirname(databasePath), { recursive: true })
  session.namiso = await Namiso.open({
    databasePath,
    memorySpace: { name: `b22-${scope.board}-${persona}-${session.sid.slice(0, 6)}` },
    vectorIndex: 'auto',
    ...providers(scope),
  })
  const conversation =
    session.namiso.listConversations().find((item) => item.externalId === persona) ??
    session.namiso.createConversation({ externalId: persona })
  session.conversationId = conversation.id
  session.scope = scope
  session.persona = persona
}

async function writeTurns(session: Session, until: number): Promise<void> {
  const namiso = session.namiso
  const conversationId = session.conversationId
  if (namiso === null || conversationId === null) throw new Error('memory not open')
  while (session.persisted < until) {
    const turn = session.turns[session.persisted]
    if (turn === undefined) break
    const occurredAt = Math.floor(Date.parse(turn.time) / 1000)
    for (const [role, content] of [
      ['user', turn.user],
      ['assistant', turn.assistant],
    ] as const) {
      await namiso.ingest({
        conversationId,
        externalMessageId: `${session.persona}:${turn.turn}:${role}`,
        speakerId: role === 'user' ? '用户' : '助手',
        speakerName: role === 'user' ? '用户' : '小满',
        role,
        content,
        occurredAt,
        metadata: { turn: turn.turn, board: session.scope?.board ?? 'exam' },
      })
    }
    session.persisted += 1
  }
}

async function consolidate(session: Session): Promise<void> {
  const namiso = session.namiso
  if (namiso === null || session.conversationId === null) return
  await namiso.drain()
  const report = await namiso.consolidate({ conversationId: session.conversationId, batchSize: 64 })
  session.extractionBatches += report.batches
}

function renderTurn(turn: Turn): string {
  return `[${turn.time}]\n用户：${turn.user}\n小满：${turn.assistant}`
}

async function retrieve(
  session: Session,
  input: { question: string; now: string; scope: Scope; persona: string },
): Promise<{ prompt: string; usedTurns: number[]; meta: Record<string, unknown> }> {
  if (session.namiso === null) await openMemory(session, input.scope, input.persona)
  const visible = session.tailStart ?? session.turns.length
  await writeTurns(session, visible)
  await consolidate(session)
  const namiso = session.namiso
  if (namiso === null) throw new Error('memory not open')
  const context = await namiso.getContext({
    query: input.question,
    maxTokens: 1600,
    topK: 12,
    now: Math.floor(Date.parse(input.now) / 1000),
    timeZone: 'Asia/Shanghai',
  })
  const recent = session.turns.slice(-6)
  const prompt = [
    '你是用户长期聊天的伴侣，下面是你们过去的聊天片段和最近的对话，请根据记忆自然地回答用户这句话。',
    '【记忆摘录】',
    context.text.trim(),
    '【最近的对话】',
    ...recent.map(renderTurn),
  ].join('\n\n')
  return {
    prompt,
    usedTurns: recent.map((turn) => turn.turn),
    meta: {
      contextTokens: context.tokenEstimate,
      items: context.items.length,
      evidence: context.evidence.length,
      overBudget: context.overBudget,
      compressed: context.compressed,
      extractionBatches: session.extractionBatches,
      visibleTurns: visible,
    },
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const raw = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(raw)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health') {
        return json(response, 200, {
          ok: true,
          sessions: [...sessions.values()].map((session) => ({
            sid: session.sid.slice(0, 8),
            turns: session.turns.length,
            persisted: session.persisted,
            batches: session.extractionBatches,
            system: session.scope?.system ?? null,
          })),
        })
      }
      const body = await readBody(request)
      const session = sessionOf(typeof body.sid === 'string' ? body.sid : '')
      if (url.pathname === '/ingest') {
        const turn = body.turn as Turn
        const index = turn.turn - 1
        if (index < session.turns.length) session.turns[index] = turn
        else session.turns.push(turn)
        return json(response, 200, { turns: session.turns.length })
      }
      if (url.pathname === '/retrieve') {
        const scope = body.scope as Scope
        const result = await retrieve(session, {
          question: String(body.question),
          now: String(body.now),
          scope,
          persona: String(body.persona),
        })
        return json(response, 200, result)
      }
      if (url.pathname === '/mark') {
        return json(response, 200, { token: session.turns.length })
      }
      if (url.pathname === '/begin_tail') {
        session.tailStart = session.turns.length
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/rewind') {
        const token = Number(body.token)
        session.turns = session.turns.slice(0, token)
        session.persisted = Math.min(session.persisted, token)
        session.tailStart = null
        return json(response, 200, { token: session.turns.length })
      }
      if (url.pathname === '/close') {
        session.namiso?.close()
        sessions.delete(session.sid)
        return json(response, 200, { ok: true })
      }
      return json(response, 404, { error: 'not found' })
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`namiso bridge on http://127.0.0.1:${PORT} gateway=${GATEWAY}\n`)
})
