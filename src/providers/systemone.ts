import type {
  EvidenceJudgeCandidate,
  EvidenceJudgeInput,
  EvidenceJudgeProvider,
  EvidenceJudgeScore,
} from './types.ts'

import { ProviderError, ValidationError } from '../errors.ts'
import { asRecord, numberField, postJson } from './http-util.ts'

export interface SystemOneEvidenceJudgeOptions {
  endpoint: string
  model?: string
  apiKey?: string
  version?: string
  timeoutMs?: number
  batchSize?: number
  fetch?: typeof fetch
}

const MAX_QUESTIONS = 32

export class SystemOneEvidenceJudge implements EvidenceJudgeProvider {
  readonly model: string
  readonly version: string
  private readonly options: SystemOneEvidenceJudgeOptions
  private readonly batchSize: number

  constructor(options: SystemOneEvidenceJudgeOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.trim().length === 0) {
      throw new ValidationError('systemone endpoint must be a non-empty string')
    }
    if (
      options.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) || options.batchSize <= 0)
    ) {
      throw new ValidationError('systemone batchSize must be a positive integer')
    }
    this.options = { ...options, endpoint: options.endpoint.trim() }
    this.model = options.model?.trim() || 'jev-latest'
    this.version = options.version?.trim() || this.model
    this.batchSize = Math.min(options.batchSize ?? MAX_QUESTIONS, MAX_QUESTIONS)
  }

  async judge(input: EvidenceJudgeInput): Promise<EvidenceJudgeScore[]> {
    if (input.candidates.length === 0) return []
    const scores: EvidenceJudgeScore[] = []
    for (let start = 0; start < input.candidates.length; start += this.batchSize) {
      const batch = input.candidates.slice(start, start + this.batchSize)
      scores.push(...(await this.judgeBatch(input, batch)))
    }
    return scores
  }

  private async judgeBatch(
    input: EvidenceJudgeInput,
    candidates: readonly EvidenceJudgeCandidate[],
  ): Promise<EvidenceJudgeScore[]> {
    const questions: Record<string, unknown> = {}
    for (const [index, candidate] of candidates.entries()) {
      questions[`c${index}`] = {
        type: 'noul',
        instructions: `Passage:\n${candidate.text}\n\nDoes this passage itself supply a necessary fact for a fully supported answer to the question?`,
        criteria: {
          true: 'The passage contains a fact needed for the answer chain, and its entities and constraints match the question.',
          false:
            'The passage is only background, merely related, or would require outside knowledge to use.',
        },
      }
    }
    const state = [
      `Question: ${input.query}`,
      ...(input.context === undefined || input.context.trim().length === 0
        ? []
        : [`Context: ${input.context}`]),
    ].join('\n\n')
    const payload = await postJson(
      this.options.endpoint,
      { model: this.model, state, questions },
      {
        ...(this.options.apiKey === undefined ? {} : { apiKey: this.options.apiKey }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
    )
    const root = asRecord(payload, 'systemone response')
    const answers = asRecord(root['answers'], 'systemone answers')
    return candidates.map((candidate, index) => {
      const answer = answers[`c${index}`]
      if (answer === undefined) {
        throw new ProviderError(`systemone response is missing answer c${index}`)
      }
      const record = asRecord(answer, `systemone answer c${index}`)
      const score = numberField(record, 'noul', Number.NaN)
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new ProviderError(`systemone answer c${index} noul must be between 0 and 1`)
      }
      return { id: candidate.id, score }
    })
  }
}
