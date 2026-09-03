// ABOUTME: Applies strict human answer and claim scores to completed saved evaluations.
// ABOUTME: Recomputes every aggregate before replacing the active-workspace result document.
import type { Repository } from "@/db/repository";
import type { MemberActor } from "@/auth/member-repository";
import {
  createQualityEvaluationResults,
  parseQualityEvaluationResults,
  qualityEvaluationQuestionLimit,
  qualityReviewImportSchema,
  type QualityManualClaimReview,
  type QualityQuestionResult,
} from "@/quality/console";

type QualityReviewRepository = Pick<
  Repository,
  "getEvaluationRun" | "updateAuthorizedEvaluationRunResults"
>;

type ReviewQuestion = Readonly<{
  claims: readonly QualityManualClaimReview[];
  grounded: boolean;
  id: string;
  materiallyCorrect: boolean;
}>;

export class QualityReviewImportError extends Error {
  readonly code: "invalid-request" | "not-found" | "not-ready";

  constructor(code: QualityReviewImportError["code"]) {
    super(code);
    this.name = "QualityReviewImportError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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

function reviewQuestion(value: unknown): ReviewQuestion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "claims",
      "grounded",
      "id",
      "materiallyCorrect",
    ]) ||
    !validIdentifier(value.id) ||
    typeof value.grounded !== "boolean" ||
    typeof value.materiallyCorrect !== "boolean" ||
    !Array.isArray(value.claims) ||
    value.claims.length > 64
  ) {
    throw new QualityReviewImportError("invalid-request");
  }
  const claims = value.claims.map((claim) => {
    if (
      !isRecord(claim) ||
      !hasExactKeys(claim, ["citationCovered", "entailed", "ordinal"]) ||
      !Number.isSafeInteger(claim.ordinal) ||
      (claim.ordinal as number) < 0 ||
      typeof claim.entailed !== "boolean" ||
      typeof claim.citationCovered !== "boolean"
    ) {
      throw new QualityReviewImportError("invalid-request");
    }
    return Object.freeze({
      citationCovered: claim.citationCovered,
      entailed: claim.entailed,
      ordinal: claim.ordinal as number,
    });
  });
  return Object.freeze({
    claims: Object.freeze(claims),
    grounded: value.grounded,
    id: value.id,
    materiallyCorrect: value.materiallyCorrect,
  });
}

function reviewPayload(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["questions", "runId", "schema"]) ||
    value.schema !== qualityReviewImportSchema ||
    !validIdentifier(value.runId) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > qualityEvaluationQuestionLimit
  ) {
    throw new QualityReviewImportError("invalid-request");
  }
  const questions = value.questions.map(reviewQuestion);
  if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
    throw new QualityReviewImportError("invalid-request");
  }
  return Object.freeze({
    questions: Object.freeze(questions),
    runId: value.runId,
  });
}

function reviewedQuestion(
  question: QualityQuestionResult,
  review: ReviewQuestion,
  reviewedAt: string,
) {
  if (
    question.actualOutcome !== "answer" ||
    review.claims.length !== question.claims.length ||
    review.claims.some(
      (claim, index) => claim.ordinal !== question.claims[index]?.ordinal,
    )
  ) {
    throw new QualityReviewImportError("invalid-request");
  }
  return Object.freeze({
    ...question,
    manualReview: Object.freeze({
      claims: review.claims,
      grounded: review.grounded,
      materiallyCorrect: review.materiallyCorrect,
      reviewedAt,
    }),
  });
}

export async function importQualityReview(
  workspaceId: string,
  value: unknown,
  repository: QualityReviewRepository,
  actor: MemberActor,
  now = () => new Date(),
) {
  if (!validIdentifier(workspaceId)) {
    throw new QualityReviewImportError("invalid-request");
  }
  const payload = reviewPayload(value);
  const reviewedAtDate = now();
  if (
    !(reviewedAtDate instanceof Date) ||
    !Number.isFinite(reviewedAtDate.getTime())
  ) {
    throw new QualityReviewImportError("invalid-request");
  }
  const run = await repository.getEvaluationRun(workspaceId, payload.runId);
  if (!run) throw new QualityReviewImportError("not-found");
  if (run.status !== "completed") {
    throw new QualityReviewImportError("not-ready");
  }
  const current = parseQualityEvaluationResults(run.results);
  if (!current) throw new QualityReviewImportError("not-ready");
  const reviewById = new Map(
    payload.questions.map((question) => [question.id, question]),
  );
  for (const id of reviewById.keys()) {
    if (!current.questions.some((question) => question.id === id)) {
      throw new QualityReviewImportError("invalid-request");
    }
  }
  const reviewedAt = reviewedAtDate.toISOString();
  const results = createQualityEvaluationResults(
    current.questions.map((question) => {
      const review = reviewById.get(question.id);
      return review ? reviewedQuestion(question, review, reviewedAt) : question;
    }),
  );
  await repository.updateAuthorizedEvaluationRunResults(
    { ...actor, checkedAt: reviewedAtDate },
    {
      id: run.id,
      results,
      workspaceId,
    },
  );
  return Object.freeze({
    questionCount: payload.questions.length,
    results,
    runId: run.id,
  });
}
