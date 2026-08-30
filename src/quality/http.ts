// ABOUTME: Enforces authenticated same-origin HTTP boundaries for administrator quality operations.
// ABOUTME: Parses bounded inputs and returns only safe run, playground, and CSV responses.
import {
  qualityCsvAttachmentHeaders,
  type QualityEvaluationResults,
} from "@/quality/console";
import type {
  QualityPlaygroundResult,
  QualityRetainedReplayResult,
} from "@/quality/runtime";
import { QualityConsoleError } from "@/quality/runtime";
import { QuestionSetImportError } from "@/quality/question-set-import";
import { QualityReviewImportError } from "@/quality/review-import";

export const maximumQualityRequestUtf8Bytes = 4_096;
export const maximumQuestionSetImportUtf8Bytes = 256 * 1_024;

type Allowance =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterSeconds: number }>;

type QualityHttpDependencies = Readonly<{
  authorize: () => Promise<unknown>;
  consumeAllowance?: (request: Request) => Promise<Allowance>;
}>;

export type QualityRunHttpDependencies = QualityHttpDependencies &
  Readonly<{
    run: (questionSetId: string) => Promise<{
      id: string;
      results: QualityEvaluationResults;
    }>;
  }>;

export type QualityPlaygroundHttpDependencies = QualityHttpDependencies &
  Readonly<{
    run: (question: string) => Promise<QualityPlaygroundResult>;
  }>;

export type QualityReplayHttpDependencies = QualityHttpDependencies &
  Readonly<{
    run: (conversationId: string) => Promise<QualityRetainedReplayResult>;
  }>;

export type QuestionSetImportHttpDependencies = QualityHttpDependencies &
  Readonly<{
    importQuestionSet: (value: unknown) => Promise<{
      id: string;
      name: string;
      questionCount: number;
      version: number;
    }>;
  }>;

export type QualityReviewHttpDependencies = QualityHttpDependencies &
  Readonly<{
    importReview: (value: unknown) => Promise<{
      questionCount: number;
      runId: string;
    }>;
  }>;

export type QualityExportHttpDependencies = Readonly<{
  authorize: () => Promise<unknown>;
  exportCsv: (kind: "conversations" | "evaluations") => Promise<string>;
}>;

const securityHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

class QualityRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("invalid-request");
    this.name = "QualityRequestError";
    this.status = status;
  }
}

function json(value: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(value, {
    headers: { ...securityHeaders, ...headers },
    status,
  });
}

function strictJson(value: string | null) {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  try {
    if (origin === null || host === null) return false;
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin || parsedOrigin.host !== host) return false;

    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    const protocol = forwardedProtocol ?? new URL(request.url).protocol.slice(0, -1);
    return (
      (protocol === "http" || protocol === "https") &&
      parsedOrigin.protocol === `${protocol}:`
    );
  } catch {
    return false;
  }
}

async function boundedText(
  request: Request,
  maximumUtf8Bytes = maximumQualityRequestUtf8Bytes,
) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new QualityRequestError(400);
    if (Number(declared) > maximumUtf8Bytes) {
      throw new QualityRequestError(413);
    }
  }
  if (!request.body) throw new QualityRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumUtf8Bytes) {
        throw new QualityRequestError(413);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The bounded request body is already isolated from the public response.
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QualityRequestError(400);
  }
}

async function objectBody(
  request: Request,
  maximumUtf8Bytes = maximumQualityRequestUtf8Bytes,
) {
  if (!strictJson(request.headers.get("content-type"))) {
    throw new QualityRequestError(415);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await boundedText(request, maximumUtf8Bytes));
  } catch (error) {
    if (error instanceof QualityRequestError) throw error;
    throw new QualityRequestError(400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QualityRequestError(400);
  }
  return parsed as Record<string, unknown>;
}

async function authorizedMutation(
  request: Request,
  dependencies: QualityHttpDependencies,
) {
  if (request.method !== "POST") throw new QualityRequestError(405);
  if (!sameOrigin(request)) throw new QualityRequestError(403);
  if (dependencies.consumeAllowance) {
    const allowance = await dependencies.consumeAllowance(request);
    if (!allowance.accepted) {
      return json(
        { error: "unavailable" },
        429,
        { "Retry-After": String(allowance.retryAfterSeconds) },
      );
    }
  }
  return null;
}

function safeFailure(error: unknown) {
  if (error instanceof QualityRequestError) {
    return json(
      { error: error.status === 405 ? "method-not-allowed" : "invalid-request" },
      error.status,
      error.status === 405 ? { Allow: "POST" } : undefined,
    );
  }
  if (error instanceof QualityConsoleError) {
    if (error.code === "invalid-request") return json({ error: "invalid-request" }, 400);
    if (error.code === "not-found") return json({ error: "not-found" }, 404);
    if (error.code === "not-ready") return json({ error: "not-ready" }, 409);
    if (error.code === "too-many-questions") {
      return json({ error: "too-many-questions" }, 422);
    }
  }
  if (error instanceof QuestionSetImportError) {
    if (error.code === "already-exists") {
      return json({ error: "already-exists" }, 409);
    }
    if (error.code === "source-mismatch") {
      return json({ error: "source-mismatch" }, 422);
    }
    return json({ error: "invalid-request" }, 400);
  }
  if (error instanceof QualityReviewImportError) {
    if (error.code === "not-found") return json({ error: "not-found" }, 404);
    if (error.code === "not-ready") return json({ error: "not-ready" }, 409);
    return json({ error: "invalid-request" }, 400);
  }
  return json({ error: "unavailable" }, 503);
}

export async function handleQualityRunRequest(
  request: Request,
  dependencies: QualityRunHttpDependencies,
) {
  await dependencies.authorize();
  try {
    const rejection = await authorizedMutation(request, dependencies);
    if (rejection) return rejection;
    const body = await objectBody(request);
    if (
      Object.keys(body).length !== 1 ||
      typeof body.questionSetId !== "string"
    ) {
      throw new QualityRequestError(400);
    }
    const run = await dependencies.run(body.questionSetId);
    return json({ runId: run.id }, 201);
  } catch (error) {
    return safeFailure(error);
  }
}

export async function handleQualityPlaygroundRequest(
  request: Request,
  dependencies: QualityPlaygroundHttpDependencies,
) {
  await dependencies.authorize();
  try {
    const rejection = await authorizedMutation(request, dependencies);
    if (rejection) return rejection;
    const body = await objectBody(request);
    if (Object.keys(body).length !== 1 || typeof body.question !== "string") {
      throw new QualityRequestError(400);
    }
    return json({ result: await dependencies.run(body.question) });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function handleQualityReplayRequest(
  request: Request,
  dependencies: QualityReplayHttpDependencies,
) {
  await dependencies.authorize();
  try {
    const rejection = await authorizedMutation(request, dependencies);
    if (rejection) return rejection;
    const body = await objectBody(request);
    if (
      Object.keys(body).length !== 1 ||
      typeof body.conversationId !== "string"
    ) {
      throw new QualityRequestError(400);
    }
    return json({ result: await dependencies.run(body.conversationId) });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function handleQuestionSetImportRequest(
  request: Request,
  dependencies: QuestionSetImportHttpDependencies,
) {
  await dependencies.authorize();
  try {
    const rejection = await authorizedMutation(request, dependencies);
    if (rejection) return rejection;
    const body = await objectBody(request, maximumQuestionSetImportUtf8Bytes);
    return json(
      { questionSet: await dependencies.importQuestionSet(body) },
      201,
    );
  } catch (error) {
    return safeFailure(error);
  }
}

export async function handleQualityReviewRequest(
  request: Request,
  dependencies: QualityReviewHttpDependencies,
) {
  await dependencies.authorize();
  try {
    const rejection = await authorizedMutation(request, dependencies);
    if (rejection) return rejection;
    const body = await objectBody(request, maximumQuestionSetImportUtf8Bytes);
    const review = await dependencies.importReview(body);
    return json(
      {
        review: {
          questionCount: review.questionCount,
          runId: review.runId,
        },
      },
      200,
    );
  } catch (error) {
    return safeFailure(error);
  }
}

export async function handleQualityExportRequest(
  request: Request,
  dependencies: QualityExportHttpDependencies,
) {
  await dependencies.authorize();
  if (request.method !== "GET") {
    return json({ error: "method-not-allowed" }, 405, { Allow: "GET" });
  }
  const parameters = new URL(request.url).searchParams;
  const kind = parameters.get("kind");
  if (
    [...parameters.keys()].some((key) => key !== "kind") ||
    parameters.getAll("kind").length !== 1 ||
    (kind !== "conversations" && kind !== "evaluations")
  ) {
    return json({ error: "invalid-request" }, 400);
  }
  try {
    const body = await dependencies.exportCsv(kind);
    return new Response(body, {
      headers: {
        ...qualityCsvAttachmentHeaders(
          kind === "conversations"
            ? "opas-redacted-conversations.csv"
            : "opas-evaluation-runs.csv",
        ),
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      },
      status: 200,
    });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
