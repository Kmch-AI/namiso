import type { Claim, Entity, EntityId, Event, Message } from '../types.ts'

export function entityDocumentText(entity: Entity, aliases: readonly string[]): string {
  const lines = [`主体：${entity.name}`, `类型：${entity.type}`]
  if (aliases.length > 0) lines.push(`别名：${aliases.join('、')}`)
  if (entity.description !== null) lines.push(`描述：${entity.description}`)
  return lines.join('\n')
}

export function claimDocumentText(
  claim: Claim,
  subject: Entity,
  objectEntity: Entity | null,
  aliases: ReadonlyMap<EntityId, readonly string[]> = new Map(),
): string {
  const objectLabel =
    claim.object.kind === 'literal' ? claim.object.value : (objectEntity?.name ?? '未知主体')
  const lines = [
    `主体：${subject.name}`,
    `谓词：${claim.predicate}`,
    `事实：${subject.name} ${claim.predicate} ${objectLabel}`,
    `状态：${claim.status}`,
  ]
  const subjectAliases = aliases.get(subject.id) ?? []
  if (subjectAliases.length > 0) lines.push(`主体别名：${subjectAliases.join('、')}`)
  const objectAliases = objectEntity === null ? [] : (aliases.get(objectEntity.id) ?? [])
  if (objectAliases.length > 0) lines.push(`客体别名：${objectAliases.join('、')}`)
  if (claim.validFrom !== null) lines.push(`开始时间：${formatTime(claim.validFrom)}`)
  if (claim.validUntil !== null) lines.push(`结束时间：${formatTime(claim.validUntil)}`)
  return lines.join('\n')
}

export function eventDocumentText(
  event: Event,
  participants: ReadonlyArray<{ entity: Entity; role: string }>,
  aliases: ReadonlyMap<EntityId, readonly string[]> = new Map(),
): string {
  const lines = [`事件类型：${event.type}`, `事件描述：${event.summary}`]
  if (event.occurredAt !== null) {
    lines.push(`发生时间：${formatTime(event.occurredAt)}`)
    lines.push(`时间精度：${event.timePrecision}`)
  }
  if (participants.length > 0) {
    lines.push(
      `参与者：${participants.map((item) => `${item.entity.name}（${item.role}）`).join('、')}`,
    )
  }
  const participantAliases = participants.flatMap((item) => aliases.get(item.entity.id) ?? [])
  if (participantAliases.length > 0) lines.push(`参与别名：${participantAliases.join('、')}`)
  if (event.description !== null) lines.push(`补充说明：${event.description}`)
  return lines.join('\n')
}

export function messageDocumentText(message: Message): string {
  return `${message.speakerId}（${message.role}）：${message.content}`
}

export function chunkDocumentText(messages: readonly Message[]): string {
  return messages
    .map((message) => `${message.speakerId}（${message.role}）：${message.content}`)
    .join('\n')
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}
