// ABOUTME: Runs bounded saved-question evaluations and ephemeral administrator answer checks.
// ABOUTME: Uses only the active workspace and reduces runtime failures to safe quality states.
import type { AnswerRuntime } from "@/answers/answer-runtime";
import {
  maximumAnswerEvidenceResults,
  maximumAnswerHistoryMessages,
  type AnswerCitation,
  type AnswerEvent,
  type AnswerHistoryMessage,
} from "@/answers/answer";
import type { GenerationUsage } from "@/ai/generation";
import type {
  EvaluationRun,
  Repository,
  SavedQuestionSet,
} from "@/db/repository";
import { AuthoringPausedError, normalizeAuthoringError } from "@/db/authoring-controls";
import {
  estimateConversationCostMicrodollars,
  normalizeConversationAnalyticsId,
  type ConversationAnalyticsRecord,
} from "@/outcomes/records";
import type {
  ConversationAnalyticsReadScope,
  ConversationAnalyticsStore,
} from "@/outcomes/store";
import {
  createQualityEvaluationResults,
  qualityConsoleRecordLimit,
  qualityEvaluationQuestionLimit,
  qualityEvaluationMaximumAnswerUtf8Bytes,
  qualityPlaygroundMaximumAnswerUtf8Bytes,
  replayRetainedConversation,
  type QualityEvaluationCitation,
  type QualityEvaluationClaim,
  type QualityQuestionResult,
  type QualityEvaluationSourceTrace,
  type QualitySourceTrace,
} from "@/quality/console";
import {
  createEvidenceRetriever,
  createRepositoryEvidenceSource,
  type EvidenceRetrievalResult,
} from "@/search/evidence";

export const qualityPlaygroundTimeoutMilliseconds = 20_000;
export const qualityRetainedReplayTimeoutMilliseconds = 20_000;
export const qualityEvaluationTimeoutMilliseconds = 50_000;
export const qualityEvaluationConcurrency = 4;

const maximumRetainedReplayHistoryUtf8Bytes = 8_192;
const retainedRedactionMarker = /\[REDACTED\]/giu;

export type QualityRepository = Pick<
  Repository,
  | "finishEvaluationRun"
  | "getIndexingState"
  | "getQuestionSet"
  | "listActiveChunkEmbeddings"
  | "listEvaluationRuns"
  | "listEvidenceChunks"
  | "listQuestionSets"
  | "revalidateEvidenceCandidates"
  | "startEvaluationRun"
>;

export type QualityConsoleData = Readonly<{
  analyticsStatus: "disabled" | "enabled" | "unavailable";
  conversations: readonly ConversationAnalyticsRecord[];
  questionSets: readonly SavedQuestionSet[];
  runs: readonly EvaluationRun[];
}>;

export type QualityPlaygroundResult = Readonly<{
  answer: string | null;
  citations: readonly string[];
  generation: Readonly<{ model: string; provider: string }> | null;
  outcome: "abstain" | "answer" | "unavailable";
  preflightTrace: readonly QualitySourceTrace[];
  question: string;
  reason: string | null;
}>;

export type QualityRetainedReplayResult = Readonly<{
  answer: string | null;
  citations: readonly Readonly<{ id: string; sourceId: string }>[];
  generation: Readonly<{ model: string; provider: string }>;
  outcome: "abstain" | "answer";
  question: string;
  reason: string | null;
}>;

export type QualityAnalyticsAccess =
  | Readonly<{ status: "disabled" | "unavailable" }>
  | Readonly<{
      scope: ConversationAnalyticsReadScope;
      status: "enabled";
      store: ConversationAnalyticsStore;
    }>;

export type QualityRuntimeDependencies = Readonly<{
  costRates?: readonly Readonly<{
    inputMicrodollarsPerMillionTokens?: string;
    model: string;
    outputMicrodollarsPerMillionTokens?: string;
    provider: string;
  }>[];
  createAnswerRuntime: () => Promise<AnswerRuntime>;
  evaluationTimeoutMilliseconds?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  randomId?: () => string;
  repository: QualityRepository;
  timeoutMilliseconds?: number;
}>;

export type QualityRetainedReplayDependencies = Readonly<{
  createAnswerRuntime: (
    evidence: readonly EvidenceRetrievalResult[],
  ) => Promise<AnswerRuntime>;
  timeoutMilliseconds?: number;
}>;

export class QualityConsoleError extends Error {
  readonly code:
    | "invalid-request"
    | "not-found"
    | "not-ready"
    | "too-many-questions"
    | "unavailable";

  constructor(code: QualityConsoleError["code"]) {
    super(code);
    this.name = "QualityConsoleError";
    this.code = code;
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

export function normalizeQualityQuestion(value: unknown) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new QualityConsoleError("invalid-request");
  }
  const question = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !question ||
    Array.from(question).length > 200 ||
    /[\u202a-\u202e\u2066-\u2069]/u.test(question)
  ) {
    throw new QualityConsoleError("invalid-request");
  }
  return question;
}

function sourceTrace(result: EvidenceRetrievalResult): QualitySourceTrace {
  return Object.freeze({
    articleContentHash: result.articleContentHash,
    articleId: result.articleId,
    canonicalUrl: result.canonicalUrl,
    contentHash: result.contentHash,
    excerpt: truncateUtf8(result.evidenceText, 1_024),
    headingPath: Object.freeze([...result.headingPath]),
    indexGeneration: result.indexGeneration,
    mode: result.mode,
    ordinal: result.ordinal,
    score: result.score,
    sourceId: result.sourceId,
    sourceLineRange: Object.freeze({ ...result.sourceLineRange }),
    title: result.title,
  });
}

function evaluationSourceTrace(
  result: EvidenceRetrievalResult,
): QualityEvaluationSourceTrace {
  return sourceTrace(result);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function citedEvidence(
  citation: AnswerCitation,
  retrieved: readonly EvidenceRetrievalResult[],
) {
  const position = Number(citation.id.slice(1)) - 1;
  const evidence = retrieved[position];
  if (
    !evidence ||
    citation.id !== `C${position + 1}` ||
    citation.sourceId !== evidence.sourceId ||
    citation.articleId !== evidence.articleId ||
    citation.articleContentHash !== evidence.articleContentHash ||
    citation.contentHash !== evidence.contentHash ||
    citation.canonicalUrl !== evidence.canonicalUrl ||
    citation.title !== evidence.title ||
    !sameStrings(citation.headingPath, evidence.headingPath) ||
    citation.sourceLineRange.start !== evidence.sourceLineRange.start ||
    citation.sourceLineRange.end !== evidence.sourceLineRange.end
  ) {
    throw new QualityConsoleError("unavailable");
  }
  return evidence;
}

function elapsedMilliseconds(startedAt: number, endedAt: number) {
  const duration = Math.round(endedAt - startedAt);
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > 300_000) {
    throw new QualityConsoleError("unavailable");
  }
  return duration;
}

function validUsage(usage: GenerationUsage | undefined) {
  if (!usage) return null;
  const { inputTokens, outputTokens, totalTokens } = usage;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0 ||
    (totalTokens !== null &&
      (!Number.isSafeInteger(totalTokens) ||
        totalTokens !== (inputTokens as number) + (outputTokens as number)))
  ) {
    return null;
  }
  return Object.freeze({
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens,
  });
}

function questionPassed(
  question: SavedQuestionSet["questions"][number],
  actualOutcome: QualityQuestionResult["actualOutcome"],
  provenanceValid: boolean,
  sourceHit: boolean,
) {
  return (
    (question.expectedOutcome === "either" ||
      question.expectedOutcome === actualOutcome) &&
    (actualOutcome === "abstain" ||
      (provenanceValid &&
        (question.expectedOutcome !== "answer" || sourceHit)))
  );
}

export async function loadQualityConsoleData(
  workspaceId: string,
  repository: QualityRepository,
  analytics: QualityAnalyticsAccess,
): Promise<QualityConsoleData> {
  if (!validIdentifier(workspaceId)) {
    throw new QualityConsoleError("invalid-request");
  }
  const [questionSets, runs, conversations] = await Promise.all([
    repository.listQuestionSets(workspaceId, qualityConsoleRecordLimit),
    repository.listEvaluationRuns(workspaceId, qualityConsoleRecordLimit),
    analytics.status === "enabled"
      ? analytics.store.list(
          workspaceId,
          analytics.scope,
          qualityConsoleRecordLimit,
        )
      : Promise.resolve([]),
  ]);
  return Object.freeze({
    analyticsStatus: analytics.status,
    conversations: Object.freeze([...conversations]),
    questionSets: Object.freeze([...questionSets]),
    runs: Object.freeze([...runs]),
  });
}

function sameRetainedEvidence(
  left: EvidenceRetrievalResult,
  right: EvidenceRetrievalResult,
) {
  return (
    left.articleContentHash === right.articleContentHash &&
    left.articleId === right.articleId &&
    left.canonicalUrl === right.canonicalUrl &&
    left.chunkId === right.chunkId &&
    left.contentHash === right.contentHash &&
    left.evidenceText === right.evidenceText &&
    sameStrings(left.headingPath, right.headingPath) &&
    left.indexGeneration === right.indexGeneration &&
    left.mode === right.mode &&
    left.ordinal === right.ordinal &&
    left.score === right.score &&
    left.sourceId === right.sourceId &&
    left.sourceLineRange.start === right.sourceLineRange.start &&
    left.sourceLineRange.end === right.sourceLineRange.end &&
    left.title === right.title &&
    left.workspaceId === right.workspaceId
  );
}

function retainedEvidenceSnapshot(
  workspaceId: string,
  record: ConversationAnalyticsRecord,
) {
  if (
    record.retrievalTrace.length === 0 ||
    record.retrievalTrace.length > maximumAnswerEvidenceResults
  ) {
    throw new QualityConsoleError("not-ready");
  }
  return Object.freeze(
    record.retrievalTrace.map((source) => {
      if (!source.excerpt.replace(retainedRedactionMarker, "").trim()) {
        throw new QualityConsoleError("not-ready");
      }
      return Object.freeze({
        articleContentHash: source.articleContentHash,
        articleId: source.articleId,
        canonicalUrl: source.canonicalUrl,
        chunkId: source.sourceId,
        contentHash: source.contentHash,
        evidenceText: source.excerpt,
        headingPath: Object.freeze([...source.headingPath]),
        indexGeneration: source.indexGeneration,
        markdown: source.excerpt,
        mode: source.mode,
        ordinal: source.ordinal,
        score: source.score,
        sourceId: source.sourceId,
        sourceLineRange: Object.freeze({ ...source.sourceLineRange }),
        title: source.title,
        workspaceId,
      }) satisfies EvidenceRetrievalResult;
    }),
  );
}

function retainedReplayInput(record: ConversationAnalyticsRecord) {
  const replay = replayRetainedConversation(record);
  if (replay.question === null) throw new QualityConsoleError("not-ready");
  let question: string;
  try {
    question = normalizeQualityQuestion(replay.question);
  } catch {
    throw new QualityConsoleError("not-ready");
  }
  let questionIndex = -1;
  for (let index = record.conversation.length - 1; index >= 0; index -= 1) {
    if (record.conversation[index]?.role === "user") {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) throw new QualityConsoleError("not-ready");
  const encoder = new TextEncoder();
  const history: AnswerHistoryMessage[] = [];
  let historyBytes = 0;
  for (
    let index = questionIndex - 1;
    index >= 0 && history.length < maximumAnswerHistoryMessages;
    index -= 1
  ) {
    const message = record.conversation[index]!;
    const messageBytes = encoder.encode(message.content.trim()).byteLength;
    if (historyBytes + messageBytes > maximumRetainedReplayHistoryUtf8Bytes) {
      break;
    }
    history.unshift(Object.freeze({
      content: message.content,
      role: message.role,
    }));
    historyBytes += messageBytes;
  }
  return Object.freeze({
    history: Object.freeze(history),
    question,
  });
}

function validRetainedRecord(
  workspaceId: string,
  conversationId: string,
  record: ConversationAnalyticsRecord,
  scope: ConversationAnalyticsReadScope,
) {
  return (
    record.workspaceId === workspaceId &&
    record.id === conversationId &&
    record.expiresAt instanceof Date &&
    record.startedAt instanceof Date &&
    scope.readAt instanceof Date &&
    scope.retentionStartedAt instanceof Date &&
    Number.isFinite(record.expiresAt.getTime()) &&
    Number.isFinite(record.startedAt.getTime()) &&
    Number.isFinite(scope.readAt.getTime()) &&
    Number.isFinite(scope.retentionStartedAt.getTime()) &&
    record.expiresAt.getTime() > scope.readAt.getTime() &&
    record.startedAt.getTime() >= scope.retentionStartedAt.getTime()
  );
}

export async function runRetainedConversationReplay(
  workspaceId: string,
  conversationId: unknown,
  analytics: QualityAnalyticsAccess,
  dependencies: QualityRetainedReplayDependencies,
): Promise<QualityRetainedReplayResult> {
  const normalizedConversationId = normalizeConversationAnalyticsId(conversationId);
  if (!validIdentifier(workspaceId) || normalizedConversationId === null) {
    throw new QualityConsoleError("invalid-request");
  }
  if (analytics.status !== "enabled") {
    throw new QualityConsoleError(
      analytics.status === "disabled" ? "not-ready" : "unavailable",
    );
  }
  let record: ConversationAnalyticsRecord | null;
  try {
    record = await analytics.store.get(
      workspaceId,
      normalizedConversationId,
      analytics.scope,
    );
  } catch {
    throw new QualityConsoleError("unavailable");
  }
  if (!record) throw new QualityConsoleError("not-found");
  if (
    !validRetainedRecord(
      workspaceId,
      normalizedConversationId,
      record,
      analytics.scope,
    )
  ) {
    throw new QualityConsoleError("unavailable");
  }
  const input = retainedReplayInput(record);
  const evidence = retainedEvidenceSnapshot(workspaceId, record);
  const expectedEvidence = Object.freeze(
    [...evidence].sort(
      (left, right) =>
        right.score - left.score ||
        (left.sourceId < right.sourceId
          ? -1
          : left.sourceId > right.sourceId
            ? 1
            : 0),
    ),
  );
  const timeoutMilliseconds =
    dependencies.timeoutMilliseconds ?? qualityRetainedReplayTimeoutMilliseconds;
  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > qualityRetainedReplayTimeoutMilliseconds
  ) {
    throw new QualityConsoleError("invalid-request");
  }
  const controller = new AbortController();
  let rejectDeadline: (error: QualityConsoleError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline(new QualityConsoleError("unavailable"));
  }, timeoutMilliseconds);
  const withinDeadline = <T>(operation: Promise<T>) =>
    Promise.race([operation, deadline]);
  try {
    const runtime = await withinDeadline(
      dependencies.createAnswerRuntime(evidence),
    );
    let generation = Object.freeze({
      model: runtime.metadata.model,
      provider: runtime.metadata.provider,
    });
    let retrieved: readonly EvidenceRetrievalResult[] = Object.freeze([]);
    let retrievalValid = false;
    let retrievalObserved = false;
    const answerBlocks: string[] = [];
    const citations: Array<Readonly<{ id: string; sourceId: string }>> = [];
    const citationIds = new Set<string>();
    let awaitingCitation = false;
    let finished = false;
    let outcome: QualityRetainedReplayResult["outcome"] | null = null;
    let reason: string | null = null;
    const iterator = runtime.service
      .stream({
        history: input.history,
        maximumOutputTokens: 512,
        observeProvider(metadata) {
          generation = Object.freeze({
            model: metadata.model,
            provider: metadata.provider,
          });
        },
        observeRetrieval(results) {
          if (retrievalObserved) {
            retrievalValid = false;
            return;
          }
          retrievalObserved = true;
          retrieved = Object.freeze([...results]);
          retrievalValid =
            retrieved.length === expectedEvidence.length &&
            retrieved.every((result, index) =>
              sameRetainedEvidence(result, expectedEvidence[index]!),
            );
        },
        question: input.question,
        signal: controller.signal,
        workspaceId,
      })
      [Symbol.asyncIterator]();
    while (true) {
      const next = await withinDeadline(iterator.next());
      if (next.done) break;
      const event: AnswerEvent = next.value;
      if (event.type === "content") {
        if (outcome !== null || finished || !event.markdown) {
          throw new QualityConsoleError("unavailable");
        }
        const answer = [...answerBlocks, event.markdown].join("\n\n");
        if (
          new TextEncoder().encode(answer).byteLength >
          qualityPlaygroundMaximumAnswerUtf8Bytes
        ) {
          throw new QualityConsoleError("unavailable");
        }
        answerBlocks.push(event.markdown);
        awaitingCitation = true;
        continue;
      }
      if (event.type === "citation") {
        if (outcome !== null || finished || !awaitingCitation || !retrievalValid) {
          throw new QualityConsoleError("unavailable");
        }
        const source = citedEvidence(event.citation, retrieved);
        if (!citationIds.has(event.citation.id)) {
          citationIds.add(event.citation.id);
          citations.push(Object.freeze({
            id: event.citation.id,
            sourceId: source.sourceId,
          }));
        }
        awaitingCitation = false;
        continue;
      }
      if (event.type === "abstention") {
        if (
          outcome !== null ||
          finished ||
          answerBlocks.length > 0 ||
          citations.length > 0
        ) {
          throw new QualityConsoleError("unavailable");
        }
        outcome = "abstain";
        reason = event.reason;
        continue;
      }
      if (
        outcome !== null ||
        finished ||
        awaitingCitation ||
        answerBlocks.length === 0 ||
        citations.length === 0 ||
        !retrievalValid
      ) {
        throw new QualityConsoleError("unavailable");
      }
      finished = true;
      outcome = "answer";
    }
    if (
      outcome === null ||
      (outcome === "answer" && !finished) ||
      (outcome === "abstain" && !retrievalValid)
    ) {
      throw new QualityConsoleError("unavailable");
    }
    return Object.freeze({
      answer: outcome === "answer" ? answerBlocks.join("\n\n") : null,
      citations: Object.freeze(citations),
      generation,
      outcome,
      question: input.question,
      reason,
    });
  } catch (error) {
    controller.abort();
    if (error instanceof QualityConsoleError) throw error;
    throw new QualityConsoleError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function evaluateSavedQuestion(
  workspaceId: string,
  question: SavedQuestionSet["questions"][number],
  runtime: AnswerRuntime,
  dependencies: QualityRuntimeDependencies,
  signal: AbortSignal,
  deadline: Promise<never>,
) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const withinDeadline = <T>(operation: Promise<T>) =>
    Promise.race([operation, deadline]);
  const answerBlocks: string[] = [];
  const citations: QualityEvaluationCitation[] = [];
  const claims: QualityEvaluationClaim[] = [];
  const citationIds = new Set<string>();
  let retrieved: readonly EvidenceRetrievalResult[] = Object.freeze([]);
  let observedRetrieval = false;
  let pendingClaims: number[] = [];
  let outcome: QualityQuestionResult["actualOutcome"] | null = null;
  let reason: string | null = null;
  let usage: ReturnType<typeof validUsage> = null;
  let generation: QualityQuestionResult["generation"] = null;
  let firstTokenMilliseconds: number | null = null;
  let finished = false;

  const iterator = runtime.service
    .stream({
      maximumOutputTokens: 512,
      observeProvider(metadata) {
        generation = Object.freeze({
          model: metadata.model,
          provider: metadata.provider,
        });
      },
      observeRetrieval(results) {
        if (observedRetrieval) throw new QualityConsoleError("unavailable");
        observedRetrieval = true;
        retrieved = Object.freeze([...results]);
      },
      question: question.question,
      signal,
      workspaceId,
    })
    [Symbol.asyncIterator]();

  while (true) {
    const next = await withinDeadline(iterator.next());
    if (next.done) break;
    const event: AnswerEvent = next.value;
    if (event.type === "content") {
      if (outcome !== null || finished || !event.markdown) {
        throw new QualityConsoleError("unavailable");
      }
      if (firstTokenMilliseconds === null) {
        firstTokenMilliseconds = elapsedMilliseconds(
          startedAt,
          monotonicNow(),
        );
      }
      pendingClaims.push(answerBlocks.length);
      answerBlocks.push(event.markdown);
      continue;
    }
    if (event.type === "citation") {
      if (outcome !== null || finished || pendingClaims.length === 0) {
        throw new QualityConsoleError("unavailable");
      }
      const evidence = citedEvidence(event.citation, retrieved);
      const accepted = question.acceptedSourceIds.some(
        (sourceId, index) =>
          sourceId === evidence.sourceId &&
          question.sourceContentHashes[index] === evidence.contentHash,
      );
      if (!citationIds.has(event.citation.id)) {
        citationIds.add(event.citation.id);
        citations.push(
          Object.freeze({
            accepted,
            articleContentHash: evidence.articleContentHash,
            articleId: evidence.articleId,
            canonicalUrl: evidence.canonicalUrl,
            contentHash: evidence.contentHash,
            id: event.citation.id,
            provenanceValid: true,
            sourceId: evidence.sourceId,
            title: evidence.title,
          }),
        );
      }
      for (const ordinal of pendingClaims) {
        claims.push(
          Object.freeze({
            citationCovered: true,
            citationId: event.citation.id,
            markdown: answerBlocks[ordinal]!,
            ordinal,
            provenanceValid: true,
            sourceId: evidence.sourceId,
          }),
        );
      }
      pendingClaims = [];
      continue;
    }
    if (event.type === "abstention") {
      if (
        outcome !== null ||
        finished ||
        answerBlocks.length > 0 ||
        citations.length > 0
      ) {
        throw new QualityConsoleError("unavailable");
      }
      outcome = "abstain";
      reason = event.reason;
      usage = validUsage(event.usage);
      if (event.usage !== undefined && (usage === null || generation === null)) {
        throw new QualityConsoleError("unavailable");
      }
      continue;
    }
    if (
      outcome !== null ||
      finished ||
      pendingClaims.length > 0 ||
      answerBlocks.length === 0 ||
      citations.length === 0
    ) {
      throw new QualityConsoleError("unavailable");
    }
    finished = true;
    outcome = "answer";
    usage = validUsage(event.usage);
  }

  if (
    outcome === null ||
    (outcome === "abstain" && generation !== null && usage === null) ||
    (outcome === "answer" &&
      (!finished ||
        firstTokenMilliseconds === null ||
        claims.length !== answerBlocks.length ||
        generation === null))
  ) {
    throw new QualityConsoleError("unavailable");
  }
  const answer = outcome === "answer" ? answerBlocks.join("\n\n") : null;
  if (
    answer !== null &&
    truncateUtf8(answer, qualityEvaluationMaximumAnswerUtf8Bytes) !== answer
  ) {
    throw new QualityConsoleError("unavailable");
  }
  const provenanceValid =
    citations.every(({ provenanceValid }) => provenanceValid) &&
    claims.every(
      ({ citationCovered, provenanceValid }) =>
        citationCovered && provenanceValid,
    );
  const sourceHit = citations.some(({ accepted }) => accepted);
  const selectedGeneration = generation as QualityQuestionResult["generation"];
  const rates = selectedGeneration
    ? dependencies.costRates?.find(
        (rate) =>
          rate.provider === selectedGeneration.provider &&
          rate.model === selectedGeneration.model,
      )
    : undefined;
  const preGenerationAbstention = outcome === "abstain" && generation === null;
  const inputTokens = preGenerationAbstention ? 0 : usage?.inputTokens ?? null;
  const outputTokens = preGenerationAbstention ? 0 : usage?.outputTokens ?? null;
  const totalTokens = preGenerationAbstention ? 0 : usage?.totalTokens ?? null;
  const costMicrodollars =
    preGenerationAbstention
      ? 0
      : estimateConversationCostMicrodollars(
          inputTokens,
          outputTokens,
          rates?.inputMicrodollarsPerMillionTokens,
          rates?.outputMicrodollarsPerMillionTokens,
        );
  return Object.freeze({
    actualOutcome: outcome,
    answer,
    citations: Object.freeze(citations),
    claims: Object.freeze(claims),
    classification: question.classification,
    costMicrodollars,
    durationMilliseconds: elapsedMilliseconds(startedAt, monotonicNow()),
    expectedOutcome: question.expectedOutcome,
    firstTokenMilliseconds,
    generation,
    id: question.id,
    inputTokens,
    manualReview: null,
    outputTokens,
    passed: questionPassed(
      question,
      outcome,
      provenanceValid,
      sourceHit,
    ),
    provenanceValid,
    question: question.question,
    reason,
    sourceHit,
    totalTokens,
    trace: Object.freeze(retrieved.slice(0, 5).map(evaluationSourceTrace)),
  }) satisfies QualityQuestionResult;
}

export async function runSavedQuestionSet(
  workspaceId: string,
  questionSetId: unknown,
  dependencies: QualityRuntimeDependencies,
) {
  if (!validIdentifier(workspaceId) || !validIdentifier(questionSetId)) {
    throw new QualityConsoleError("invalid-request");
  }
  const [questionSet, indexingState] = await Promise.all([
    dependencies.repository.getQuestionSet(workspaceId, questionSetId),
    dependencies.repository.getIndexingState(workspaceId),
  ]);
  if (!questionSet) throw new QualityConsoleError("not-found");
  if (!indexingState) throw new QualityConsoleError("not-ready");
  if (questionSet.questions.length > qualityEvaluationQuestionLimit) {
    throw new QualityConsoleError("too-many-questions");
  }
  const timeoutMilliseconds =
    dependencies.evaluationTimeoutMilliseconds ??
    qualityEvaluationTimeoutMilliseconds;
  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > qualityEvaluationTimeoutMilliseconds
  ) {
    throw new QualityConsoleError("invalid-request");
  }

  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const startedAt = now();
  const id = randomId();
  if (!validIdentifier(id)) throw new QualityConsoleError("unavailable");
  const controller = new AbortController();
  let expired = false;
  let runStarted = false;
  let rejectDeadline: (error: QualityConsoleError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
    rejectDeadline(new QualityConsoleError("unavailable"));
  }, timeoutMilliseconds);
  const withinDeadline = <T>(operation: Promise<T>) =>
    Promise.race([operation, deadline]);
  try {
    const runtime = await withinDeadline(dependencies.createAnswerRuntime());
    await withinDeadline(
      dependencies.repository.startEvaluationRun({
        embeddingGenerationId: indexingState.activeEmbeddingGenerationId,
        id,
        indexGeneration: indexingState.generation,
        model: runtime.metadata.model,
        provider: runtime.metadata.provider,
        questionSetId: questionSet.id,
        retrievalMode: "production-answer-runtime",
        startedAt,
        workspaceId,
      }),
    );
    runStarted = true;
    const questions = new Array<QualityQuestionResult | undefined>(
      questionSet.questions.length,
    ).fill(undefined);
    let nextQuestion = 0;
    const evaluate = async () => {
      while (!expired) {
        const index = nextQuestion;
        nextQuestion += 1;
        const question = questionSet.questions[index];
        if (!question) return;
        questions[index] = await evaluateSavedQuestion(
          workspaceId,
          question,
          runtime,
          dependencies,
          controller.signal,
          deadline,
        );
      }
    };
    await withinDeadline(
      Promise.all(
        Array.from(
          {
            length: Math.min(
              qualityEvaluationConcurrency,
              questionSet.questions.length,
            ),
          },
          evaluate,
        ),
      ),
    );
    const completedQuestions = questions.filter(
      (question): question is QualityQuestionResult => question !== undefined,
    );
    if (completedQuestions.length !== questionSet.questions.length) {
      throw new QualityConsoleError("unavailable");
    }
    const completedIndexingState = await withinDeadline(
      dependencies.repository.getIndexingState(workspaceId),
    );
    if (
      !completedIndexingState ||
      completedIndexingState.generation !== indexingState.generation ||
      completedIndexingState.activeEmbeddingGenerationId !==
        indexingState.activeEmbeddingGenerationId
    ) {
      throw new QualityConsoleError("unavailable");
    }
    const completedAt = now();
    const results = createQualityEvaluationResults(completedQuestions);
    await withinDeadline(
      dependencies.repository.finishEvaluationRun({
        completedAt,
        id,
        results,
        status: "completed",
        workspaceId,
      }),
    );
    return Object.freeze({ id, results });
  } catch (error) {
    controller.abort();
    const failure = normalizeAuthoringError(error);
    if (failure instanceof AuthoringPausedError) throw failure;
    if (runStarted) {
      try {
        await dependencies.repository.finishEvaluationRun({
          completedAt: now(),
          id,
          results: Object.freeze({
            code: "unavailable",
            schema: "opas.quality-evaluation-error.v1",
          }),
          status: "failed",
          workspaceId,
        });
      } catch (completionError) {
        const completionFailure = normalizeAuthoringError(completionError);
        if (completionFailure instanceof AuthoringPausedError) {
          throw completionFailure;
        }
        // The public administrator response remains redacted when persistence also fails.
      }
    }
    throw new QualityConsoleError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function truncateUtf8(value: string, maximumBytes: number) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end)).trimEnd();
}

export async function runQualityPlayground(
  workspaceId: string,
  rawQuestion: unknown,
  dependencies: QualityRuntimeDependencies,
): Promise<QualityPlaygroundResult> {
  if (!validIdentifier(workspaceId)) {
    throw new QualityConsoleError("invalid-request");
  }
  const question = normalizeQualityQuestion(rawQuestion);
  const timeoutMilliseconds =
    dependencies.timeoutMilliseconds ?? qualityPlaygroundTimeoutMilliseconds;
  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > qualityPlaygroundTimeoutMilliseconds
  ) {
    throw new QualityConsoleError("invalid-request");
  }
  const controller = new AbortController();
  let rejectDeadline: (error: QualityConsoleError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline(new QualityConsoleError("unavailable"));
  }, timeoutMilliseconds);
  const withinDeadline = <T>(operation: Promise<T>) =>
    Promise.race([operation, deadline]);
  const retrieve = createEvidenceRetriever(
    createRepositoryEvidenceSource(dependencies.repository),
  );
  let retrieved: readonly EvidenceRetrievalResult[];
  try {
    retrieved = await withinDeadline(
      retrieve({
        mode: "lexical",
        query: question,
        topK: 5,
        workspaceId,
      }),
    );
  } catch {
    controller.abort();
    clearTimeout(timeout);
    throw new QualityConsoleError("unavailable");
  }
  const preflightTrace = Object.freeze(retrieved.map(sourceTrace));
  try {
    const runtime = await withinDeadline(dependencies.createAnswerRuntime());
    let answer = "";
    let outcome: QualityPlaygroundResult["outcome"] = "answer";
    let reason: string | null = null;
    const citations: string[] = [];
    const events = runtime.service.stream({
      maximumOutputTokens: 512,
      question,
      signal: controller.signal,
      workspaceId,
    })[Symbol.asyncIterator]();
    while (true) {
      const next = await withinDeadline(events.next());
      if (next.done) break;
      const event = next.value;
      if (event.type === "content") {
        answer = truncateUtf8(
          `${answer}${event.markdown}`,
          qualityPlaygroundMaximumAnswerUtf8Bytes,
        );
      } else if (event.type === "citation") {
        if (!citations.includes(event.citation.sourceId)) {
          citations.push(event.citation.sourceId);
        }
      } else if (event.type === "abstention") {
        outcome = "abstain";
        reason = event.reason;
      }
    }
    return Object.freeze({
      answer: answer || null,
      citations: Object.freeze(citations.slice(0, 5)),
      generation: Object.freeze({
        model: runtime.metadata.model,
        provider: runtime.metadata.provider,
      }),
      outcome,
      preflightTrace,
      question,
      reason,
    });
  } catch {
    controller.abort();
    return Object.freeze({
      answer: null,
      citations: Object.freeze([]),
      generation: null,
      outcome: "unavailable",
      preflightTrace,
      question,
      reason: "generation-unavailable",
    });
  } finally {
    clearTimeout(timeout);
  }
}
