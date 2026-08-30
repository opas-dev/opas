// ABOUTME: Ranks retained redacted answer failures and source observations for quality operations.
// ABOUTME: Produces editor briefings without storing or publishing suggestion text as evidence.
import {
  describeAnswerTopicGuardrails,
  type AnswerTopicGuardrailReport,
} from "@/answers/guardrails";
import type {
  ConversationAnalyticsRecord,
  ConversationOutcome,
} from "@/outcomes/records";
import type { ConversationAnalyticsReadScope } from "@/outcomes/store";

export const maximumContentGapRecords = 1_000;
export const maximumContentGapRows = 25;
export const maximumSourceObservationRows = 25;

export type ContentGapKind = "escalated" | "low-rated" | "unsupported";

export type ContentGapEditorSuggestion = Readonly<{
  checklist: readonly string[];
  createArticleHref: "/admin/content/articles/new";
  editArticleHref: string | null;
  editArticleTitle: string | null;
  proposedTitle: string;
}>;

export type RankedContentGap = Readonly<{
  categorySampleCount: number;
  kind: ContentGapKind;
  lastObservedAt: Date;
  observedCount: number;
  question: string;
  representativeConversationId: string;
  suggestion: ContentGapEditorSuggestion;
}>;

export type SourceUsefulnessObservation = Readonly<{
  abandonedCount: number;
  abstainedCount: number;
  answeredCount: number;
  articleId: string;
  canonicalUrl: string;
  escalatedCount: number;
  lowRatedCount: number;
  observedConversationCount: number;
  title: string;
  tracedConversationCount: number;
}>;

export type TopicGuardrailObservation = Readonly<{
  configuration: AnswerTopicGuardrailReport;
  outOfScopeCount: number;
  recordsExamined: number;
  unsafeEvidenceCount: number;
  unsafeRequestCount: number;
}>;

export type ContentGapReport = Readonly<{
  gaps: readonly RankedContentGap[];
  recordsExamined: number;
  recordsReceived: number;
  recordsTruncated: boolean;
  sourceObservations: readonly SourceUsefulnessObservation[];
  topicGuardrails: TopicGuardrailObservation;
}>;

export type ContentGapReportRequest = Readonly<{
  records: readonly ConversationAnalyticsRecord[];
  scope: ConversationAnalyticsReadScope;
  topicConfiguration?: string;
  workspaceId: string;
}>;

type GapAccumulator = {
  kind: ContentGapKind;
  lastObservedAt: Date;
  observedCount: number;
  question: string;
  representativeConversationId: string;
  sources: Map<string, { count: number; title: string }>;
};

type SourceAccumulator = {
  articleId: string;
  canonicalUrl: string;
  outcomes: Record<ConversationOutcome, number>;
  observedConversationCount: number;
  title: string;
};

const failureReasons = new Set(["conflicting-evidence", "insufficient-evidence"]);
const maximumQuestionCodePoints = 200;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function activeRecord(
  record: ConversationAnalyticsRecord,
  workspaceId: string,
  scope: ConversationAnalyticsReadScope,
) {
  return (
    record.workspaceId === workspaceId &&
    validDate(record.startedAt) &&
    validDate(record.updatedAt) &&
    validDate(record.expiresAt) &&
    record.expiresAt > scope.readAt &&
    record.startedAt >= scope.retentionStartedAt &&
    record.startedAt <= scope.readAt
  );
}

function normalizedQuestion(record: ConversationAnalyticsRecord) {
  let question: string | null = null;
  for (const message of record.conversation) {
    if (message.role === "user") question = message.content;
  }
  if (!question) return null;
  const normalized = question.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maximumQuestionCodePoints).join("");
}

function gapKind(record: ConversationAnalyticsRecord): ContentGapKind | null {
  if (record.outcome === "low-rated") return "low-rated";
  if (record.outcome === "escalated") return "escalated";
  if (
    record.outcome === "abstained" &&
    (record.reason === null || failureReasons.has(record.reason))
  ) {
    return "unsupported";
  }
  return null;
}

function questionKey(question: string) {
  return question.toLowerCase();
}

function safeCanonicalUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function proposedTitle(question: string) {
  const withoutTerminalPunctuation = question.replace(/[.!?]+$/u, "").trim();
  return Array.from(withoutTerminalPunctuation || question).slice(0, 160).join("");
}

function suggestionChecklist(kind: ContentGapKind, question: string) {
  const directAnswer = `Give a source-backed answer to “${question}”.`;
  if (kind === "low-rated") {
    return Object.freeze([
      directAnswer,
      "Put the direct answer before background detail.",
      "Clarify prerequisites, limits, and the next action.",
    ]);
  }
  if (kind === "escalated") {
    return Object.freeze([
      directAnswer,
      "Separate self-service steps from cases that require support.",
      "State the escalation criteria and safe contact path.",
    ]);
  }
  return Object.freeze([
    directAnswer,
    "State unavailable options or limits explicitly.",
    "Add the next action a reader can take.",
  ]);
}

function editorSuggestion(gap: GapAccumulator): ContentGapEditorSuggestion {
  const source = [...gap.sources.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      right.count - left.count || compareText(leftId, rightId),
  )[0];
  return Object.freeze({
    checklist: suggestionChecklist(gap.kind, gap.question),
    createArticleHref: "/admin/content/articles/new" as const,
    editArticleHref: source
      ? `/admin/content/articles/${encodeURIComponent(source[0])}#article-body-heading`
      : null,
    editArticleTitle: source?.[1].title ?? null,
    proposedTitle: proposedTitle(gap.question),
  });
}

function newOutcomeCounts(): Record<ConversationOutcome, number> {
  return {
    abandoned: 0,
    abstained: 0,
    answered: 0,
    escalated: 0,
    "low-rated": 0,
  };
}

function rankedGaps(records: readonly ConversationAnalyticsRecord[]) {
  const groups = new Map<string, GapAccumulator>();
  const categoryCounts: Record<ContentGapKind, number> = {
    escalated: 0,
    "low-rated": 0,
    unsupported: 0,
  };

  for (const record of records) {
    const kind = gapKind(record);
    const question = normalizedQuestion(record);
    if (!kind || !question) continue;
    categoryCounts[kind] += 1;
    const key = `${kind}\u0000${questionKey(question)}`;
    let gap = groups.get(key);
    if (!gap) {
      gap = {
        kind,
        lastObservedAt: record.updatedAt,
        observedCount: 0,
        question,
        representativeConversationId: record.id,
        sources: new Map(),
      };
      groups.set(key, gap);
    }
    gap.observedCount += 1;
    if (record.updatedAt > gap.lastObservedAt) {
      gap.lastObservedAt = record.updatedAt;
      gap.question = question;
      gap.representativeConversationId = record.id;
    }
    const seenArticles = new Set<string>();
    for (const trace of record.retrievalTrace) {
      if (seenArticles.has(trace.articleId)) continue;
      seenArticles.add(trace.articleId);
      const current = gap.sources.get(trace.articleId);
      gap.sources.set(trace.articleId, {
        count: (current?.count ?? 0) + 1,
        title: current?.title ?? trace.title,
      });
    }
  }

  return Object.freeze(
    [...groups.values()]
      .sort(
        (left, right) =>
          right.observedCount - left.observedCount ||
          right.lastObservedAt.getTime() - left.lastObservedAt.getTime() ||
          compareText(left.kind, right.kind) ||
          compareText(left.question, right.question),
      )
      .slice(0, maximumContentGapRows)
      .map((gap) =>
        Object.freeze({
          categorySampleCount: categoryCounts[gap.kind],
          kind: gap.kind,
          lastObservedAt: new Date(gap.lastObservedAt),
          observedCount: gap.observedCount,
          question: gap.question,
          representativeConversationId: gap.representativeConversationId,
          suggestion: editorSuggestion(gap),
        }),
      ),
  );
}

function sourceObservations(records: readonly ConversationAnalyticsRecord[]) {
  const tracedConversationIds = new Set<string>();
  const sources = new Map<string, SourceAccumulator>();
  for (const record of records) {
    const seenArticles = new Set<string>();
    for (const trace of record.retrievalTrace) {
      if (seenArticles.has(trace.articleId)) continue;
      const canonicalUrl = safeCanonicalUrl(trace.canonicalUrl);
      if (!canonicalUrl) continue;
      seenArticles.add(trace.articleId);
      tracedConversationIds.add(record.id);
      let source = sources.get(trace.articleId);
      if (!source) {
        source = {
          articleId: trace.articleId,
          canonicalUrl,
          observedConversationCount: 0,
          outcomes: newOutcomeCounts(),
          title: trace.title,
        };
        sources.set(trace.articleId, source);
      }
      source.observedConversationCount += 1;
      source.outcomes[record.outcome] += 1;
    }
  }
  const denominator = tracedConversationIds.size;
  return Object.freeze(
    [...sources.values()]
      .sort(
        (left, right) =>
          right.observedConversationCount - left.observedConversationCount ||
          right.outcomes.answered - left.outcomes.answered ||
          compareText(left.articleId, right.articleId),
      )
      .slice(0, maximumSourceObservationRows)
      .map((source) =>
        Object.freeze({
          abandonedCount: source.outcomes.abandoned,
          abstainedCount: source.outcomes.abstained,
          answeredCount: source.outcomes.answered,
          articleId: source.articleId,
          canonicalUrl: source.canonicalUrl,
          escalatedCount: source.outcomes.escalated,
          lowRatedCount: source.outcomes["low-rated"],
          observedConversationCount: source.observedConversationCount,
          title: source.title,
          tracedConversationCount: denominator,
        }),
      ),
  );
}

function topicGuardrailObservation(
  records: readonly ConversationAnalyticsRecord[],
  configuration: string | undefined,
): TopicGuardrailObservation {
  return Object.freeze({
    configuration: describeAnswerTopicGuardrails(configuration),
    outOfScopeCount: records.filter(({ reason }) => reason === "out-of-scope").length,
    recordsExamined: records.length,
    unsafeEvidenceCount: records.filter(({ reason }) => reason === "unsafe-evidence").length,
    unsafeRequestCount: records.filter(({ reason }) => reason === "unsafe-request").length,
  });
}

export function createContentGapReport(
  request: ContentGapReportRequest,
): ContentGapReport {
  const active = request.records
    .filter((record) => activeRecord(record, request.workspaceId, request.scope))
    .sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        compareText(left.id, right.id),
    );
  const retained = active.slice(0, maximumContentGapRecords);
  return Object.freeze({
    gaps: rankedGaps(retained),
    recordsExamined: retained.length,
    recordsReceived: request.records.length,
    recordsTruncated:
      request.records.length >= maximumContentGapRecords ||
      active.length > retained.length,
    sourceObservations: sourceObservations(retained),
    topicGuardrails: topicGuardrailObservation(
      retained,
      request.topicConfiguration,
    ),
  });
}
