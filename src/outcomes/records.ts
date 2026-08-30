// ABOUTME: Normalizes bounded answer analytics and removes sensitive text before persistence.
// ABOUTME: Defines the portable retention, outcome, conversation, trace, and cost contract.
export const maximumConversationAnalyticsRetentionDays = 30;
export const defaultConversationAnalyticsRetentionDays = 30;
export const conversationAnalyticsSlotsPerDay = 1_024;
export const maximumConversationAnalyticsMessages = 10;
export const maximumConversationAnalyticsMessageUtf8Bytes = 2_048;
export const maximumConversationAnalyticsUtf8Bytes = 12_288;
export const maximumRetrievalTraceEntries = 5;
export const maximumRetrievalTraceUtf8Bytes = 6_144;
export const maximumRetrievalExcerptUtf8Bytes = 1_024;
export const maximumRetrievalHeadingCount = 10;
export const maximumRetrievalHeadingUtf8Bytes = 500;
export const maximumOutcomeReasonUtf8Bytes = 256;

const millisecondsPerDay = 86_400_000;
const maximumDurationMilliseconds = 300_000;
const maximumTokens = 1_000_000;
const maximumCostMicrodollars = 2_000_000_000;
const maximumConfiguredPatterns = 32;
const maximumConfiguredPatternCodePoints = 128;
const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const contentHashPattern = /^[a-f\d]{64}$/u;
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const directionalControls = /[\u202a-\u202e\u2066-\u2069]/gu;
const forbiddenControlValidator = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const directionalControlValidator = /[\u202a-\u202e\u2066-\u2069]/u;
const emailPattern =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*\b/giu;
const ipv4Pattern = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu;
const ipv6CandidatePattern =
  /(?<![\da-f:.])(?=[\da-f:]*:)[\da-f:]+(?:\d{1,3}(?:\.\d{1,3}){3})?(?![\da-f:.])/giu;
const phonePattern = /(?<![\p{L}\p{N}])\+?\d(?:[\d(). -]{6,}\d)(?![\p{L}\p{N}])/gu;
const authorizationPattern =
  /\b(?:bearer|basic)\s+[a-z0-9+/._~=-]+/giu;
const credentialPattern =
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|refresh[_-]?token|secret|token)\b["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;}\]]+)/giu;
const knownTokenPattern =
  /\b(?:AKIA[0-9A-Z]{16}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gu;
const jwtPattern = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const privateKeyPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const urlCredentialPattern =
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/giu;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ConversationOutcome =
  | "abandoned"
  | "abstained"
  | "answered"
  | "escalated"
  | "low-rated";

export type ConversationAnalyticsMessage = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type ConversationRetrievalTrace = Readonly<{
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

export type ConversationAnalyticsRecord = Readonly<{
  bucketDay: string;
  bucketSlot: number;
  conversation: readonly ConversationAnalyticsMessage[];
  costMicrodollars: number | null;
  durationMilliseconds: number;
  expiresAt: Date;
  firstTokenMilliseconds: number | null;
  id: string;
  inputTokens: number | null;
  model: string;
  outcome: ConversationOutcome;
  outputTokens: number | null;
  provider: string;
  reason: string | null;
  retrievalTrace: readonly ConversationRetrievalTrace[];
  startedAt: Date;
  updatedAt: Date;
  workspaceId: string;
}>;

export type ConversationAnalyticsPolicy =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      redact(value: string): string;
      retentionDays: number;
      status: "enabled";
    }>;

export type ConversationAnalyticsEnvironment = Readonly<{
  OPAS_ANSWER_ANALYTICS_RETENTION_DAYS?: string;
  OPAS_ANALYTICS_REDACTION_PATTERNS?: string;
}>;

export type ConversationAnalyticsInput = Readonly<{
  conversation: readonly ConversationAnalyticsMessage[];
  costMicrodollars?: number | null;
  durationMilliseconds: number;
  firstTokenMilliseconds?: number | null;
  id: string;
  inputTokens?: number | null;
  model: string;
  outcome: ConversationOutcome;
  outputTokens?: number | null;
  provider: string;
  reason?: string | null;
  retrievalTrace: readonly ConversationRetrievalTrace[];
  startedAt: Date;
  updatedAt: Date;
  workspaceId: string;
}>;

function utf8Length(value: string) {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.slice(0, end)).trimEnd();
}

function normalizedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(forbiddenControls, " ")
    .replace(directionalControls, " ");
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ipv6Shape(value: string) {
  let normalized = value;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return false;
    const ipv4 = normalized.slice(separator + 1);
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(ipv4)) return false;
    normalized = `${normalized.slice(0, separator + 1)}0:0`;
  }
  const firstCompression = normalized.indexOf("::");
  if (
    firstCompression !== -1 &&
    normalized.indexOf("::", firstCompression + 2) !== -1
  ) {
    return false;
  }
  const groups = normalized.split(":").filter(Boolean);
  if (groups.some((group) => !/^[\da-f]{1,4}$/iu.test(group))) return false;
  return firstCompression === -1 ? groups.length === 8 : groups.length < 8;
}

function redactIpAddresses(value: string) {
  return value
    .replace(ipv6CandidatePattern, (candidate) =>
      ipv6Shape(candidate) ? "[REDACTED]" : candidate,
    )
    .replace(ipv4Pattern, "[REDACTED]");
}

function customerPatterns(value: string | undefined) {
  if (value === undefined || value === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > maximumConfiguredPatterns ||
    parsed.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim() !== entry ||
        entry.length === 0 ||
        Array.from(entry).length > maximumConfiguredPatternCodePoints ||
        forbiddenControlValidator.test(entry) ||
        directionalControlValidator.test(entry),
    )
  ) {
    return null;
  }
  return parsed.map((entry) => new RegExp(escapedPattern(entry), "giu"));
}

function configuredRetentionDays(value: string | undefined) {
  if (value === undefined) return defaultConversationAnalyticsRetentionDays;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) &&
    days >= 0 &&
    days <= maximumConversationAnalyticsRetentionDays
    ? days
    : null;
}

export function createConversationAnalyticsPolicy(
  environment: ConversationAnalyticsEnvironment,
): ConversationAnalyticsPolicy {
  const retentionDays = configuredRetentionDays(
    environment.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS,
  );
  const patterns = customerPatterns(
    environment.OPAS_ANALYTICS_REDACTION_PATTERNS,
  );
  if (retentionDays === null || patterns === null) {
    return Object.freeze({ status: "unavailable" });
  }
  if (retentionDays === 0) return Object.freeze({ status: "disabled" });

  return Object.freeze({
    redact(value: string) {
      let redacted = normalizedText(value)
        .replace(privateKeyPattern, "[REDACTED]")
        .replace(urlCredentialPattern, "https://[REDACTED]@")
        .replace(emailPattern, "[REDACTED]");
      redacted = redactIpAddresses(redacted)
        .replace(phonePattern, "[REDACTED]")
        .replace(authorizationPattern, "[REDACTED]")
        .replace(credentialPattern, "[REDACTED]")
        .replace(knownTokenPattern, "[REDACTED]")
        .replace(jwtPattern, "[REDACTED]");
      for (const pattern of patterns) {
        redacted = redacted.replace(pattern, "[REDACTED]");
      }
      return redacted;
    },
    retentionDays,
    status: "enabled" as const,
  });
}

export function normalizeConversationAnalyticsId(value: unknown) {
  return typeof value === "string" && conversationIdPattern.test(value)
    ? value
    : null;
}

export function prepareConversationOutcomeReason(
  value: unknown,
  policy: Extract<ConversationAnalyticsPolicy, { status: "enabled" }>,
) {
  return typeof value === "string"
    ? truncateUtf8(policy.redact(value).trim(), maximumOutcomeReasonUtf8Bytes) || null
    : null;
}

function safeDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function boundedInteger(value: number | null | undefined, maximum: number) {
  return value === null || value === undefined
    ? null
    : Number.isSafeInteger(value) && value >= 0 && value <= maximum
      ? value
      : null;
}

function boundedIdentity(value: string, maximumBytes: number) {
  const normalized = normalizedText(value).trim().replace(/\s+/gu, "-");
  return truncateUtf8(normalized || "unknown", maximumBytes);
}

function preparedConversation(
  messages: readonly ConversationAnalyticsMessage[],
  redact: (value: string) => string,
) {
  const prepared: ConversationAnalyticsMessage[] = [];
  let remaining = maximumConversationAnalyticsUtf8Bytes;
  for (const message of messages.slice(-maximumConversationAnalyticsMessages)) {
    if (
      !message ||
      (message.role !== "assistant" && message.role !== "user") ||
      typeof message.content !== "string" ||
      remaining < 1
    ) {
      continue;
    }
    const content = truncateUtf8(
      redact(message.content).trim(),
      Math.min(maximumConversationAnalyticsMessageUtf8Bytes, remaining),
    );
    if (!content) continue;
    prepared.push(Object.freeze({ content, role: message.role }));
    remaining -= utf8Length(content);
  }
  return Object.freeze(prepared);
}

function preparedTrace(
  entries: readonly ConversationRetrievalTrace[],
  redact: (value: string) => string,
) {
  const prepared: ConversationRetrievalTrace[] = [];
  let remaining = maximumRetrievalTraceUtf8Bytes;
  for (const entry of entries.slice(0, maximumRetrievalTraceEntries)) {
    if (
      !entry ||
      remaining < 1 ||
      !Number.isSafeInteger(entry.indexGeneration) ||
      entry.indexGeneration < 1 ||
      !["hybrid", "lexical", "vector"].includes(entry.mode) ||
      !Number.isSafeInteger(entry.ordinal) ||
      entry.ordinal < 0 ||
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      typeof entry.articleContentHash !== "string" ||
      !contentHashPattern.test(entry.articleContentHash) ||
      typeof entry.contentHash !== "string" ||
      !contentHashPattern.test(entry.contentHash) ||
      !Array.isArray(entry.headingPath) ||
      entry.headingPath.length > maximumRetrievalHeadingCount ||
      entry.headingPath.some((heading) => typeof heading !== "string") ||
      !entry.sourceLineRange ||
      !Number.isSafeInteger(entry.sourceLineRange.start) ||
      !Number.isSafeInteger(entry.sourceLineRange.end) ||
      entry.sourceLineRange.start < 1 ||
      entry.sourceLineRange.end < entry.sourceLineRange.start ||
      entry.sourceLineRange.end > 1_000_000
    ) {
      continue;
    }
    const values = [
      ["articleId", entry.articleId, 200],
      ["canonicalUrl", entry.canonicalUrl, 2_048],
      ["excerpt", entry.excerpt, maximumRetrievalExcerptUtf8Bytes],
      ["sourceId", entry.sourceId, 200],
      ["title", entry.title, 1_000],
    ] as const;
    const normalized: Record<string, string> = {};
    let accepted = true;
    for (const [key, value, maximum] of values) {
      if (typeof value !== "string") {
        accepted = false;
        break;
      }
      const text = truncateUtf8(
        redact(value).trim(),
        Math.min(maximum, remaining),
      );
      if (!text) {
        accepted = false;
        break;
      }
      normalized[key] = text;
      remaining -= utf8Length(text);
    }
    const headingPath: string[] = [];
    for (const heading of entry.headingPath) {
      const text = truncateUtf8(
        redact(heading).trim(),
        Math.min(maximumRetrievalHeadingUtf8Bytes, remaining),
      );
      if (!text) {
        accepted = false;
        break;
      }
      headingPath.push(text);
      remaining -= utf8Length(text);
    }
    if (accepted) {
      prepared.push(
        Object.freeze({
          articleContentHash: entry.articleContentHash,
          articleId: normalized.articleId!,
          canonicalUrl: normalized.canonicalUrl!,
          contentHash: entry.contentHash,
          excerpt: normalized.excerpt!,
          headingPath: Object.freeze(headingPath),
          indexGeneration: entry.indexGeneration,
          mode: entry.mode,
          ordinal: entry.ordinal,
          score: entry.score,
          sourceId: normalized.sourceId!,
          sourceLineRange: Object.freeze({
            end: entry.sourceLineRange.end,
            start: entry.sourceLineRange.start,
          }),
          title: normalized.title!,
        }),
      );
    }
  }
  return Object.freeze(prepared);
}

function conversationBucket(id: string, startedAt: Date) {
  return {
    bucketDay: startedAt.toISOString().slice(0, 10).replaceAll("-", ""),
    bucketSlot: Number.parseInt(id.slice(0, 8), 16) % conversationAnalyticsSlotsPerDay,
  };
}

export function prepareConversationAnalyticsRecord(
  input: ConversationAnalyticsInput,
  policy: Extract<ConversationAnalyticsPolicy, { status: "enabled" }>,
): ConversationAnalyticsRecord | null {
  const id = normalizeConversationAnalyticsId(input.id);
  if (
    !id ||
    typeof input.workspaceId !== "string" ||
    !input.workspaceId ||
    !safeDate(input.startedAt) ||
    !safeDate(input.updatedAt) ||
    input.updatedAt < input.startedAt ||
    !Number.isSafeInteger(input.durationMilliseconds) ||
    input.durationMilliseconds < 0 ||
    input.durationMilliseconds > maximumDurationMilliseconds ||
    !["abandoned", "abstained", "answered", "escalated", "low-rated"].includes(
      input.outcome,
    )
  ) {
    return null;
  }
  const firstTokenMilliseconds = boundedInteger(
    input.firstTokenMilliseconds,
    maximumDurationMilliseconds,
  );
  if (
    (input.firstTokenMilliseconds !== undefined &&
      input.firstTokenMilliseconds !== null &&
      firstTokenMilliseconds === null) ||
    (input.outcome === "abstained" && firstTokenMilliseconds !== null) ||
    (firstTokenMilliseconds !== null &&
      firstTokenMilliseconds > input.durationMilliseconds)
  ) {
    return null;
  }
  const reason = prepareConversationOutcomeReason(input.reason, policy);
  const expiresAt = new Date(
    input.startedAt.getTime() + policy.retentionDays * millisecondsPerDay,
  );
  const { bucketDay, bucketSlot } = conversationBucket(id, input.startedAt);
  return Object.freeze({
    bucketDay,
    bucketSlot,
    conversation: preparedConversation(input.conversation, policy.redact),
    costMicrodollars: boundedInteger(
      input.costMicrodollars,
      maximumCostMicrodollars,
    ),
    durationMilliseconds: input.durationMilliseconds,
    expiresAt,
    firstTokenMilliseconds,
    id,
    inputTokens: boundedInteger(input.inputTokens, maximumTokens),
    model: truncateUtf8(policy.redact(boundedIdentity(input.model, 256)), 256),
    outcome: input.outcome,
    outputTokens: boundedInteger(input.outputTokens, maximumTokens),
    provider: truncateUtf8(policy.redact(boundedIdentity(input.provider, 64)), 64),
    reason,
    retrievalTrace: preparedTrace(input.retrievalTrace, policy.redact),
    startedAt: new Date(input.startedAt),
    updatedAt: new Date(input.updatedAt),
    workspaceId: boundedIdentity(input.workspaceId, 200),
  });
}

export function conversationAnalyticsRetentionStartedAt(
  readAt: Date,
  retentionDays: number,
) {
  return new Date(readAt.getTime() - retentionDays * millisecondsPerDay);
}

export function estimateConversationCostMicrodollars(
  inputTokens: number | null,
  outputTokens: number | null,
  inputRate: string | undefined,
  outputRate: string | undefined,
) {
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    typeof inputRate !== "string" ||
    typeof outputRate !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(inputRate) ||
    !/^(?:0|[1-9]\d*)$/u.test(outputRate)
  ) {
    return null;
  }
  const inputNumerator = (inputTokens as number) * Number(inputRate);
  const outputNumerator = (outputTokens as number) * Number(outputRate);
  if (
    !Number.isSafeInteger(inputNumerator) ||
    !Number.isSafeInteger(outputNumerator)
  ) {
    return null;
  }
  const inputCost = Math.ceil(inputNumerator / 1_000_000);
  const outputCost = Math.ceil(outputNumerator / 1_000_000);
  const cost = inputCost + outputCost;
  return Number.isSafeInteger(cost) && cost >= 0 && cost <= maximumCostMicrodollars
    ? cost
    : null;
}
