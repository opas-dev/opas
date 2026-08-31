// ABOUTME: Implements the bounded POST and streaming response boundary for native answers.
// ABOUTME: Emits complete validated NDJSON records and reduces failures to safe public codes.
import { GenerationError } from "@/ai/generation";
import {
  AnswerError,
  type AnswerEvent,
  type AnswerHistoryMessage,
} from "@/answers/answer";
import {
  createConfiguredAnswerRuntime,
  type AnswerRuntime,
} from "@/answers/answer-runtime";
import {
  consumeAnswerRequestAllowance,
  type AnswerRequestAllowance,
} from "@/answers/gate";
import {
  resolvePublishedArticlePath,
  type PublishedPageCandidate,
} from "@/content/page-context";
import { demoIds } from "@/db/demo";
import {
  createAnswerOutcomeRecorder,
  type AnswerOutcomeRecorder,
} from "@/outcomes/answer-recorder";
import { normalizeConversationAnalyticsId } from "@/outcomes/records";

export const maximumAnswerRequestUtf8Bytes = 16_384;

export type AnswerStreamRecord =
  | AnswerEvent
  | Readonly<{
      conversationId: string;
      generation: AnswerRuntime["metadata"];
      type: "metadata";
    }>
  | Readonly<{
      code: "cancelled" | "invalid-answer" | "unavailable";
      type: "error";
    }>;

export type AnswerRouteDependencies = {
  consumeAllowance?: (request: Request) => Promise<AnswerRequestAllowance>;
  createConversationId?: () => string;
  createRecorder?: typeof createAnswerOutcomeRecorder;
  createRuntime?: () => Promise<AnswerRuntime>;
  loadPublications?: () => Promise<readonly PublishedPageCandidate[]>;
  now?: () => Date;
};

type ParsedAnswerRequest = {
  currentPagePath?: string;
  history?: readonly AnswerHistoryMessage[];
  maximumOutputTokens?: number;
  question: string;
};

type RequestFailureCode =
  | "cancelled"
  | "invalid-request"
  | "payload-too-large"
  | "unsupported-media-type";

class RequestFailure extends Error {
  readonly code: RequestFailureCode;
  readonly status: number;

  constructor(code: RequestFailureCode, status: number) {
    super(code);
    this.name = "RequestFailure";
    this.code = code;
    this.status = status;
  }
}

const encoder = new TextEncoder();
const responseSecurityHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

async function loadCurrentPublications() {
  const { loadPublicationContent } = await import("@/content/publication-data");
  return (await loadPublicationContent()).publications;
}

function jsonResponse(
  error: string,
  status: number,
  headers?: Record<string, string>,
) {
  return Response.json(
    { error },
    {
      status,
      headers: { ...responseSecurityHeaders, ...headers },
    },
  );
}

function strictJsonContentType(value: string | null) {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

function declaredBodySize(value: string | null) {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) {
    throw new RequestFailure("invalid-request", 400);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new RequestFailure("payload-too-large", 413);
  }
  return size;
}

function cancelledRequest(signal: AbortSignal) {
  if (signal.aborted) throw new RequestFailure("cancelled", 499);
}

async function boundedRequestText(request: Request) {
  const declaredSize = declaredBodySize(request.headers.get("content-length"));
  if (declaredSize !== null && declaredSize > maximumAnswerRequestUtf8Bytes) {
    throw new RequestFailure("payload-too-large", 413);
  }
  if (!request.body) throw new RequestFailure("invalid-request", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      cancelledRequest(request.signal);
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new RequestFailure("invalid-request", 400);
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumAnswerRequestUtf8Bytes) {
        throw new RequestFailure("payload-too-large", 413);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Releasing a consumed or disconnected request body is best effort.
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestFailure("invalid-request", 400);
  }
}

function parsedAnswerRequest(text: string): ParsedAnswerRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestFailure("invalid-request", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestFailure("invalid-request", 400);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "currentPagePath",
    "history",
    "maximumOutputTokens",
    "question",
  ]);
  if (
    !("question" in record) ||
    Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    throw new RequestFailure("invalid-request", 400);
  }
  return record as ParsedAnswerRequest;
}

async function requestInput(request: Request) {
  if (!strictJsonContentType(request.headers.get("content-type"))) {
    throw new RequestFailure("unsupported-media-type", 415);
  }
  return parsedAnswerRequest(await boundedRequestText(request));
}

function linkedSignal(source: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return {
    abort,
    close() {
      source.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

function preStreamFailure(error: unknown) {
  if (error instanceof RequestFailure) {
    return jsonResponse(error.code, error.status);
  }
  if (error instanceof AnswerError) {
    if (error.category === "invalid-input") {
      return jsonResponse("invalid-request", 400);
    }
    if (error.category === "cancelled") {
      return jsonResponse("cancelled", 499);
    }
    if (error.category === "configuration") {
      return jsonResponse("unavailable", 503);
    }
    return jsonResponse("invalid-answer", 502);
  }
  if (error instanceof GenerationError) {
    if (error.category === "cancelled") {
      return jsonResponse("cancelled", 499);
    }
    if (error.category === "invalid-response" || error.category === "output-limit") {
      return jsonResponse("invalid-answer", 502);
    }
    if (error.category === "timeout") {
      return jsonResponse("unavailable", 504);
    }
  }
  return jsonResponse("unavailable", 503);
}

function failureWasCancelled(error: unknown) {
  return (
    (error instanceof RequestFailure && error.code === "cancelled") ||
    (error instanceof AnswerError && error.category === "cancelled") ||
    (error instanceof GenerationError && error.category === "cancelled")
  );
}

function streamFailureCode(error: unknown): AnswerStreamRecord & { type: "error" } {
  if (failureWasCancelled(error)) {
    return Object.freeze({ code: "cancelled", type: "error" });
  }
  if (
    (error instanceof AnswerError && error.category !== "configuration") ||
    (error instanceof GenerationError &&
      (error.category === "invalid-response" || error.category === "output-limit"))
  ) {
    return Object.freeze({ code: "invalid-answer", type: "error" });
  }
  return Object.freeze({ code: "unavailable", type: "error" });
}

function encodedRecord(record: AnswerStreamRecord) {
  return encoder.encode(`${JSON.stringify(record)}\n`);
}

async function closeIterator(iterator: AsyncIterator<AnswerEvent>) {
  try {
    await iterator.return?.();
  } catch {
    // The response boundary has already reduced the failure to a public code.
  }
}

function streamingResponse(
  conversationId: string,
  runtime: AnswerRuntime,
  iterator: AsyncIterator<AnswerEvent>,
  recorder: AnswerOutcomeRecorder,
  signal: ReturnType<typeof linkedSignal>,
) {
  let closed = false;
  let observedEvent = false;

  const close = () => {
    if (closed) return;
    closed = true;
    signal.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encodedRecord(
          Object.freeze({
            conversationId,
            generation: runtime.metadata,
            type: "metadata",
          }),
        ),
      );
    },
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          if (!observedEvent) {
            throw new AnswerError(
              "invalid-output",
              "Answer stream ended without a public result",
            );
          }
          close();
          controller.close();
          return;
        }
        observedEvent = true;
        await recorder.observeEvent(result.value);
        controller.enqueue(encodedRecord(result.value));
      } catch (error) {
        if (closed) return;
        const failure = signal.signal.aborted
          ? Object.freeze({ code: "cancelled" as const, type: "error" as const })
          : streamFailureCode(error);
        await recorder.abandon(
          failure.code === "cancelled" ? "cancelled" : "stream-failed",
        );
        controller.enqueue(encodedRecord(failure));
        close();
        controller.close();
        await closeIterator(iterator);
      }
    },
    async cancel() {
      signal.abort();
      close();
      await recorder.abandon("cancelled");
      await closeIterator(iterator);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...responseSecurityHeaders,
      "Content-Encoding": "identity",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function handleAnswerRequest(
  request: Request,
  dependencies: AnswerRouteDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const requestStartedAt = now();
  if (request.method !== "POST") {
    return jsonResponse("method-not-allowed", 405, { Allow: "POST" });
  }

  let input: ParsedAnswerRequest;
  try {
    input = await requestInput(request);
  } catch (error) {
    return preStreamFailure(error);
  }

  let allowance: AnswerRequestAllowance;
  try {
    allowance = await (
      dependencies.consumeAllowance ?? consumeAnswerRequestAllowance
    )(request);
  } catch {
    return jsonResponse("unavailable", 503);
  }
  if (!allowance.accepted) {
    return jsonResponse("unavailable", 429, {
      "Retry-After": String(allowance.retryAfterSeconds),
    });
  }

  const answerSignal = linkedSignal(request.signal);
  let iterator: AsyncIterator<AnswerEvent> | undefined;
  let recorder: AnswerOutcomeRecorder | undefined;
  try {
    cancelledRequest(answerSignal.signal);
    const { currentPagePath, ...answerInput } = input;
    const currentPage =
      currentPagePath === undefined
        ? undefined
        : resolvePublishedArticlePath(
            currentPagePath,
            await (
              dependencies.loadPublications ??
              loadCurrentPublications
            )(),
          );
    if (currentPagePath !== undefined && currentPage === null) {
      throw new RequestFailure("invalid-request", 400);
    }
    cancelledRequest(answerSignal.signal);
    const runtime = await (
      dependencies.createRuntime ?? createConfiguredAnswerRuntime
    )();
    cancelledRequest(answerSignal.signal);
    const conversationId = (
      dependencies.createConversationId ?? (() => crypto.randomUUID())
    )();
    if (!normalizeConversationAnalyticsId(conversationId)) {
      throw new Error("Conversation analytics identifier generation failed");
    }
    recorder = (dependencies.createRecorder ?? createAnswerOutcomeRecorder)({
      history: answerInput.history,
      id: conversationId,
      model: runtime.metadata.model,
      now,
      provider: runtime.metadata.provider,
      question: answerInput.question,
      startedAt: requestStartedAt,
      workspaceId: demoIds.workspace,
    });
    const serviceRequest = {
      ...answerInput,
      ...(currentPage ? { currentPage } : {}),
      observeProvider: recorder.observeProvider,
      observeRetrieval: recorder.observeRetrieval,
      signal: answerSignal.signal,
      workspaceId: demoIds.workspace,
    };
    runtime.service.validate(serviceRequest);
    iterator = runtime.service.stream(serviceRequest)[Symbol.asyncIterator]();
    await recorder.start();
    cancelledRequest(answerSignal.signal);
    return streamingResponse(
      conversationId,
      runtime,
      iterator,
      recorder,
      answerSignal,
    );
  } catch (error) {
    answerSignal.close();
    if (iterator) await closeIterator(iterator);
    await recorder?.abandon(
      answerSignal.signal.aborted || failureWasCancelled(error)
        ? "cancelled"
        : "request-failed",
    );
    return preStreamFailure(error);
  }
}
