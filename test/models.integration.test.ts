import assert from 'node:assert/strict'
import { test } from 'vitest'

import { Namiso, providersFromEnv } from '../src/index.ts'

const enabled = process.env['NAMISO_RUN_MODEL_TESTS'] === '1'

test.skipIf(!enabled)(
  'configured model providers complete an ingest and retrieval cycle',
  async () => {
    const providers = providersFromEnv(process.env)
    if (Object.keys(providers).length === 0) {
      throw new Error(
        'Set at least one NAMISO_EXTRACTION_*, NAMISO_EMBEDDING_*, or NAMISO_RERANK_* pair.',
      )
    }
    const namiso = await Namiso.open({
      databasePath: ':memory:',
      vectorIndex: 'auto',
      ...providers,
    })
    const conversation = namiso.createConversation()
    await namiso.ingest({
      conversationId: conversation.id,
      externalMessageId: 'integration-1',
      speakerId: '用户A',
      role: 'user',
      content: '我养了一只叫团子的猫，它喜欢趴在窗台上。',
      occurredAt: Math.floor(Date.now() / 1000),
    })
    const drain = await namiso.drain()
    assert.equal(drain.failed, 0)

    const health = namiso.health()
    if (providers.embedding !== undefined) {
      assert.notEqual(health.embedding.model, 'namiso-hash')
    }
    const result = await namiso.getContext({ query: '我养了什么猫？' })
    assert.ok(result.text.length > 0)
    assert.ok(result.evidence.length > 0)
    namiso.close()
  },
  60_000,
)
