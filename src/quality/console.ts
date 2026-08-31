// ABOUTME: Shapes redacted quality records, evaluation comparisons, retained replays, and CSV exports.
// ABOUTME: Keeps the administrator console bounded to explicit fields without surfacing provider failures.
import type {
  ConversationAnalyticsRecord,
  ConversationOutcome,
} from "@/outcomes/records";
import type {
  EvaluationRun,
  SavedQuestion,
  SavedQuestionClassification,
} from "@/db/repository";

export const qualityConsoleRecordLimit = 50;
export const qualityEvaluationQuestionLimit = 100;
export const qualityEvaluationMaximumAnswerUtf8Bytes = 4_096;
export const qualityPlaygroundMaximumAnswerUtf8Bytes = 16_384;
export const qualityEvaluationSchema = "opas.quality-evaluation.v3";
export const qualityReviewImportSchema = "opas.quality-review.v1";

export type QualitySourceTrace = Readonly<{
  articleContentHash: string;
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  excerpt: string;
  headingPath: readonly string[];
  indexGeneration: number;
  mode: "hybrid" | "lexical" | "vector";
  ordinal: number;
  score: number;
  sourceId: string;
  sourceLineRange: Readonly<{ end: number; start: number }>;
  title: string;
}>;

export type QualityEvaluationSourceTrace = QualitySourceTrace;

export type QualityEvaluationCitation = Readonly<{
  accepted: boolean;
  articleContentHash: string;
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  id: string;
  provenanceValid: boolean;
  sourceId: string;
  title: string;
}>;

export type QualityEvaluationClaim = Readonly<{
  citationCovered: boolean;
  citationId: string;
  markdown: string;
  ordinal: number;
  provenanceValid: boolean;
  sourceId: string;
}>;

export type QualityManualClaimReview = Readonly<{
  citationCovered: boolean;
  entailed: boolean;
  ordinal: number;
}>;

export type QualityManualReview = Readonly<{
  claims: readonly QualityManualClaimReview[];
  grounded: boolean;
  materiallyCorrect: boolean;
  reviewedAt: string;
}>;

export type QualityGenerationIdentity = Readonly<{
  model: string;
  provider: "cloudflare-workers-ai" | "openai-compatible";
}>;

export type QualityQuestionResult = Readonly<{
  actualOutcome: "answer" | "abstain";
  answer: string | null;
  citations: readonly QualityEvaluationCitation[];
  claims: readonly QualityEvaluationClaim[];
  classification: SavedQuestionClassification;
  costMicrodollars: number | null;
  durationMilliseconds: number;
  expectedOutcome: SavedQuestion["expectedOutcome"];
  firstTokenMilliseconds: number | null;
  generation: QualityGenerationIdentity | null;
  id: string;
  inputTokens: number | null;
  outputTokens: number | null;
  passed: boolean;
  manualReview: QualityManualReview | null;
  provenanceValid: boolean;
  question: string;
  reason: string | null;
  sourceHit: boolean;
  totalTokens: number | null;
  trace: readonly QualityEvaluationSourceTrace[];
}>;

export type QualityEvaluationResults = Readonly<{
  questions: readonly QualityQuestionResult[];
  schema: typeof qualityEvaluationSchema;
  summary: Readonly<{
    answered: number;
    abstained: number;
    citationCount: number;
    claimCount: number;
    costMicrodollars: number | null;
    coveredClaimCount: number;
    firstTokenP95Milliseconds: number | null;
    inputTokens: number | null;
    latencyP95Milliseconds: number;
    manualAnswerScore: QualityScoreRatio;
    manualClaimScore: QualityScoreRatio;
    outputTokens: number | null;
    passed: number;
    perClassification: readonly QualityClassificationSummary[];
    generations: readonly Readonly<{
      costMicrodollars: number | null;
      model: string;
      provider: string;
      questions: number;
    }>[];
    totalTokens: number | null;
    total: number;
  }>;
}>;

export type QualityScoreRatio = Readonly<{
  denominator: number;
  numerator: number;
}>;

export type QualityClassificationSummary = Readonly<{
  classification: SavedQuestionClassification;
  automaticPass: QualityScoreRatio;
  manualAnswerScore: QualityScoreRatio;
  manualClaimScore: QualityScoreRatio;
}>;

export type QualityRunComparison = Readonly<{
  baselineId: string;
  candidateId: string;
  passedDelta: number;
  rows: readonly Readonly<{
    baselinePassed: boolean | null;
    candidatePassed: boolean | null;
    id: string;
    question: string;
    status: "added" | "improved" | "regressed" | "removed" | "unchanged";
  }>[];
}>;

export type QualityReleaseGateStatus = "blocked" | "missing-evidence" | "ready";

export type QualityReleaseRatioGate = Readonly<{
  denominator: number;
  expectedDenominator: number;
  id:
    | "answerable-responses"
    | "citation-provenance"
    | "manual-answers"
    | "manual-claims"
    | "unsupported-adversarial-abstentions";
  label: string;
  numerator: number;
  requiredPercent: 90 | 100;
  status: "fail" | "missing-evidence" | "pass";
}>;

export type QualityReleaseGate = Readonly<{
  productionFirstToken: Readonly<{
    maximumP95Milliseconds: 3_000;
    p95Milliseconds: number | null;
    sampleCount: number;
    status: "fail" | "missing-evidence" | "pass";
  }>;
  ratios: readonly QualityReleaseRatioGate[];
  status: QualityReleaseGateStatus;
}>;

export type ConversationOutcomeSummary = Readonly<{
  counts: Readonly<Record<ConversationOutcome, number>>;
  reconciled: boolean;
  reconciledTotal: number;
  total: number;
}>;

export type RetainedConversationReplay = Readonly<{
  answer: string | null;
  id: string;
  messages: ConversationAnalyticsRecord["conversation"];
  outcome: ConversationAnalyticsRecord["outcome"];
  question: string | null;
  reason: string | null;
  trace: readonly QualitySourceTrace[];
}>;

const encoder = new TextEncoder();
const expectedOutcomes = new Set(["answer", "abstain", "either"]);
export const qualityClassifications = Object.freeze([
  "answerable",
  "ambiguous",
  "unsupported",
  "stale-conflicting",
  "adversarial",
] as const satisfies readonly SavedQuestionClassification[]);
const classifications = new Set<SavedQuestionClassification>(
  qualityClassifications,
);
const retrievalModes = new Set(["hybrid", "lexical", "vector"]);
const hashPattern = /^[a-f0-9]{64}$/u;
const citationIdPattern = /^C[1-5]$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    )
  );
}

function canonicalTimestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function finiteInteger(value: unknown, minimum = 0) {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function safeText(value: unknown, maximum = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function parsedTrace(value: unknown): readonly QualitySourceTrace[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const trace: QualitySourceTrace[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "articleId",
            "articleContentHash",
            "canonicalUrl",
            "contentHash",
            "excerpt",
            "headingPath",
            "indexGeneration",
            "mode",
            "ordinal",
            "score",
            "sourceId",
            "sourceLineRange",
            "title",
          ].includes(key),
      ) ||
      !safeText(entry.articleId, 200) ||
      typeof entry.articleContentHash !== "string" ||
      !hashPattern.test(entry.articleContentHash) ||
      !safeText(entry.canonicalUrl) ||
      typeof entry.contentHash !== "string" ||
      !hashPattern.test(entry.contentHash) ||
      !safeText(entry.excerpt, 1_024) ||
      !Array.isArray(entry.headingPath) ||
      entry.headingPath.length > 10 ||
      entry.headingPath.some(
        (heading) => !safeText(heading, 500),
      ) ||
      !finiteInteger(entry.indexGeneration, 1) ||
      !retrievalModes.has(entry.mode as string) ||
      !finiteInteger(entry.ordinal) ||
      typeof entry.score !== "number" ||
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      !safeText(entry.sourceId, 200) ||
      !isRecord(entry.sourceLineRange) ||
      Object.keys(entry.sourceLineRange).some(
        (key) => !["end", "start"].includes(key),
      ) ||
      Object.keys(entry.sourceLineRange).length !== 2 ||
      !finiteInteger(entry.sourceLineRange.start, 1) ||
      !finiteInteger(entry.sourceLineRange.end, 1) ||
      (entry.sourceLineRange.end as number) <
        (entry.sourceLineRange.start as number) ||
      (entry.sourceLineRange.end as number) > 1_000_000 ||
      !safeText(entry.title, 1_000)
    ) {
      return null;
    }
    trace.push(
      Object.freeze({
        articleContentHash: entry.articleContentHash,
        articleId: entry.articleId,
        canonicalUrl: entry.canonicalUrl,
        contentHash: entry.contentHash,
        excerpt: entry.excerpt,
        headingPath: Object.freeze([...(entry.headingPath as string[])]),
        indexGeneration: entry.indexGeneration as number,
        mode: entry.mode as QualitySourceTrace["mode"],
        ordinal: entry.ordinal as number,
        score: entry.score,
        sourceId: entry.sourceId,
        sourceLineRange: Object.freeze({
          end: entry.sourceLineRange.end as number,
          start: entry.sourceLineRange.start as number,
        }),
        title: entry.title,
      }),
    );
  }
  return Object.freeze(trace);
}

function parsedEvaluationTrace(
  value: unknown,
): readonly QualityEvaluationSourceTrace[] | null {
  return parsedTrace(value);
}

function parsedCitations(
  value: unknown,
): readonly QualityEvaluationCitation[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const citations: QualityEvaluationCitation[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "accepted",
            "articleContentHash",
            "articleId",
            "canonicalUrl",
            "contentHash",
            "id",
            "provenanceValid",
            "sourceId",
            "title",
          ].includes(key),
      ) ||
      typeof entry.accepted !== "boolean" ||
      typeof entry.articleContentHash !== "string" ||
      !hashPattern.test(entry.articleContentHash) ||
      !safeText(entry.articleId, 200) ||
      !safeText(entry.canonicalUrl) ||
      safeQualitySourceUrl(entry.canonicalUrl) === null ||
      typeof entry.contentHash !== "string" ||
      !hashPattern.test(entry.contentHash) ||
      typeof entry.id !== "string" ||
      !citationIdPattern.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.provenanceValid !== "boolean" ||
      !safeText(entry.sourceId, 200) ||
      !safeText(entry.title, 1_000)
    ) {
      return null;
    }
    ids.add(entry.id);
    citations.push(
      Object.freeze({
        accepted: entry.accepted,
        articleContentHash: entry.articleContentHash,
        articleId: entry.articleId,
        canonicalUrl: entry.canonicalUrl,
        contentHash: entry.contentHash,
        id: entry.id,
        provenanceValid: entry.provenanceValid,
        sourceId: entry.sourceId,
        title: entry.title,
      }),
    );
  }
  return Object.freeze(citations);
}

function parsedClaims(
  value: unknown,
  citationIds: ReadonlySet<string>,
): readonly QualityEvaluationClaim[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const claims: QualityEvaluationClaim[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "citationCovered",
            "citationId",
            "markdown",
            "ordinal",
            "provenanceValid",
            "sourceId",
          ].includes(key),
      ) ||
      typeof entry.citationCovered !== "boolean" ||
      typeof entry.citationId !== "string" ||
      !citationIdPattern.test(entry.citationId) ||
      !citationIds.has(entry.citationId) ||
      !safeText(entry.markdown, qualityEvaluationMaximumAnswerUtf8Bytes) ||
      entry.ordinal !== claims.length ||
      typeof entry.provenanceValid !== "boolean" ||
      !safeText(entry.sourceId, 200)
    ) {
      return null;
    }
    claims.push(
      Object.freeze({
        citationCovered: entry.citationCovered,
        citationId: entry.citationId,
        markdown: entry.markdown,
        ordinal: entry.ordinal,
        provenanceValid: entry.provenanceValid,
        sourceId: entry.sourceId,
      }),
    );
  }
  return Object.freeze(claims);
}

function parsedGeneration(
  value: unknown,
): QualityGenerationIdentity | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !["model", "provider"].includes(key)) ||
    !safeText(value.model, 500) ||
    (value.provider !== "cloudflare-workers-ai" &&
      value.provider !== "openai-compatible")
  ) {
    return undefined;
  }
  return Object.freeze({ model: value.model, provider: value.provider });
}

function parsedManualReview(
  value: unknown,
  claims: readonly QualityEvaluationClaim[],
): QualityManualReview | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) =>
        !["claims", "grounded", "materiallyCorrect", "reviewedAt"].includes(
          key,
        ),
    ) ||
    typeof value.grounded !== "boolean" ||
    typeof value.materiallyCorrect !== "boolean" ||
    typeof value.reviewedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      value.reviewedAt,
    ) ||
    !canonicalTimestamp(value.reviewedAt) ||
    !Array.isArray(value.claims) ||
    value.claims.length !== claims.length
  ) {
    return undefined;
  }
  const reviewClaims: QualityManualClaimReview[] = [];
  for (const [index, entry] of value.claims.entries()) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 3 ||
      Object.keys(entry).some(
        (key) => !["citationCovered", "entailed", "ordinal"].includes(key),
      ) ||
      entry.ordinal !== claims[index]?.ordinal ||
      typeof entry.entailed !== "boolean" ||
      typeof entry.citationCovered !== "boolean"
    ) {
      return undefined;
    }
    reviewClaims.push(
      Object.freeze({
        citationCovered: entry.citationCovered,
        entailed: entry.entailed,
        ordinal: entry.ordinal,
      }),
    );
  }
  return Object.freeze({
    claims: Object.freeze(reviewClaims),
    grounded: value.grounded,
    materiallyCorrect: value.materiallyCorrect,
    reviewedAt: value.reviewedAt,
  });
}

function nullableInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    value === null ||
    (finiteInteger(value) && (value as number) <= maximum)
  );
}

function expectedQuestionPass(
  expectedOutcome: SavedQuestion["expectedOutcome"],
  actualOutcome: QualityQuestionResult["actualOutcome"],
  provenanceValid: boolean,
  sourceHit: boolean,
) {
  const outcomeMatches =
    expectedOutcome === "either" || expectedOutcome === actualOutcome;
  return (
    outcomeMatches &&
    (actualOutcome === "abstain" ||
      (provenanceValid &&
        (expectedOutcome !== "answer" || sourceHit)))
  );
}

function totalOrNull(values: readonly (number | null)[]) {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value as number), 0);
}

function percentile95(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function scoreRatio(values: readonly boolean[]): QualityScoreRatio {
  return Object.freeze({
    denominator: values.length,
    numerator: values.filter(Boolean).length,
  });
}

function manualAnswerValues(questions: readonly QualityQuestionResult[]) {
  return questions.flatMap(({ manualReview }) =>
    manualReview
      ? [manualReview.grounded && manualReview.materiallyCorrect]
      : [],
  );
}

function manualClaimValues(questions: readonly QualityQuestionResult[]) {
  return questions.flatMap(({ manualReview }) =>
    manualReview
      ? manualReview.claims.map(
          ({ citationCovered, entailed }) => citationCovered && entailed,
        )
      : [],
  );
}

function generationSummary(questions: readonly QualityQuestionResult[]) {
  const groups = new Map<
    string,
    {
      costs: (number | null)[];
      model: string;
      provider: string;
      questions: number;
    }
  >();
  for (const question of questions) {
    if (!question.generation) continue;
    const key = `${question.generation.provider}\u0000${question.generation.model}`;
    const group = groups.get(key) ?? {
      costs: [],
      model: question.generation.model,
      provider: question.generation.provider,
      questions: 0,
    };
    group.costs.push(question.costMicrodollars);
    group.questions += 1;
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()]
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.model.localeCompare(right.model),
      )
      .map((group) =>
        Object.freeze({
          costMicrodollars: totalOrNull(group.costs),
          model: group.model,
          provider: group.provider,
          questions: group.questions,
        }),
      ),
  );
}

export function conversationLatencySummary(
  records: readonly ConversationAnalyticsRecord[],
) {
  const firstTokens = records.flatMap(({ firstTokenMilliseconds, outcome }) =>
    firstTokenMilliseconds === null || outcome === "abstained"
      ? []
      : [firstTokenMilliseconds],
  );
  return Object.freeze({
    firstTokenSamples: firstTokens.length,
    firstTokenP95Milliseconds: percentile95(firstTokens),
    totalLatencyP95Milliseconds: percentile95(
      records.map(({ durationMilliseconds }) => durationMilliseconds),
    ),
    totalSamples: records.length,
  });
}

export function conversationOutcomeSummary(
  records: readonly ConversationAnalyticsRecord[],
): ConversationOutcomeSummary {
  const counts: Record<ConversationOutcome, number> = {
    abandoned: 0,
    abstained: 0,
    answered: 0,
    escalated: 0,
    "low-rated": 0,
  };
  for (const record of records) counts[record.outcome] += 1;
  const reconciledTotal = Object.values(counts).reduce(
    (total, count) => total + count,
    0,
  );
  return Object.freeze({
    counts: Object.freeze(counts),
    reconciled: reconciledTotal === records.length,
    reconciledTotal,
    total: records.length,
  });
}

function releaseRatioGate(
  gate: Omit<QualityReleaseRatioGate, "status">,
): QualityReleaseRatioGate {
  const status =
    gate.expectedDenominator === 0 ||
    gate.denominator !== gate.expectedDenominator
      ? "missing-evidence"
      : gate.numerator * 100 >= gate.denominator * gate.requiredPercent
        ? "pass"
        : "fail";
  return Object.freeze({ ...gate, status });
}

export function evaluateQualityReleaseGate(
  results: QualityEvaluationResults,
  productionLatency: ReturnType<typeof conversationLatencySummary>,
): QualityReleaseGate {
  const answerable = results.questions.filter(
    ({ classification }) => classification === "answerable",
  );
  const unsupportedOrAdversarial = results.questions.filter(
    ({ classification }) =>
      classification === "unsupported" || classification === "adversarial",
  );
  const answerableResponses = answerable.filter(
    ({ actualOutcome }) => actualOutcome === "answer",
  );
  const reviewedAnswerableResponses = answerableResponses.filter(
    ({ manualReview }) => manualReview !== null,
  );
  const claims = results.questions.flatMap(({ claims: questionClaims }) =>
    questionClaims,
  );
  const reviewedClaims = results.questions.flatMap(({ manualReview }) =>
    manualReview?.claims ?? [],
  );
  const citations = results.questions.flatMap(
    ({ citations: questionCitations }) => questionCitations,
  );
  const ratios = Object.freeze([
    releaseRatioGate({
      denominator: answerable.length,
      expectedDenominator: answerable.length,
      id: "answerable-responses",
      label: "Answerable responses with accepted current evidence",
      numerator: answerable.filter(
        ({ actualOutcome, passed }) => actualOutcome === "answer" && passed,
      ).length,
      requiredPercent: 90,
    }),
    releaseRatioGate({
      denominator: unsupportedOrAdversarial.length,
      expectedDenominator: unsupportedOrAdversarial.length,
      id: "unsupported-adversarial-abstentions",
      label: "Unsupported or adversarial questions abstained",
      numerator: unsupportedOrAdversarial.filter(
        ({ actualOutcome }) => actualOutcome === "abstain",
      ).length,
      requiredPercent: 90,
    }),
    releaseRatioGate({
      denominator: reviewedAnswerableResponses.length,
      expectedDenominator: answerableResponses.length,
      id: "manual-answers",
      label: "Answerable responses manually grounded and materially correct",
      numerator: reviewedAnswerableResponses.filter(
        ({ manualReview }) =>
          manualReview?.grounded && manualReview.materiallyCorrect,
      ).length,
      requiredPercent: 90,
    }),
    releaseRatioGate({
      denominator: reviewedClaims.length,
      expectedDenominator: claims.length,
      id: "manual-claims",
      label: "Material claims manually entailed and citation-covered",
      numerator: reviewedClaims.filter(
        ({ citationCovered, entailed }) => citationCovered && entailed,
      ).length,
      requiredPercent: 90,
    }),
    releaseRatioGate({
      denominator: citations.length,
      expectedDenominator: citations.length,
      id: "citation-provenance",
      label: "Citation URLs matched server-derived retrieval provenance",
      numerator: citations.filter(({ provenanceValid }) => provenanceValid).length,
      requiredPercent: 100,
    }),
  ] satisfies readonly QualityReleaseRatioGate[]);
  const productionFirstToken = Object.freeze({
    maximumP95Milliseconds: 3_000 as const,
    p95Milliseconds: productionLatency.firstTokenP95Milliseconds,
    sampleCount: productionLatency.firstTokenSamples,
    status:
      productionLatency.firstTokenP95Milliseconds === null ||
      productionLatency.firstTokenSamples === 0
        ? ("missing-evidence" as const)
        : productionLatency.firstTokenP95Milliseconds <= 3_000
          ? ("pass" as const)
          : ("fail" as const),
  });
  const statuses = [
    ...ratios.map(({ status }) => status),
    productionFirstToken.status,
  ];
  return Object.freeze({
    productionFirstToken,
    ratios,
    status: statuses.includes("fail")
      ? "blocked"
      : statuses.includes("missing-evidence")
        ? "missing-evidence"
        : "ready",
  });
}

function evaluationSummary(questions: readonly QualityQuestionResult[]) {
  return Object.freeze({
    answered: questions.filter(({ actualOutcome }) => actualOutcome === "answer")
      .length,
    abstained: questions.filter(({ actualOutcome }) => actualOutcome === "abstain")
      .length,
    citationCount: questions.reduce(
      (total, question) => total + question.citations.length,
      0,
    ),
    claimCount: questions.reduce(
      (total, question) => total + question.claims.length,
      0,
    ),
    costMicrodollars: totalOrNull(
      questions.map(({ costMicrodollars }) => costMicrodollars),
    ),
    coveredClaimCount: questions.reduce(
      (total, question) =>
        total +
        question.claims.filter(({ citationCovered }) => citationCovered).length,
      0,
    ),
    firstTokenP95Milliseconds: percentile95(
      questions.flatMap(({ firstTokenMilliseconds }) =>
        firstTokenMilliseconds === null ? [] : [firstTokenMilliseconds],
      ),
    ),
    inputTokens: totalOrNull(questions.map(({ inputTokens }) => inputTokens)),
    latencyP95Milliseconds:
      percentile95(questions.map(({ durationMilliseconds }) => durationMilliseconds)) ??
      0,
    manualAnswerScore: scoreRatio(manualAnswerValues(questions)),
    manualClaimScore: scoreRatio(manualClaimValues(questions)),
    outputTokens: totalOrNull(questions.map(({ outputTokens }) => outputTokens)),
    passed: questions.filter((question) => question.passed).length,
    perClassification: Object.freeze(
      qualityClassifications.map((classification) => {
        const classified = questions.filter(
          (question) => question.classification === classification,
        );
        return Object.freeze({
          automaticPass: scoreRatio(
            classified.map((question) => question.passed),
          ),
          classification,
          manualAnswerScore: scoreRatio(manualAnswerValues(classified)),
          manualClaimScore: scoreRatio(manualClaimValues(classified)),
        });
      }),
    ),
    generations: generationSummary(questions),
    total: questions.length,
    totalTokens: totalOrNull(questions.map(({ totalTokens }) => totalTokens)),
  });
}

function parsedQuestionResult(value: unknown): QualityQuestionResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "actualOutcome",
          "answer",
          "citations",
          "claims",
          "classification",
          "costMicrodollars",
          "durationMilliseconds",
          "expectedOutcome",
          "firstTokenMilliseconds",
          "generation",
          "id",
          "inputTokens",
          "manualReview",
          "outputTokens",
          "passed",
          "provenanceValid",
          "question",
          "reason",
          "sourceHit",
          "totalTokens",
          "trace",
        ].includes(key),
    ) ||
    (value.actualOutcome !== "answer" && value.actualOutcome !== "abstain") ||
    !classifications.has(value.classification as SavedQuestionClassification) ||
    !expectedOutcomes.has(value.expectedOutcome as string) ||
    !safeText(value.id, 200) ||
    !finiteInteger(value.durationMilliseconds) ||
    (value.durationMilliseconds as number) > 300_000 ||
    !nullableInteger(value.firstTokenMilliseconds, 300_000) ||
    !nullableInteger(value.inputTokens, 1_000_000) ||
    !nullableInteger(value.outputTokens, 8_192) ||
    !nullableInteger(value.totalTokens, 1_008_192) ||
    !nullableInteger(value.costMicrodollars, 2_000_000_000) ||
    typeof value.passed !== "boolean" ||
    typeof value.provenanceValid !== "boolean" ||
    !safeText(value.question) ||
    (value.reason !== null && !safeText(value.reason, 200)) ||
    typeof value.sourceHit !== "boolean"
  ) {
    return null;
  }
  const trace = parsedEvaluationTrace(value.trace);
  const citations = parsedCitations(value.citations);
  const claims = citations
    ? parsedClaims(value.claims, new Set(citations.map(({ id }) => id)))
    : null;
  if (trace === null || citations === null || claims === null) return null;
  const generation = parsedGeneration(value.generation);
  const manualReview = parsedManualReview(value.manualReview, claims);
  if (generation === undefined || manualReview === undefined) return null;
  const provenanceValid =
    citations.every((citation) => {
      const source = trace[Number(citation.id.slice(1)) - 1];
      return (
        citation.provenanceValid &&
        source !== undefined &&
        citation.articleContentHash === source.articleContentHash &&
        citation.articleId === source.articleId &&
        citation.canonicalUrl === source.canonicalUrl &&
        citation.contentHash === source.contentHash &&
        citation.sourceId === source.sourceId &&
        citation.title === source.title
      );
    }) &&
    claims.every(
      (claim) =>
        claim.citationCovered &&
        claim.provenanceValid &&
        citations.find(({ id }) => id === claim.citationId)?.sourceId ===
          claim.sourceId,
    );
  const sourceHit = citations.some((citation) => citation.accepted);
  const expectedPassed = expectedQuestionPass(
    value.expectedOutcome as SavedQuestion["expectedOutcome"],
    value.actualOutcome,
    provenanceValid,
    sourceHit,
  );
  const answer =
    value.answer === null
      ? null
      : safeText(value.answer, qualityEvaluationMaximumAnswerUtf8Bytes)
        ? value.answer
        : undefined;
  const answerShapeValid =
    value.actualOutcome === "answer"
      ? answer !== null &&
        answer !== undefined &&
        citations.length > 0 &&
        claims.length > 0 &&
        claims.map(({ markdown }) => markdown).join("\n\n") === answer &&
        generation !== null &&
        value.reason === null &&
        value.firstTokenMilliseconds !== null
      : answer === null &&
        citations.length === 0 &&
        claims.length === 0 &&
        manualReview === null &&
        value.firstTokenMilliseconds === null;
  const tokenUsageValid =
    (value.inputTokens === null) === (value.outputTokens === null) &&
    (value.inputTokens !== null || value.totalTokens === null) &&
    (value.inputTokens !== null || value.costMicrodollars === null) &&
    (value.totalTokens === null ||
      value.totalTokens ===
        (value.inputTokens as number) + (value.outputTokens as number));
  const abstentionMetricsValid =
    value.actualOutcome === "answer" ||
    (value.reason !== null &&
      (generation === null
        ? value.inputTokens === 0 &&
          value.outputTokens === 0 &&
          value.totalTokens === 0 &&
          value.costMicrodollars === 0
        : value.inputTokens !== null && value.outputTokens !== null));
  if (
    !answerShapeValid ||
    !tokenUsageValid ||
    !abstentionMetricsValid ||
    value.provenanceValid !== provenanceValid ||
    value.sourceHit !== sourceHit ||
    value.passed !== expectedPassed
  ) {
    return null;
  }
  return Object.freeze({
    actualOutcome: value.actualOutcome,
    answer: answer as string | null,
    citations,
    claims,
    classification: value.classification as SavedQuestionClassification,
    costMicrodollars: value.costMicrodollars as number | null,
    durationMilliseconds: value.durationMilliseconds as number,
    expectedOutcome: value.expectedOutcome as SavedQuestion["expectedOutcome"],
    firstTokenMilliseconds: value.firstTokenMilliseconds as number | null,
    generation,
    id: value.id,
    inputTokens: value.inputTokens as number | null,
    manualReview,
    outputTokens: value.outputTokens as number | null,
    passed: value.passed,
    provenanceValid,
    question: value.question,
    reason: value.reason as string | null,
    sourceHit,
    totalTokens: value.totalTokens as number | null,
    trace,
  });
}

export function parseQualityEvaluationResults(
  value: unknown,
): QualityEvaluationResults | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["questions", "schema", "summary"].includes(key),
    ) ||
    value.schema !== qualityEvaluationSchema ||
    !Array.isArray(value.questions) ||
    value.questions.length > qualityEvaluationQuestionLimit ||
    !isRecord(value.summary)
  ) {
    return null;
  }
  const questions: QualityQuestionResult[] = [];
  const ids = new Set<string>();
  for (const valueQuestion of value.questions) {
    const question = parsedQuestionResult(valueQuestion);
    if (!question || ids.has(question.id)) return null;
    ids.add(question.id);
    questions.push(question);
  }
  const summary = value.summary;
  const expectedSummary = evaluationSummary(questions);
  if (!sameJsonValue(summary, expectedSummary)) {
    return null;
  }
  return Object.freeze({
    questions: Object.freeze(questions),
    schema: qualityEvaluationSchema,
    summary: expectedSummary,
  });
}

export function createQualityEvaluationResults(
  questions: readonly QualityQuestionResult[],
): QualityEvaluationResults {
  if (questions.length < 1 || questions.length > qualityEvaluationQuestionLimit) {
    throw new Error("A quality evaluation requires a bounded question set");
  }
  return Object.freeze({
    questions: Object.freeze([...questions]),
    schema: qualityEvaluationSchema,
    summary: evaluationSummary(questions),
  });
}

export function compareQualityRuns(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): QualityRunComparison | null {
  if (
    baseline.workspaceId !== candidate.workspaceId ||
    baseline.status !== "completed" ||
    candidate.status !== "completed"
  ) {
    return null;
  }
  const baselineResults = parseQualityEvaluationResults(baseline.results);
  const candidateResults = parseQualityEvaluationResults(candidate.results);
  if (!baselineResults || !candidateResults) return null;
  const baselineById = new Map(
    baselineResults.questions.map((question) => [question.id, question]),
  );
  const candidateById = new Map(
    candidateResults.questions.map((question) => [question.id, question]),
  );
  const ids = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
  const rows = ids.map((id) => {
    const before = baselineById.get(id);
    const after = candidateById.get(id);
    let status: QualityRunComparison["rows"][number]["status"];
    if (!before) status = "added";
    else if (!after) status = "removed";
    else if (!before.passed && after.passed) status = "improved";
    else if (before.passed && !after.passed) status = "regressed";
    else status = "unchanged";
    return Object.freeze({
      baselinePassed: before?.passed ?? null,
      candidatePassed: after?.passed ?? null,
      id,
      question: after?.question ?? before?.question ?? id,
      status,
    });
  });
  return Object.freeze({
    baselineId: baseline.id,
    candidateId: candidate.id,
    passedDelta:
      candidateResults.summary.passed - baselineResults.summary.passed,
    rows: Object.freeze(rows),
  });
}

export function replayRetainedConversation(
  record: ConversationAnalyticsRecord,
): RetainedConversationReplay {
  let lastUserIndex = -1;
  for (let index = 0; index < record.conversation.length; index += 1) {
    if (record.conversation[index]?.role === "user") lastUserIndex = index;
  }
  const question =
    lastUserIndex >= 0 ? record.conversation[lastUserIndex]?.content ?? null : null;
  const answer =
    lastUserIndex >= 0
      ? record.conversation
          .slice(lastUserIndex + 1)
          .find(({ role }) => role === "assistant")?.content ?? null
      : null;
  return Object.freeze({
    answer,
    id: record.id,
    messages: Object.freeze(record.conversation.map((message) => Object.freeze({ ...message }))),
    outcome: record.outcome,
    question,
    reason: record.reason,
    trace: Object.freeze(
      record.retrievalTrace.map((entry) =>
        Object.freeze({
          ...entry,
          headingPath: Object.freeze([...entry.headingPath]),
          sourceLineRange: Object.freeze({ ...entry.sourceLineRange }),
        }),
      ),
    ),
  });
}

export function safeQualitySourceUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function formulaSafeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^(?:[\t\r\n]|\s*[=+@-])/u.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown) {
  return `"${formulaSafeCell(value).replaceAll('"', '""')}"`;
}

function csv(rows: readonly (readonly unknown[])[]) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function conversationQualityCsv(
  records: readonly ConversationAnalyticsRecord[],
) {
  return csv([
    [
      "conversation_id",
      "outcome",
      "reason",
      "started_at",
      "expires_at",
      "total_latency_ms",
      "first_content_token_ms",
      "input_tokens",
      "output_tokens",
      "cost_microdollars",
      "provider",
      "model",
      "question",
      "answer",
      "source_ids",
      "source_content_hashes",
      "article_content_hashes",
      "source_headings",
      "source_line_ranges",
      "source_scores",
      "source_excerpts",
    ],
    ...records.map((record) => {
      const replay = replayRetainedConversation(record);
      return [
        record.id,
        record.outcome,
        record.reason,
        record.startedAt.toISOString(),
        record.expiresAt.toISOString(),
        record.durationMilliseconds,
        record.firstTokenMilliseconds,
        record.inputTokens,
        record.outputTokens,
        record.costMicrodollars,
        record.provider,
        record.model,
        replay.question,
        replay.answer,
        replay.trace.map(({ sourceId }) => sourceId).join(" | "),
        replay.trace.map(({ contentHash }) => contentHash).join(" | "),
        replay.trace
          .map(({ articleContentHash }) => articleContentHash)
          .join(" | "),
        replay.trace
          .map(({ headingPath }) => headingPath.join(" > "))
          .join(" | "),
        replay.trace
          .map(({ sourceLineRange }) =>
            `${sourceLineRange.start}-${sourceLineRange.end}`,
          )
          .join(" | "),
        replay.trace.map(({ score }) => score).join(" | "),
        replay.trace.map(({ excerpt }) => excerpt).join(" | "),
      ];
    }),
  ]);
}

export function evaluationQualityCsv(runs: readonly EvaluationRun[]) {
  const rows: unknown[][] = [[
    "run_id",
    "question_set_id",
    "started_at",
    "completed_at",
    "index_generation",
    "retrieval_mode",
    "configured_provider",
    "configured_model",
    "status",
    "question_id",
    "classification",
    "expected_outcome",
    "actual_outcome",
    "passed",
    "question",
    "answer",
    "duration_ms",
    "first_content_token_ms",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_microdollars",
    "actual_provider",
    "actual_model",
    "provenance_valid",
    "source_hit",
    "citation_ids",
    "source_ids",
    "source_content_hashes",
    "article_content_hashes",
    "citation_urls",
    "claim_count",
    "covered_claim_count",
    "claim_citations",
    "claim_source_ids",
    "claim_markdown",
    "manual_grounded",
    "manual_materially_correct",
    "manual_reviewed_at",
    "manual_entailed_claim_count",
    "manual_citation_covered_claim_count",
    "manual_claim_count",
    "class_automatic_pass_numerator",
    "class_automatic_pass_denominator",
    "class_manual_answer_numerator",
    "class_manual_answer_denominator",
    "class_manual_claim_numerator",
    "class_manual_claim_denominator",
    "source_scores",
    "source_excerpts",
  ]];
  const columns = new Map(
    (rows[0] as string[]).map((column, index) => [column, index] as const),
  );
  for (const run of runs) {
    const results = parseQualityEvaluationResults(run.results);
    if (!results) {
      rows.push([
        run.id,
        run.questionSetId,
        run.startedAt.toISOString(),
        run.completedAt?.toISOString() ?? "",
        run.indexGeneration,
        run.retrievalMode,
        run.provider,
        run.model,
        run.status,
        ...Array.from({ length: 41 }, () => ""),
      ]);
      continue;
    }
    for (const classSummary of results.summary.perClassification) {
      const row = Array.from({ length: rows[0]!.length }, () => "") as unknown[];
      row[columns.get("run_id")!] = run.id;
      row[columns.get("question_set_id")!] = run.questionSetId;
      row[columns.get("started_at")!] = run.startedAt.toISOString();
      row[columns.get("completed_at")!] = run.completedAt?.toISOString() ?? "";
      row[columns.get("index_generation")!] = run.indexGeneration;
      row[columns.get("retrieval_mode")!] = run.retrievalMode;
      row[columns.get("configured_provider")!] = run.provider;
      row[columns.get("configured_model")!] = run.model;
      row[columns.get("status")!] = run.status;
      row[columns.get("classification")!] = classSummary.classification;
      row[columns.get("class_automatic_pass_numerator")!] =
        classSummary.automaticPass.numerator;
      row[columns.get("class_automatic_pass_denominator")!] =
        classSummary.automaticPass.denominator;
      row[columns.get("class_manual_answer_numerator")!] =
        classSummary.manualAnswerScore.numerator;
      row[columns.get("class_manual_answer_denominator")!] =
        classSummary.manualAnswerScore.denominator;
      row[columns.get("class_manual_claim_numerator")!] =
        classSummary.manualClaimScore.numerator;
      row[columns.get("class_manual_claim_denominator")!] =
        classSummary.manualClaimScore.denominator;
      rows.push(row);
    }
    for (const question of results.questions) {
      const classSummary = results.summary.perClassification.find(
        ({ classification }) => classification === question.classification,
      )!;
      rows.push([
        run.id,
        run.questionSetId,
        run.startedAt.toISOString(),
        run.completedAt?.toISOString() ?? "",
        run.indexGeneration,
        run.retrievalMode,
        run.provider,
        run.model,
        run.status,
        question.id,
        question.classification,
        question.expectedOutcome,
        question.actualOutcome,
        question.passed,
        question.question,
        question.answer,
        question.durationMilliseconds,
        question.firstTokenMilliseconds,
        question.inputTokens,
        question.outputTokens,
        question.totalTokens,
        question.costMicrodollars,
        question.generation?.provider ?? "",
        question.generation?.model ?? "",
        question.provenanceValid,
        question.sourceHit,
        question.citations.map(({ id }) => id).join(" | "),
        question.citations.map(({ sourceId }) => sourceId).join(" | "),
        question.citations.map(({ contentHash }) => contentHash).join(" | "),
        question.citations
          .map(({ articleContentHash }) => articleContentHash)
          .join(" | "),
        question.citations.map(({ canonicalUrl }) => canonicalUrl).join(" | "),
        question.claims.length,
        question.claims.filter(({ citationCovered }) => citationCovered).length,
        question.claims
          .map(({ citationId, ordinal }) => `${ordinal}:${citationId}`)
          .join(" | "),
        question.claims
          .map(({ ordinal, sourceId }) => `${ordinal}:${sourceId}`)
          .join(" | "),
        question.claims.map(({ markdown }) => markdown).join(" | "),
        question.manualReview?.grounded ?? "",
        question.manualReview?.materiallyCorrect ?? "",
        question.manualReview?.reviewedAt ?? "",
        question.manualReview?.claims.filter(({ entailed }) => entailed).length ??
          "",
        question.manualReview?.claims.filter(
          ({ citationCovered }) => citationCovered,
        ).length ?? "",
        question.manualReview?.claims.length ?? "",
        classSummary.automaticPass.numerator,
        classSummary.automaticPass.denominator,
        classSummary.manualAnswerScore.numerator,
        classSummary.manualAnswerScore.denominator,
        classSummary.manualClaimScore.numerator,
        classSummary.manualClaimScore.denominator,
        question.trace.map(({ score }) => score).join(" | "),
        question.trace.map(({ excerpt }) => excerpt).join(" | "),
      ]);
    }
  }
  return csv(rows);
}

export function qualityCsvAttachmentHeaders(filename: string) {
  const safeFilename = /^[a-z0-9][a-z0-9._-]{0,79}\.csv$/u.test(filename)
    ? filename
    : "opas-quality.csv";
  return Object.freeze({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${safeFilename}"`,
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "text/csv; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
}
