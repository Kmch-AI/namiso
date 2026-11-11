import type { ChunkService } from '../ingestion/chunk-service.ts'
import type { Database } from '../storage/database.ts'
import type { Job, MemorySpaceId } from '../types.ts'

import { asConversationId } from '../ids.ts'
import { getConversation } from '../storage/conversation-repo.ts'
import {
  claimNextJob,
  completeJob,
  failJob,
  pendingJobCount,
  requeueStaleJobs,
} from '../storage/job-repo.ts'

export interface DrainReport {
  processed: number
  completed: number
  failed: number
  pending: number
}

export class JobWorker {
  private readonly db: Database
  private readonly chunks: ChunkService
  private readonly spaceId: MemorySpaceId

  constructor(db: Database, chunks: ChunkService, spaceId: MemorySpaceId) {
    this.db = db
    this.chunks = chunks
    this.spaceId = spaceId
  }

  async drain(limit = 200): Promise<DrainReport> {
    requeueStaleJobs(this.db, this.spaceId)
    let completed = 0
    let failed = 0
    for (let processed = 0; processed < limit; processed += 1) {
      const job = claimNextJob(this.db, this.spaceId, Math.floor(Date.now() / 1000))
      if (job === null) break
      try {
        await this.execute(job)
        if (completeJob(this.db, job.id)) completed += 1
      } catch (error) {
        failJob(this.db, job.id, error)
        failed += 1
      }
    }
    return {
      processed: completed + failed,
      completed,
      failed,
      pending: pendingJobCount(this.db, this.spaceId),
    }
  }

  private async execute(job: Job): Promise<void> {
    if (job.type !== 'chunk') {
      throw new Error(`unsupported job type ${job.type}`)
    }
    const conversationId = job.payload['conversationId']
    if (typeof conversationId !== 'string') {
      throw new Error(`chunk job ${job.id} has no conversationId`)
    }
    const conversation = getConversation(this.db, asConversationId(conversationId))
    if (conversation === null) return
    await this.chunks.syncConversation(conversation.memorySpaceId, conversation.id)
  }
}
