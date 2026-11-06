import type { Conversation, IngestResult, NamisoOptions } from '../src/index.ts'

import { Namiso } from '../src/index.ts'

export const BASE_TIME = 1_790_000_000

export interface Harness {
  namiso: Namiso
  conversation: Conversation
  say: (speakerId: string, role: 'user' | 'assistant', content: string) => Promise<IngestResult>
  drain: () => Promise<unknown>
}

export async function setup(options: Partial<NamisoOptions> = {}): Promise<Harness> {
  const namiso = await Namiso.open({
    databasePath: ':memory:',
    vectorIndex: 'exact',
    ...options,
  })
  const conversation = namiso.createConversation({ title: 'test' })
  let step = 0
  const say = async (
    speakerId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<IngestResult> => {
    const result = await namiso.ingest({
      conversationId: conversation.id,
      speakerId,
      role,
      content,
      occurredAt: BASE_TIME + step * 60,
    })
    step += 1
    return result
  }
  return {
    namiso,
    conversation,
    say,
    drain: () => namiso.drain(),
  }
}

export const USER = '用户A'
export const AI = '四时小路'
