import type { Database } from '../storage/database.ts'
import type { ConversationId, MemorySpaceId } from '../types.ts'
import type { AnnotationPipeline } from './pipeline.ts'

import {
  countUnconsolidatedInConversation,
  listUnconsolidatedConversationIds,
  listUnconsolidatedMessages,
  recentMessages,
} from '../storage/conversation-repo.ts'

const CONTEXT_WINDOW = 8
export const DEFAULT_CONSOLIDATE_BATCH = 32
export const MAX_CONSOLIDATE_BATCH = 128

export interface ConsolidateInput {
  conversationId?: ConversationId
  batchSize?: number
}

export interface ConsolidateReport {
  messages: number
  batches: number
}

export class Consolidator {
  private readonly db: Database
  private readonly pipeline: AnnotationPipeline
  private readonly spaceId: MemorySpaceId

  constructor(db: Database, pipeline: AnnotationPipeline, spaceId: MemorySpaceId) {
    this.db = db
    this.pipeline = pipeline
    this.spaceId = spaceId
  }

  async run(input: ConsolidateInput = {}): Promise<ConsolidateReport> {
    const batchSize = input.batchSize ?? DEFAULT_CONSOLIDATE_BATCH
    const conversationIds =
      input.conversationId === undefined
        ? listUnconsolidatedConversationIds(this.db, this.spaceId)
        : [input.conversationId]
    let messages = 0
    let batches = 0
    for (const conversationId of conversationIds) {
      const pendingCount = countUnconsolidatedInConversation(this.db, this.spaceId, conversationId)
      const batchCount = Math.ceil(pendingCount / batchSize)
      for (let index = 0; index < batchCount; index += 1) {
        const pending = listUnconsolidatedMessages(this.db, this.spaceId, conversationId, batchSize)
        const first = pending[0]
        if (first === undefined) break
        const context = recentMessages(this.db, conversationId, first.messageIndex, CONTEXT_WINDOW)
        await this.pipeline.runBatch(pending, context)
        messages += pending.length
        batches += 1
      }
    }
    return { messages, batches }
  }
}
