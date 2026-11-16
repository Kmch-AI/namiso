import assert from 'node:assert/strict'
import { test } from 'vitest'

import { SystemOneEvidenceJudge, providersFromEnv } from '../src/index.ts'

test('providersFromEnv builds a SystemOne judge without requiring a model', () => {
  assert.equal(providersFromEnv({}).evidenceJudge, undefined)
  const providers = providersFromEnv({
    NAMISO_SYSTEMONE_URL: 'https://example.test/v1/systemone',
    NAMISO_SYSTEMONE_API_KEY: 'secret',
  })
  assert.ok(providers.evidenceJudge instanceof SystemOneEvidenceJudge)
  assert.equal(providers.evidenceJudge.model, 'jev-latest')
})
