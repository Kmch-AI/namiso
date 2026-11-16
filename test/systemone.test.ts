import assert from 'node:assert/strict'
import { test } from 'vitest'

import { ProviderError } from '../src/errors.ts'
import { SystemOneEvidenceJudge } from '../src/providers/systemone.ts'

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body')
  return init.body
}

const emptyAnswersFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ answers: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

test('SystemOne evidence judge sends noul questions and parses scores', async () => {
  const bodies: unknown[] = []
  const judgeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(requestBody(init)) as {
      state: string
      questions: Record<
        string,
        { type: string; instructions: string; criteria: { true: string; false: string } }
      >
    }
    bodies.push(body)
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id, index) => [
        id,
        { type: 'noul', noul: index === 0 ? 0.9 : 0.2 },
      ]),
    )
    return new Response(JSON.stringify({ model: 'test', answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const judge = new SystemOneEvidenceJudge({
    endpoint: 'https://example.test/v1/systemone',
    model: 'jev-test',
    apiKey: 'secret',
    fetch: judgeFetch,
  })
  const scores = await judge.judge({
    query: 'Who owns the blue whale plan?',
    context: 'The plan is owned by Old Zhou.',
    candidates: [
      { id: 'message:1', text: 'Old Zhou owns the blue whale plan.' },
      { id: 'message:2', text: 'The office coffee is free.' },
    ],
  })

  assert.deepEqual(scores, [
    { id: 'message:1', score: 0.9 },
    { id: 'message:2', score: 0.2 },
  ])
  assert.equal(bodies.length, 1)
  const body = bodies[0] as {
    state: string
    questions: Record<
      string,
      { type: string; instructions: string; criteria: { true: string; false: string } }
    >
  }
  assert.match(body.state, /blue whale plan/)
  assert.equal(Object.keys(body.questions).length, 2)
  assert.equal(body.questions['c0']?.type, 'noul')
  assert.match(body.questions['c0']?.instructions ?? '', /blue whale plan/)
  assert.ok(body.questions['c0']?.criteria.true)
})

test('SystemOne evidence judge batches more than 32 questions', async () => {
  let calls = 0
  const judgeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(requestBody(init)) as {
      questions: Record<string, unknown>
    }
    calls += 1
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.5 }]),
    )
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const judge = new SystemOneEvidenceJudge({
    endpoint: 'https://example.test/v1/systemone',
    fetch: judgeFetch,
  })
  const candidates = Array.from({ length: 33 }, (_, index) => ({
    id: `message:${index}`,
    text: `candidate ${index}`,
  }))
  const scores = await judge.judge({ query: 'anything', candidates })
  assert.equal(calls, 2)
  assert.equal(scores.length, 33)
  assert.ok(scores.every((score) => score.score === 0.5))
})

test('SystemOne evidence judge rejects a missing answer', async () => {
  const judge = new SystemOneEvidenceJudge({
    endpoint: 'https://example.test/v1/systemone',
    fetch: emptyAnswersFetch,
  })
  await assert.rejects(
    judge.judge({ query: 'anything', candidates: [{ id: 'message:1', text: 'one' }] }),
    (error: unknown) => error instanceof ProviderError,
  )
})
