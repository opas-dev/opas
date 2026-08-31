// ABOUTME: Runs one portable retrieval quality and performance contract across search targets.
// ABOUTME: Reports measured results while preserving explicit not-configured external targets.
import type {
  SavedQuestion,
  SavedQuestionClassification,
} from "@/db/repository";

export type RetrievalEvaluationQuestion = SavedQuestion & {
  queryVector: readonly number[];
};

export type RetrievalEvaluationSource = {
  id: string;
  articleId: string;
  title: string;
  evidenceText: string;
  contentHash: string;
  canonicalUrl: string;
  vector: readonly number[];
};

export type RetrievalEvaluationFixture = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  provenance: "synthetic" | "launch-partner";
  sourceContentHash: string;
  createdAt: Date;
  sources: readonly RetrievalEvaluationSource[];
  questions: readonly RetrievalEvaluationQuestion[];
};

export type RetrievalTargetKind =
  | "lexical"
  | "orama-hybrid"
  | "embedding-provider"
  | "ai-search";

export type RetrievalEvaluationResponse = {
  sourceIds: readonly string[];
  inferenceCostUsd?: number;
};

export type RetrievalEvaluationAdapter = {
  id: string;
  label: string;
  kind: RetrievalTargetKind;
  provider?: string | null;
  model?: string | null;
  costBasis?: string | null;
  prepareSourceEmbeddings?(): Promise<void>;
  rebuild?(): Promise<void>;
  warmup?(): Promise<void>;
  retrieve(request: {
    question: RetrievalEvaluationQuestion;
    topK: 5;
  }): Promise<RetrievalEvaluationResponse>;
};

export type NotConfiguredRetrievalTarget = {
  id: string;
  label: string;
  kind: RetrievalTargetKind;
  status: "not-configured";
  reason: string;
};

export type RetrievalEvaluationTarget =
  | RetrievalEvaluationAdapter
  | NotConfiguredRetrievalTarget;

type Fraction = {
  numerator: number;
  denominator: number;
};

type RetrievalQuestionResult = {
  id: string;
  classification: SavedQuestionClassification;
  acceptedSourceHit: boolean;
  acceptedSourceIds: readonly string[];
  retrievedSourceIds: readonly string[];
  elapsedMs: number;
  inferenceCostUsd: number | null;
};

export type CompletedRetrievalTargetReport = {
  id: string;
  label: string;
  kind: RetrievalTargetKind;
  status: "completed";
  provider: string | null;
  model: string | null;
  costBasis: string | null;
  perClass: Record<SavedQuestionClassification, Fraction>;
  recallAt5: Fraction & { rate: number };
  warmP95Ms: number;
  sourceEmbeddingP95Ms: number | null;
  rebuildP95Ms: number | null;
  peakMemoryBytes: number | null;
  memoryMeasurement: string | null;
  averageEvaluatedInferenceCostUsd: number | null;
  costCoverage: Fraction;
  questions: readonly RetrievalQuestionResult[];
};

export type RetrievalEvaluationReport = {
  fixture: {
    id: string;
    version: number;
    provenance: RetrievalEvaluationFixture["provenance"];
    sourceContentHash: string;
    sourceCount: number;
    questionCount: number;
  };
  targets: readonly (
    | CompletedRetrievalTargetReport
    | NotConfiguredRetrievalTarget
  )[];
};

type RetrievalEvaluationOptions = {
  fixture: RetrievalEvaluationFixture;
  targets: readonly RetrievalEvaluationTarget[];
  sourceEmbeddingSamples?: number;
  rebuildSamples?: number;
  now?: () => number;
  readMemoryBytes?: () => number;
  memoryMeasurement?: string;
};

const classifications: readonly SavedQuestionClassification[] = [
  "answerable",
  "ambiguous",
  "unsupported",
  "stale-conflicting",
  "adversarial",
];
const hashPattern = /^[a-f0-9]{64}$/u;
const maximumRebuildSamples = 100;
const maximumSourceEmbeddingSamples = 100;
const expectedOutcomes = new Set(["answer", "abstain", "either"]);

export class RetrievalEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalEvaluationError";
  }
}

function validateText(value: string, label: string) {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RetrievalEvaluationError(`${label} is invalid`);
  }
}

function validateFixture(fixture: RetrievalEvaluationFixture) {
  validateText(fixture.id, "Evaluation fixture ID");
  validateText(fixture.workspaceId, "Evaluation workspace ID");
  validateText(fixture.name, "Evaluation fixture name");
  if (
    !Number.isInteger(fixture.version) ||
    fixture.version < 1 ||
    !hashPattern.test(fixture.sourceContentHash) ||
    !(fixture.createdAt instanceof Date) ||
    !Number.isFinite(fixture.createdAt.getTime()) ||
    fixture.sources.length === 0 ||
    fixture.questions.length === 0
  ) {
    throw new RetrievalEvaluationError("Evaluation fixture metadata is invalid");
  }
  const sourceIds = new Set<string>();
  const sourceHashes = new Map<string, string>();
  let vectorDimension: number | undefined;
  for (const source of fixture.sources) {
    validateText(source.id, "Evaluation source ID");
    validateText(source.articleId, "Evaluation article ID");
    validateText(source.title, "Evaluation source title");
    validateText(source.evidenceText, "Evaluation source text");
    let canonicalUrl: URL;
    try {
      canonicalUrl = new URL(source.canonicalUrl);
    } catch {
      throw new RetrievalEvaluationError("Evaluation source URL is invalid");
    }
    if (
      sourceIds.has(source.id) ||
      !hashPattern.test(source.contentHash) ||
      source.vector.length === 0 ||
      source.vector.some((value) => !Number.isFinite(value)) ||
      (vectorDimension !== undefined && source.vector.length !== vectorDimension) ||
      (canonicalUrl.protocol !== "http:" && canonicalUrl.protocol !== "https:")
    ) {
      throw new RetrievalEvaluationError("Evaluation source is invalid");
    }
    vectorDimension = source.vector.length;
    sourceIds.add(source.id);
    sourceHashes.set(source.id, source.contentHash);
  }
  const questionIds = new Set<string>();
  for (const question of fixture.questions) {
    validateText(question.id, "Evaluation question ID");
    validateText(question.question, "Evaluation question");
    if (
      questionIds.has(question.id) ||
      !classifications.includes(question.classification) ||
      !expectedOutcomes.has(question.expectedOutcome) ||
      question.queryVector.length !== vectorDimension ||
      question.queryVector.some((value) => !Number.isFinite(value)) ||
      new Set(question.acceptedSourceIds).size !==
        question.acceptedSourceIds.length ||
      question.sourceContentHashes.length !== question.acceptedSourceIds.length ||
      question.acceptedSourceIds.some((sourceId) => !sourceIds.has(sourceId)) ||
      question.sourceContentHashes.some(
        (hash, index) =>
          !hashPattern.test(hash) ||
          sourceHashes.get(question.acceptedSourceIds[index] ?? "") !== hash,
      )
    ) {
      throw new RetrievalEvaluationError("Evaluation question is invalid");
    }
    questionIds.add(question.id);
  }
}

function validateTargets(targets: readonly RetrievalEvaluationTarget[]) {
  const ids = new Set<string>();
  for (const target of targets) {
    validateText(target.id, "Evaluation target ID");
    validateText(target.label, "Evaluation target label");
    if (ids.has(target.id)) {
      throw new RetrievalEvaluationError("Evaluation target IDs must be unique");
    }
    ids.add(target.id);
    if ("status" in target) {
      validateText(target.reason, "Not-configured target reason");
    }
  }
}

function fractionByClass(): Record<SavedQuestionClassification, Fraction> {
  return {
    answerable: { numerator: 0, denominator: 0 },
    ambiguous: { numerator: 0, denominator: 0 },
    unsupported: { numerator: 0, denominator: 0 },
    "stale-conflicting": { numerator: 0, denominator: 0 },
    adversarial: { numerator: 0, denominator: 0 },
  };
}

function percentile95(values: readonly number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function measuredDuration(start: number, end: number) {
  const duration = end - start;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RetrievalEvaluationError("Evaluation clock returned an invalid duration");
  }
  return rounded(duration);
}

function measuredMemory(readMemoryBytes: (() => number) | undefined) {
  if (!readMemoryBytes) {
    return null;
  }
  const value = readMemoryBytes();
  if (!Number.isFinite(value) || value < 0) {
    throw new RetrievalEvaluationError("Evaluation memory reading is invalid");
  }
  return Math.trunc(value);
}

function boundedRebuildSamples(value: number | undefined) {
  const samples = value ?? 20;
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > maximumRebuildSamples
  ) {
    throw new RetrievalEvaluationError("Evaluation rebuild sample count is invalid");
  }
  return samples;
}

function boundedSourceEmbeddingSamples(value: number | undefined) {
  const samples = value ?? 20;
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > maximumSourceEmbeddingSamples
  ) {
    throw new RetrievalEvaluationError(
      "Evaluation source-embedding sample count is invalid",
    );
  }
  return samples;
}

async function evaluateTarget(
  fixture: RetrievalEvaluationFixture,
  adapter: RetrievalEvaluationAdapter,
  sourceEmbeddingSamples: number,
  rebuildSamples: number,
  now: () => number,
  readMemoryBytes: (() => number) | undefined,
  memoryMeasurement: string | undefined,
): Promise<CompletedRetrievalTargetReport> {
  let peakMemoryBytes = measuredMemory(readMemoryBytes);
  const sampleMemory = () => {
    const current = measuredMemory(readMemoryBytes);
    if (current !== null) {
      peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, current);
    }
  };
  const sourceEmbeddingDurations: number[] = [];
  if (adapter.prepareSourceEmbeddings) {
    for (let index = 0; index < sourceEmbeddingSamples; index += 1) {
      const startedAt = now();
      await adapter.prepareSourceEmbeddings();
      sourceEmbeddingDurations.push(measuredDuration(startedAt, now()));
      sampleMemory();
    }
  }
  const rebuildDurations: number[] = [];
  if (adapter.rebuild) {
    for (let index = 0; index < rebuildSamples; index += 1) {
      const startedAt = now();
      await adapter.rebuild();
      rebuildDurations.push(measuredDuration(startedAt, now()));
      sampleMemory();
    }
  } else if (adapter.warmup) {
    await adapter.warmup();
    sampleMemory();
  }

  const perClass = fractionByClass();
  const questions: RetrievalQuestionResult[] = [];
  const retrievalDurations: number[] = [];
  let recallNumerator = 0;
  let recallDenominator = 0;
  let totalInferenceCostUsd = 0;
  let costSamples = 0;
  for (const question of fixture.questions) {
    const startedAt = now();
    const response = await adapter.retrieve({ question, topK: 5 });
    const elapsedMs = measuredDuration(startedAt, now());
    retrievalDurations.push(elapsedMs);
    sampleMemory();
    const sourceIds = [...new Set(response.sourceIds)].slice(0, 5);
    if (sourceIds.some((sourceId) => typeof sourceId !== "string" || !sourceId)) {
      throw new RetrievalEvaluationError("Evaluation returned an invalid source ID");
    }
    const acceptedSourceIds = new Set(question.acceptedSourceIds);
    const acceptedSourceHit = sourceIds.some((sourceId) =>
      acceptedSourceIds.has(sourceId),
    );
    const classResult = perClass[question.classification];
    classResult.denominator += 1;
    if (acceptedSourceHit) {
      classResult.numerator += 1;
    }
    if (question.classification === "answerable") {
      recallDenominator += 1;
      if (acceptedSourceHit) {
        recallNumerator += 1;
      }
    }
    if (response.inferenceCostUsd !== undefined) {
      if (
        !Number.isFinite(response.inferenceCostUsd) ||
        response.inferenceCostUsd < 0
      ) {
        throw new RetrievalEvaluationError("Evaluation inference cost is invalid");
      }
      totalInferenceCostUsd += response.inferenceCostUsd;
      costSamples += 1;
    }
    questions.push({
      id: question.id,
      classification: question.classification,
      acceptedSourceHit,
      acceptedSourceIds: [...question.acceptedSourceIds],
      retrievedSourceIds: sourceIds,
      elapsedMs,
      inferenceCostUsd: response.inferenceCostUsd ?? null,
    });
  }

  return {
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind,
    status: "completed",
    provider: adapter.provider ?? null,
    model: adapter.model ?? null,
    costBasis: adapter.costBasis ?? null,
    perClass,
    recallAt5: {
      numerator: recallNumerator,
      denominator: recallDenominator,
      rate:
        recallDenominator === 0
          ? 0
          : rounded(recallNumerator / recallDenominator),
    },
    warmP95Ms: percentile95(retrievalDurations) ?? 0,
    sourceEmbeddingP95Ms: percentile95(sourceEmbeddingDurations),
    rebuildP95Ms: percentile95(rebuildDurations),
    peakMemoryBytes,
    memoryMeasurement: readMemoryBytes
      ? (memoryMeasurement ?? "runtime-supplied bytes")
      : null,
    averageEvaluatedInferenceCostUsd:
      costSamples === 0 ? null : rounded(totalInferenceCostUsd / costSamples),
    costCoverage: {
      numerator: costSamples,
      denominator: fixture.questions.length,
    },
    questions,
  };
}

export function notConfiguredRetrievalTarget({
  id,
  label,
  kind,
  reason,
}: Omit<NotConfiguredRetrievalTarget, "status">): NotConfiguredRetrievalTarget {
  return { id, label, kind, status: "not-configured", reason };
}

export async function runRetrievalEvaluation({
  fixture,
  targets,
  sourceEmbeddingSamples: requestedSourceEmbeddingSamples,
  rebuildSamples: requestedRebuildSamples,
  now = () => performance.now(),
  readMemoryBytes,
  memoryMeasurement,
}: RetrievalEvaluationOptions): Promise<RetrievalEvaluationReport> {
  validateFixture(fixture);
  validateTargets(targets);
  const sourceEmbeddingSamples = boundedSourceEmbeddingSamples(
    requestedSourceEmbeddingSamples,
  );
  const rebuildSamples = boundedRebuildSamples(requestedRebuildSamples);
  const reports: RetrievalEvaluationReport["targets"][number][] = [];
  for (const target of targets) {
    if ("status" in target) {
      reports.push({ ...target });
      continue;
    }
    reports.push(
      await evaluateTarget(
        fixture,
        target,
        sourceEmbeddingSamples,
        rebuildSamples,
        now,
        readMemoryBytes,
        memoryMeasurement,
      ),
    );
  }

  return {
    fixture: {
      id: fixture.id,
      version: fixture.version,
      provenance: fixture.provenance,
      sourceContentHash: fixture.sourceContentHash,
      sourceCount: fixture.sources.length,
      questionCount: fixture.questions.length,
    },
    targets: reports,
  };
}
