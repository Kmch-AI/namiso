import { asMessageId } from "../ids.ts";
import { estimateTokens, segment, truncate } from "../text.ts";
import { getMessagesByIds } from "../storage/conversation-repo.ts";
import type { Database } from "../storage/database.ts";
import type {
  Claim,
  MemoryCandidate,
  MemoryContext,
  MemorySpaceId,
  Message,
  MessageId,
  RetrievalTrace,
} from "../types.ts";

export interface BuildContextInput {
  memorySpaceId: MemorySpaceId;
  query: string;
  candidates: readonly MemoryCandidate[];
  trace: RetrievalTrace;
  maxTokens?: number;
  includeEvidence?: boolean;
}

const MAX_EVENTS = 12;
const MAX_EVIDENCE = 12;
const MAX_RELATIONS = 12;

export function buildContext(db: Database, input: BuildContextInput): MemoryContext {
  const maxTokens = input.maxTokens ?? 1200;
  const entities = input.candidates.filter((candidate) => candidate.kind === "entity");
  const claims = input.candidates.filter((candidate) => candidate.kind === "claim");
  const activeClaims = claims.filter((candidate) => candidate.status === "active");
  const historicalClaims = claims.filter((candidate) => candidate.status !== "active");
  const events = input.candidates
    .filter((candidate) => candidate.kind === "event")
    .toSorted(
      (left, right) =>
        (left.occurredAt ?? Number.MAX_SAFE_INTEGER) -
        (right.occurredAt ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, MAX_EVENTS);
  const relations = collectRelations(input.candidates);
  const evidence =
    input.includeEvidence === false
      ? []
      : collectEvidence(db, input.memorySpaceId, input.candidates, input.query);
  const uncertainties = new Set<string>(input.trace.notes);

  for (const candidate of historicalClaims) {
    if (candidate.record.kind === "claim" && candidate.record.claim.status === "disputed") {
      uncertainties.add(`主张 ${candidate.record.claim.id} 处于冲突状态。`);
    }
  }
  for (const candidate of events) {
    if (
      candidate.record.kind === "event" &&
      candidate.record.event.metadata?.["modality"] === "uncertain"
    ) {
      uncertainties.add(`事件 ${candidate.record.event.id} 来自不确定陈述。`);
    }
  }
  const uncertaintyNotes = [...uncertainties];

  const text = assemble({
    maxTokens,
    activeClaims,
    entities,
    events,
    historicalClaims,
    relations,
    evidence,
    uncertainties: uncertaintyNotes,
  });

  return {
    text: text.text,
    items: [...activeClaims, ...entities, ...events, ...historicalClaims],
    evidence,
    tokenEstimate: estimateTokens(text.text),
    truncated: text.truncated,
    uncertainties: uncertaintyNotes,
    trace: input.trace,
  };
}

interface SectionsInput {
  maxTokens: number;
  activeClaims: readonly MemoryCandidate[];
  entities: readonly MemoryCandidate[];
  events: readonly MemoryCandidate[];
  historicalClaims: readonly MemoryCandidate[];
  relations: readonly string[];
  evidence: readonly Message[];
  uncertainties: readonly string[];
}

function assemble(input: SectionsInput): { text: string; truncated: boolean } {
  let used = 0;
  let truncated = false;
  const blocks: string[] = [];

  const addSection = (header: string, lines: readonly string[]): void => {
    if (lines.length === 0) return;
    const headerCost = estimateTokens(header) + 1;
    if (used + headerCost > input.maxTokens) {
      truncated = true;
      return;
    }
    const accepted: string[] = [];
    let sectionCost = headerCost;
    for (const line of lines) {
      const cost = estimateTokens(line) + 1;
      if (used + sectionCost + cost > input.maxTokens) {
        truncated = true;
        break;
      }
      accepted.push(line);
      sectionCost += cost;
    }
    if (accepted.length === 0) return;
    blocks.push(`${header}\n${accepted.join("\n")}`);
    used += sectionCost;
  };

  addSection(
    "[Current Claims]",
    input.activeClaims.map((candidate) => claimLine(candidate)),
  );
  addSection(
    "[Relevant Entities]",
    input.entities.map((candidate) => entityLine(candidate)),
  );
  addSection(
    "[Historical Events]",
    input.events.map((candidate) => eventLine(candidate)),
  );
  addSection(
    "[Historical Claims]",
    input.historicalClaims.map((candidate) => claimLine(candidate)),
  );
  addSection("[Memory Relations]", input.relations.slice(0, MAX_RELATIONS));
  addSection(
    "[Evidence]",
    input.evidence.slice(0, MAX_EVIDENCE).map((message) => evidenceLine(message)),
  );
  if (input.uncertainties.length > 0) {
    const lines = input.uncertainties.map((note) => `- ${note}`);
    const header = "[Uncertainty]";
    blocks.push(`${header}\n${lines.join("\n")}`);
    used += estimateTokens(header) + lines.reduce((sum, line) => sum + estimateTokens(line) + 1, 0);
  }
  return { text: blocks.join("\n\n"), truncated: truncated || used > input.maxTokens };
}

function claimLine(candidate: MemoryCandidate): string {
  if (candidate.record.kind !== "claim") return "";
  const { claim, subject, objectEntity } = candidate.record;
  const object =
    claim.object.kind === "literal" ? claim.object.value : (objectEntity?.name ?? "未知主体");
  return `- [claim:${claim.id}] ${subject.name} ${claim.predicate} ${object}（${statusLabel(claim.status)}）`;
}

function entityLine(candidate: MemoryCandidate): string {
  if (candidate.record.kind !== "entity") return "";
  const { entity, aliases } = candidate.record;
  const details = [
    entity.description,
    aliases.length > 0 ? `别名：${aliases.join("、")}` : null,
  ].filter((value): value is string => value !== null && value.length > 0);
  const suffix = details.length > 0 ? `：${details.join("；")}` : "";
  return `- [entity:${entity.id}] ${entity.name}（${entity.type}）${suffix}`;
}

function eventLine(candidate: MemoryCandidate): string {
  if (candidate.record.kind !== "event") return "";
  const { event, participants } = candidate.record;
  const date = event.occurredAt === null ? "时间未知" : formatDate(event.occurredAt);
  const people = participants.map((item) => `${item.entity.name}（${item.role}）`).join("、");
  return `- [event:${event.id}] ${date} ${event.type}：${truncate(event.summary, 240)}${
    people.length > 0 ? `；参与者：${people}` : ""
  }`;
}

function evidenceLine(message: Message): string {
  const date = formatDate(message.occurredAt);
  return `- [message:${message.id}] ${date} ${message.speakerId}：${truncate(message.content, 320)}`;
}

function collectRelations(candidates: readonly MemoryCandidate[]): string[] {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const relation of candidate.relations) {
      const target = `${relation.targetKind}:${relation.targetId}`;
      seen.add(
        relation.direction === "outgoing"
          ? `- ${candidate.key} --${relation.relation}--> ${target}`
          : `- ${target} --${relation.relation}--> ${candidate.key}`,
      );
    }
  }
  return [...seen];
}

function collectEvidence(
  db: Database,
  spaceId: MemorySpaceId,
  candidates: readonly MemoryCandidate[],
  query: string,
): Message[] {
  const ids = new Set<MessageId>();
  for (const candidate of candidates) {
    for (const id of candidate.evidenceMessageIds) ids.add(id);
    if (ids.size >= 120) break;
  }
  const messages = getMessagesByIds(db, [...ids].slice(0, 120));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const queryTokens = new Set(segment(query));
  const prepared = candidates.map((candidate) => {
    const perCandidateLimit = candidate.kind === "chunk" ? 3 : 2;
    const candidateMessages = candidate.evidenceMessageIds
      .flatMap((id) => {
        const message = byId.get(asMessageId(id));
        return message === undefined || message.memorySpaceId !== spaceId ? [] : [message];
      })
      .map((message) => ({ message, score: overlapScore(message, queryTokens) }))
      .toSorted((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return right.message.occurredAt - left.message.occurredAt;
      });
    return { messages: candidateMessages, perCandidateLimit };
  });
  const chosen: Message[] = [];
  const seen = new Set<string>();
  const take = (onlyMatching: boolean): void => {
    for (const item of prepared) {
      if (chosen.length >= MAX_EVIDENCE) return;
      let added = 0;
      for (const entry of item.messages) {
        if (onlyMatching && entry.score === 0) continue;
        if (added >= item.perCandidateLimit || chosen.length >= MAX_EVIDENCE) break;
        if (seen.has(entry.message.id)) continue;
        seen.add(entry.message.id);
        chosen.push(entry.message);
        added += 1;
      }
    }
  };
  take(true);
  take(false);
  return chosen.toSorted((left, right) => left.occurredAt - right.occurredAt);
}

function overlapScore(message: Message, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0;
  let score = 0;
  for (const token of segment(message.content)) {
    if (queryTokens.has(token)) score += 1;
  }
  return score;
}

const CLAIM_STATUS_LABELS: Record<Claim["status"], string> = {
  active: "当前有效",
  superseded: "已被取代",
  disputed: "存在冲突",
  retracted: "已撤回",
  invalid: "无效",
};

function statusLabel(status: Claim["status"]): string {
  return CLAIM_STATUS_LABELS[status];
}

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
