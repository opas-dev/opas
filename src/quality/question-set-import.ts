// ABOUTME: Validates administrator question-set fixtures against active published evidence.
// ABOUTME: Injects the active workspace before atomically storing one bounded versioned set.
import { validateQuestionSet } from "@/db/evidence";
import type { MemberActor } from "@/auth/member-repository";
import type {
  Repository,
  SavedQuestion,
  SavedQuestionSet,
} from "@/db/repository";
import { qualityEvaluationQuestionLimit } from "@/quality/console";

export const savedQuestionSetImportSchema = "opas.saved-question-set.v1";

type QuestionSetImportRepository = Pick<
  Repository,
  "getQuestionSet" | "listEvidenceChunks" | "saveAuthorizedQuestionSet"
>;

export class QuestionSetImportError extends Error {
  readonly code: "already-exists" | "invalid-request" | "source-mismatch";

  constructor(code: QuestionSetImportError["code"]) {
    super(code);
    this.name = "QuestionSetImportError";
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

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new QuestionSetImportError("invalid-request");
  }
  return Object.freeze([...value]) as readonly string[];
}

function question(value: unknown): SavedQuestion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "acceptedSourceIds",
      "classification",
      "expectedOutcome",
      "id",
      "question",
      "sourceContentHashes",
    ]) ||
    typeof value.id !== "string" ||
    typeof value.classification !== "string" ||
    typeof value.question !== "string" ||
    typeof value.expectedOutcome !== "string"
  ) {
    throw new QuestionSetImportError("invalid-request");
  }
  return Object.freeze({
    acceptedSourceIds: stringArray(value.acceptedSourceIds),
    classification: value.classification,
    expectedOutcome: value.expectedOutcome,
    id: value.id,
    question: value.question,
    sourceContentHashes: stringArray(value.sourceContentHashes),
  }) as SavedQuestion;
}

function parseQuestionSet(
  workspaceId: string,
  value: unknown,
  createdAt: Date,
): SavedQuestionSet {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "name",
      "questions",
      "schema",
      "sourceContentHash",
      "version",
    ]) ||
    value.schema !== savedQuestionSetImportSchema ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.version) ||
    typeof value.sourceContentHash !== "string" ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > qualityEvaluationQuestionLimit
  ) {
    throw new QuestionSetImportError("invalid-request");
  }
  const questionSet = Object.freeze({
    createdAt,
    id: value.id,
    name: value.name,
    questions: Object.freeze(value.questions.map(question)),
    sourceContentHash: value.sourceContentHash,
    version: value.version as number,
    workspaceId,
  }) satisfies SavedQuestionSet;
  try {
    validateQuestionSet(questionSet);
  } catch {
    throw new QuestionSetImportError("invalid-request");
  }
  return questionSet;
}

export async function importSavedQuestionSet(
  workspaceId: string,
  value: unknown,
  repository: QuestionSetImportRepository,
  actor: MemberActor,
  now = () => new Date(),
) {
  const questionSet = parseQuestionSet(workspaceId, value, now());
  const [existing, evidence] = await Promise.all([
    repository.getQuestionSet(workspaceId, questionSet.id),
    repository.listEvidenceChunks(workspaceId),
  ]);
  if (existing) throw new QuestionSetImportError("already-exists");

  const sources = new Map(
    evidence
      .filter((source) => source.workspaceId === workspaceId)
      .map((source) => [source.id, source.contentHash]),
  );
  for (const savedQuestion of questionSet.questions) {
    for (const [index, sourceId] of savedQuestion.acceptedSourceIds.entries()) {
      if (sources.get(sourceId) !== savedQuestion.sourceContentHashes[index]) {
        throw new QuestionSetImportError("source-mismatch");
      }
    }
  }

  await repository.saveAuthorizedQuestionSet(
    { ...actor, checkedAt: questionSet.createdAt },
    questionSet,
  );
  return Object.freeze({
    id: questionSet.id,
    name: questionSet.name,
    questionCount: questionSet.questions.length,
    version: questionSet.version,
  });
}
