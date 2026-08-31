// ABOUTME: Validates and consumes the browser-facing NDJSON answer stream.
// ABOUTME: Keeps page context, follow-up history, citations, and failure recovery bounded.
import { validateAnswerMarkdown } from "@/app/answer-markdown";

const maximumStreamUtf8Bytes = 131_072;
const maximumRecordUtf8Bytes = 16_384;
const maximumHistoryMessages = 8;
const maximumHistoryUtf8Bytes = 8_192;
const maximumHistoryAnswerUtf8Bytes = 1_024;
const maximumQuestionCodePoints = 200;
const maximumIdentifierCodePoints = 200;
const maximumTitleUtf8Bytes = 1_000;
const maximumCanonicalUrlUtf8Bytes = 2_048;
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const directionalControls = /[\u202a-\u202e\u2066-\u2069]/u;
const articlePathPattern =
  /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const hashPattern = /^[a-f\d]{64}$/u;
const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AnswerFailureCode =
  | "cancelled"
  | "disconnected"
  | "invalid-response"
  | "unavailable";

export class AnswerStreamError extends Error {
  readonly code: AnswerFailureCode;

  constructor(code: AnswerFailureCode) {
    super(code);
    this.name = "AnswerStreamError";
    this.code = code;
  }
}

export type CurrentPageContext = Readonly<{
  articleId: string;
  path: string;
  title: string;
}>;

export type CompletedAnswerTurn = Readonly<{
  answer: string;
  question: string;
}>;

export type AnswerHistoryMessage = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type AnswerCitation = Readonly<{
  articleContentHash: string;
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  headingPath: readonly string[];
  id: string;
  sourceId: string;
  sourceLineRange: Readonly<{ end: number; start: number }>;
  title: string;
}>;

export type CitedAnswerBlock = Readonly<{
  citation: AnswerCitation;
  markdown: readonly string[];
}>;

export type PublicGenerationMetadata = Readonly<{
  model: string;
  provider: "cloudflare-workers-ai" | "openai-compatible";
  retentionDisclosure: string;
}>;

type AnswerFinish = Readonly<{
  reason: "content-filter" | "length" | "stop" | "tool-call" | "unknown";
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

type AnswerAbstention = Readonly<{
  message: string;
  reason:
    | "conflicting-evidence"
    | "insufficient-evidence"
    | "out-of-scope"
    | "unsafe-evidence"
    | "unsafe-request";
}>;

export type AnswerStreamSnapshot = Readonly<{
  abstention: AnswerAbstention | null;
  blocks: readonly CitedAnswerBlock[];
  conversationId: string | null;
  failure: AnswerFailureCode | null;
  finish: AnswerFinish | null;
  metadata: PublicGenerationMetadata | null;
  phase: "abstained" | "complete" | "error" | "streaming";
}>;

type AnswerStreamRecord =
  | Readonly<{
      conversationId: string;
      generation: PublicGenerationMetadata;
      type: "metadata";
    }>
  | Readonly<{ markdown: string; type: "content" }>
  | Readonly<{ citation: AnswerCitation; type: "citation" }>
  | Readonly<{
      message: string;
      reason: AnswerAbstention["reason"];
      type: "abstention";
      usage?: AnswerFinish["usage"];
    }>
  | Readonly<{
      reason: AnswerFinish["reason"];
      type: "finish";
      usage: AnswerFinish["usage"];
    }>
  | Readonly<{
      code: "cancelled" | "invalid-answer" | "unavailable";
      type: "error";
    }>;

type ConsumeAnswerOptions = Readonly<{
  onSnapshot?: (snapshot: AnswerStreamSnapshot) => void;
  signal?: AbortSignal;
}>;

const encoder = new TextEncoder();

function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function objectRecord(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AnswerStreamError("invalid-response");
  }
  return value as Record<string, unknown>;
}

function validText(value: unknown, maximumUtf8Bytes: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    utf8ByteLength(value) <= maximumUtf8Bytes &&
    !forbiddenControls.test(value) &&
    !directionalControls.test(value)
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    validText(value, 1_000) &&
    codePointLength(value as string) <= maximumIdentifierCodePoints
  );
}

function generationMetadata(value: unknown): PublicGenerationMetadata {
  const record = objectRecord(value);
  if (
    !exactKeys(record, ["model", "provider", "retentionDisclosure"]) ||
    !validIdentifier(record.model) ||
    (record.provider !== "cloudflare-workers-ai" &&
      record.provider !== "openai-compatible") ||
    !validText(record.retentionDisclosure, 2_048)
  ) {
    throw new AnswerStreamError("invalid-response");
  }
  return Object.freeze({
    model: record.model,
    provider: record.provider,
    retentionDisclosure: record.retentionDisclosure as string,
  });
}

function canonicalUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value) > maximumCanonicalUrlUtf8Bytes ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    throw new AnswerStreamError("invalid-response");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AnswerStreamError("invalid-response");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AnswerStreamError("invalid-response");
  }
  return value;
}

function citationLineRange(value: unknown) {
  const record = objectRecord(value);
  if (
    !exactKeys(record, ["end", "start"]) ||
    !Number.isSafeInteger(record.start) ||
    !Number.isSafeInteger(record.end) ||
    (record.start as number) < 1 ||
    (record.end as number) < (record.start as number)
  ) {
    throw new AnswerStreamError("invalid-response");
  }
  return Object.freeze({ end: record.end as number, start: record.start as number });
}

function answerCitation(value: unknown): AnswerCitation {
  const record = objectRecord(value);
  if (
    !exactKeys(record, [
      "articleContentHash",
      "articleId",
      "canonicalUrl",
      "contentHash",
      "headingPath",
      "id",
      "sourceId",
      "sourceLineRange",
      "title",
    ]) ||
    typeof record.articleContentHash !== "string" ||
    !hashPattern.test(record.articleContentHash) ||
    !validIdentifier(record.articleId) ||
    typeof record.contentHash !== "string" ||
    !hashPattern.test(record.contentHash) ||
    typeof record.id !== "string" ||
    !/^C[1-5]$/u.test(record.id) ||
    !validIdentifier(record.sourceId) ||
    !validText(record.title, maximumTitleUtf8Bytes) ||
    !Array.isArray(record.headingPath) ||
    record.headingPath.length > 10 ||
    !record.headingPath.every((heading) => validText(heading, 500))
  ) {
    throw new AnswerStreamError("invalid-response");
  }
  return Object.freeze({
    articleContentHash: record.articleContentHash,
    articleId: record.articleId,
    canonicalUrl: canonicalUrl(record.canonicalUrl),
    contentHash: record.contentHash,
    headingPath: Object.freeze([...(record.headingPath as string[])]),
    id: record.id,
    sourceId: record.sourceId,
    sourceLineRange: citationLineRange(record.sourceLineRange),
    title: record.title as string,
  });
}

function usage(value: unknown): AnswerFinish["usage"] {
  const record = objectRecord(value);
  if (!exactKeys(record, ["inputTokens", "outputTokens", "totalTokens"])) {
    throw new AnswerStreamError("invalid-response");
  }
  for (const tokenCount of [
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
  ]) {
    if (
      tokenCount !== null &&
      (!Number.isSafeInteger(tokenCount) || (tokenCount as number) < 0)
    ) {
      throw new AnswerStreamError("invalid-response");
    }
  }
  return Object.freeze({
    inputTokens: record.inputTokens as number | null,
    outputTokens: record.outputTokens as number | null,
    totalTokens: record.totalTokens as number | null,
  });
}

function parseRecord(line: string): AnswerStreamRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AnswerStreamError("invalid-response");
  }
  const record = objectRecord(value);
  if (
    record.type === "metadata" &&
    exactKeys(record, ["conversationId", "generation", "type"]) &&
    typeof record.conversationId === "string" &&
    conversationIdPattern.test(record.conversationId)
  ) {
    return Object.freeze({
      conversationId: record.conversationId,
      generation: generationMetadata(record.generation),
      type: "metadata" as const,
    });
  }
  if (record.type === "content" && exactKeys(record, ["markdown", "type"])) {
    try {
      return Object.freeze({
        markdown: validateAnswerMarkdown(record.markdown).markdown,
        type: "content" as const,
      });
    } catch {
      throw new AnswerStreamError("invalid-response");
    }
  }
  if (record.type === "citation" && exactKeys(record, ["citation", "type"])) {
    return Object.freeze({ citation: answerCitation(record.citation), type: "citation" });
  }
  const abstentionHasUsage = record.type === "abstention" && "usage" in record;
  if (
    record.type === "abstention" &&
    exactKeys(
      record,
      abstentionHasUsage
        ? ["message", "reason", "type", "usage"]
        : ["message", "reason", "type"],
    ) &&
    (record.reason === "conflicting-evidence" ||
      record.reason === "insufficient-evidence" ||
      record.reason === "out-of-scope" ||
      record.reason === "unsafe-evidence" ||
      record.reason === "unsafe-request") &&
    validText(record.message, 2_048)
  ) {
    return Object.freeze({
      message: record.message as string,
      reason: record.reason,
      type: "abstention" as const,
      ...(abstentionHasUsage ? { usage: usage(record.usage) } : {}),
    });
  }
  const finishReasons = new Set([
    "content-filter",
    "length",
    "stop",
    "tool-call",
    "unknown",
  ]);
  if (
    record.type === "finish" &&
    exactKeys(record, ["reason", "type", "usage"]) &&
    typeof record.reason === "string" &&
    finishReasons.has(record.reason)
  ) {
    return Object.freeze({
      reason: record.reason as AnswerFinish["reason"],
      type: "finish" as const,
      usage: usage(record.usage),
    });
  }
  if (
    record.type === "error" &&
    exactKeys(record, ["code", "type"]) &&
    (record.code === "cancelled" ||
      record.code === "invalid-answer" ||
      record.code === "unavailable")
  ) {
    return Object.freeze({ code: record.code, type: "error" as const });
  }
  throw new AnswerStreamError("invalid-response");
}

function frozenSnapshot(snapshot: AnswerStreamSnapshot): AnswerStreamSnapshot {
  return Object.freeze({
    ...snapshot,
    blocks: Object.freeze(
      snapshot.blocks.map((block) =>
        Object.freeze({ ...block, markdown: Object.freeze([...block.markdown]) }),
      ),
    ),
  });
}

function answerAccumulator(onSnapshot?: (snapshot: AnswerStreamSnapshot) => void) {
  let conversationId: string | null = null;
  let metadata: PublicGenerationMetadata | null = null;
  let blocks: CitedAnswerBlock[] = [];
  let pendingMarkdown: string[] = [];
  let terminal: "abstained" | "complete" | "error" | null = null;
  let latest = frozenSnapshot({
    abstention: null,
    blocks: [],
    conversationId: null,
    failure: null,
    finish: null,
    metadata: null,
    phase: "streaming",
  });

  function publish(update: Partial<AnswerStreamSnapshot>) {
    latest = frozenSnapshot({
      ...latest,
      ...update,
      blocks,
      conversationId,
      metadata,
    });
    onSnapshot?.(latest);
  }

  return {
    complete() {
      if (!terminal || pendingMarkdown.length > 0) {
        throw new AnswerStreamError("disconnected");
      }
      return latest;
    },
    push(record: AnswerStreamRecord) {
      if (terminal) throw new AnswerStreamError("invalid-response");
      if (record.type === "metadata") {
        if (metadata) throw new AnswerStreamError("invalid-response");
        conversationId = record.conversationId;
        metadata = record.generation;
        publish({ conversationId, metadata });
        return;
      }
      if (!metadata) throw new AnswerStreamError("invalid-response");
      if (record.type === "content") {
        pendingMarkdown.push(record.markdown);
        publish({});
        return;
      }
      if (record.type === "citation") {
        if (pendingMarkdown.length === 0) {
          throw new AnswerStreamError("invalid-response");
        }
        blocks = [
          ...blocks,
          Object.freeze({
            citation: record.citation,
            markdown: Object.freeze([...pendingMarkdown]),
          }),
        ];
        pendingMarkdown = [];
        publish({ blocks });
        return;
      }
      if (record.type === "abstention") {
        if (blocks.length > 0 || pendingMarkdown.length > 0) {
          throw new AnswerStreamError("invalid-response");
        }
        terminal = "abstained";
        publish({
          abstention: Object.freeze({
            message: record.message,
            reason: record.reason,
          }),
          phase: "abstained",
        });
        return;
      }
      if (record.type === "finish") {
        if (blocks.length === 0 || pendingMarkdown.length > 0) {
          throw new AnswerStreamError("invalid-response");
        }
        terminal = "complete";
        publish({
          finish: Object.freeze({ reason: record.reason, usage: record.usage }),
          phase: "complete",
        });
        return;
      }
      pendingMarkdown = [];
      terminal = "error";
      const failure =
        record.code === "invalid-answer" ? "invalid-response" : record.code;
      publish({ failure, phase: "error" });
    },
  };
}

function answerContentType(value: string | null) {
  return (
    value !== null &&
    /^application\/x-ndjson(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

function cancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new AnswerStreamError("cancelled");
}

export async function consumeAnswerResponse(
  response: Response,
  options: ConsumeAnswerOptions = {},
) {
  cancelled(options.signal);
  if (!response.ok) {
    throw new AnswerStreamError(response.status === 499 ? "cancelled" : "unavailable");
  }
  if (!answerContentType(response.headers.get("content-type")) || !response.body) {
    throw new AnswerStreamError("invalid-response");
  }

  const accumulator = answerAccumulator(options.onSnapshot);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let streamEnded = false;
  try {
    while (true) {
      cancelled(options.signal);
      const result = await reader.read();
      if (result.done) {
        streamEnded = true;
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumStreamUtf8Bytes) {
        throw new AnswerStreamError("invalid-response");
      }
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line || utf8ByteLength(line) > maximumRecordUtf8Bytes) {
          throw new AnswerStreamError("invalid-response");
        }
        accumulator.push(parseRecord(line));
        newline = buffer.indexOf("\n");
      }
      if (utf8ByteLength(buffer) > maximumRecordUtf8Bytes) {
        throw new AnswerStreamError("invalid-response");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) throw new AnswerStreamError("invalid-response");
    return accumulator.complete();
  } catch (error) {
    if (error instanceof AnswerStreamError) throw error;
    cancelled(options.signal);
    throw new AnswerStreamError("disconnected");
  } finally {
    if (!streamEnded) {
      try {
        await reader.cancel();
      } catch {
        // Closing a disconnected or cancelled response stream is best effort.
      }
    }
    reader.releaseLock();
  }
}

function truncateUtf8(value: string, maximumBytes: number) {
  if (utf8ByteLength(value) <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8ByteLength(`${result}${character}`) > maximumBytes) break;
    result += character;
  }
  return result;
}

export function isValidCurrentPageContext(
  value: CurrentPageContext | null | undefined,
): value is CurrentPageContext {
  return (
    value !== null &&
    value !== undefined &&
    validIdentifier(value.articleId) &&
    validText(value.title, 640) &&
    codePointLength(value.title) <= 160 &&
    utf8ByteLength(value.path) <= 512 &&
    articlePathPattern.test(value.path)
  );
}

function normalizedQuestion(value: unknown) {
  if (
    typeof value !== "string" ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    return null;
  }
  const question = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return question && codePointLength(question) <= maximumQuestionCodePoints
    ? question
    : null;
}

export function conversationHistory(
  completedTurns: readonly CompletedAnswerTurn[],
) {
  const history: AnswerHistoryMessage[] = [];
  const turns = completedTurns.slice(-3);
  for (const turn of turns) {
    const question = normalizedQuestion(turn.question);
    if (
      !question ||
      typeof turn.answer !== "string" ||
      !turn.answer.trim() ||
      forbiddenControls.test(turn.answer) ||
      directionalControls.test(turn.answer)
    ) {
      continue;
    }
    history.push(
      Object.freeze({ content: question, role: "user" as const }),
      Object.freeze({
        content: truncateUtf8(turn.answer.trim(), maximumHistoryAnswerUtf8Bytes),
        role: "assistant" as const,
      }),
    );
  }

  while (
    history.length > maximumHistoryMessages ||
    history.reduce((total, message) => total + utf8ByteLength(message.content), 0) >
      maximumHistoryUtf8Bytes
  ) {
    if (history.length < 2) break;
    history.splice(0, 2);
  }
  return Object.freeze([...history]);
}

export function describeAnswerFailure(code: AnswerFailureCode) {
  const messages: Record<AnswerFailureCode, string> = {
    cancelled: "Answer stopped. You can retry when you’re ready.",
    disconnected:
      "The answer stream disconnected. Check your connection and try again.",
    "invalid-response":
      "The answer could not be verified. Try again or open a search result.",
    unavailable:
      "Answers are temporarily unavailable. Search still works, or try again.",
  };
  return Object.freeze({ message: messages[code], retryable: true });
}
