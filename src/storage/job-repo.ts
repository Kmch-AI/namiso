import type { Job, JobId, MemorySpaceId } from '../types.ts'
import type { Database } from './database.ts'

import { asJobId, nowSeconds } from '../ids.ts'
import { count, text } from './database.ts'
import { mapJob } from './mappers.ts'

export function enqueueChunk(db: Database, spaceId: MemorySpaceId, conversationId: string): void {
  enqueue(db, spaceId, 'chunk', `chunk:${conversationId}`, { conversationId })
}

function enqueue(
  db: Database,
  spaceId: MemorySpaceId,
  type: 'chunk',
  dedupeKey: string,
  payload: Record<string, unknown>,
): void {
  const now = nowSeconds()
  db.run(
    `INSERT INTO jobs (
      id, memory_space_id, type, dedupe_key, payload, status, attempts,
      max_attempts, run_after, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      status = 'pending',
      attempts = 0,
      payload = excluded.payload,
      run_after = excluded.run_after,
      updated_at = excluded.updated_at,
      last_error = NULL`,
    asJobId(`job:${dedupeKey}`),
    spaceId,
    type,
    dedupeKey,
    JSON.stringify(payload),
    now,
    now,
    now,
  )
}

export function claimNextJob(db: Database, spaceId: MemorySpaceId, now: number): Job | null {
  return db.transaction(() => {
    const row = db.get(
      `SELECT * FROM jobs
       WHERE memory_space_id = ? AND status = 'pending' AND run_after <= ?
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      spaceId,
      now,
    )
    if (row === undefined) return null
    const id = asJobId(text(row, 'id'))
    const changed = db.run(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      now,
      id,
    )
    if (changed !== 1) return null
    const claimed = db.get('SELECT * FROM jobs WHERE id = ?', id)
    return claimed === undefined ? null : mapJob(claimed)
  })
}

export function completeJob(db: Database, jobId: JobId): boolean {
  return (
    db.run(
      `UPDATE jobs SET status = 'completed', last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      nowSeconds(),
      jobId,
    ) === 1
  )
}

export function failJob(db: Database, jobId: JobId, error: unknown): void {
  const row = db.get('SELECT * FROM jobs WHERE id = ?', jobId)
  if (row === undefined) return
  const job = mapJob(row)
  const message = error instanceof Error ? error.message : String(error)
  const now = nowSeconds()
  if (job.attempts >= job.maxAttempts) {
    db.run(
      `UPDATE jobs SET status = 'failed', last_error = ?, run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      message.slice(0, 2000),
      now + 300,
      now,
      jobId,
    )
    return
  }
  const backoff = Math.min(10 * 2 ** (job.attempts - 1), 300)
  db.run(
    `UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, updated_at = ?
     WHERE id = ? AND status = 'running'`,
    message.slice(0, 2000),
    now + backoff,
    now,
    jobId,
  )
}

export function requeueStaleJobs(
  db: Database,
  spaceId: MemorySpaceId,
  staleAfterSeconds = 300,
): number {
  const now = nowSeconds()
  return db.run(
    `UPDATE jobs SET status = 'pending', updated_at = ?
     WHERE memory_space_id = ? AND status = 'running' AND updated_at < ?`,
    now,
    spaceId,
    now - staleAfterSeconds,
  )
}

export function retryFailedJobs(db: Database, spaceId: MemorySpaceId): number {
  return db.run(
    `UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, updated_at = ?
     WHERE memory_space_id = ? AND status = 'failed'`,
    nowSeconds(),
    nowSeconds(),
    spaceId,
  )
}

export function jobCounts(db: Database, spaceId: MemorySpaceId): Record<string, number> {
  const rows = db.all(
    'SELECT status, COUNT(*) AS n FROM jobs WHERE memory_space_id = ? GROUP BY status',
    spaceId,
  )
  const result: Record<string, number> = {}
  for (const row of rows) {
    result[text(row, 'status')] = count(row, 'n')
  }
  return result
}

export function pendingJobCount(db: Database, spaceId: MemorySpaceId): number {
  return count(
    db.get(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE memory_space_id = ? AND status IN ('pending', 'running')`,
      spaceId,
    ),
    'n',
  )
}

export function getJob(db: Database, jobId: JobId): Job | null {
  const row = db.get('SELECT * FROM jobs WHERE id = ?', jobId)
  return row === undefined ? null : mapJob(row)
}
