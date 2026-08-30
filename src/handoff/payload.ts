// ABOUTME: Normalizes bounded support context and resolves citation claims from published evidence.
// ABOUTME: Keeps untrusted contact data separate from server-owned citation metadata.
import { HandoffError } from "@/handoff/errors";

export const maximumHandoffRequestUtf8Bytes = 65_536;
export const maximumHandoffPayloadUtf8Bytes = 32_768;
export const maximumHandoffTranscriptMessages = 8;
export const maximumHandoffCitations = 20;

const maximumQuestionCodePoints = 200;
const maximumTranscriptMessageUtf8Bytes = 2_048;
const maximumTranscriptUtf8Bytes = 8_192;
const maximumIdentifierCodePoints = 200;
const maximumTitleUtf8Bytes = 1_000;
const maximumHeadingUtf8Bytes = 500;
const maximumHeadingCount = 10;
const maximumPageUrlUtf8Bytes = 2_048;
const maximumContactNameCodePoints = 100;
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const directionalControls = /[\u202a-\u202e\u2066-\u2069]/u;
const hashPattern = /^[a-f\d]{64}$/u;
const citationIdPattern = /^C[1-5]$/u;
const idempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localPartPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const encoder = new TextEncoder();

export type HandoffOutcome = "abstained" | "low-rated" | "user-requested";

export type HandoffTranscriptMessage = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type HandoffContact = Readonly<{
  email: string;
  name?: string;
}>;

export type HandoffCitationClaim = Readonly<{
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

export type HandoffCitation = Omit<HandoffCitationClaim, "id">;

export type HandoffSubmission = Readonly<{
  citations: readonly HandoffCitationClaim[];
  contact: HandoffContact;
  outcome: HandoffOutcome;
  pageUrl: string;
  question: string;
  transcript: readonly HandoffTranscriptMessage[];
}>;

export type HandoffPayload = Readonly<{
  citations: readonly HandoffCitation[];
  contact: HandoffContact;
  outcome: HandoffOutcome;
  pageUrl: string;
  question: string;
  transcript: readonly HandoffTranscriptMessage[];
}>;

export type HandoffEvidence = Readonly<{
  articleContentHash: string;
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  headingPath: readonly string[];
  id: string;
  sourceLineRange: Readonly<{ end: number; start: number }>;
  title: string;
}>;

function invalid(): never {
  throw new HandoffError("invalid-input");
}

function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function record(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return invalid();
  }
}

function safeText(
  value: unknown,
  maximumUtf8Bytes: number,
  options: Readonly<{ collapseWhitespace?: boolean }> = {},
) {
  if (
    typeof value !== "string" ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    return invalid();
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .trim();
  const result = options.collapseWhitespace
    ? normalized.replace(/\s+/gu, " ")
    : normalized;
  if (!result || utf8ByteLength(result) > maximumUtf8Bytes) return invalid();
  return result;
}

function identifier(value: unknown) {
  const normalized = safeText(value, 1_000, { collapseWhitespace: false });
  if (codePointLength(normalized) > maximumIdentifierCodePoints) return invalid();
  return normalized;
}

function hash(value: unknown) {
  if (typeof value !== "string" || !hashPattern.test(value)) return invalid();
  return value;
}

function canonicalUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    utf8ByteLength(value) > maximumPageUrlUtf8Bytes ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    return invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalid();
  }
  return url.toString();
}

function pageUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    utf8ByteLength(value) > maximumPageUrlUtf8Bytes ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    return invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return invalid();
  }
  url.search = "";
  url.hash = "";
  const normalized = url.toString();
  if (utf8ByteLength(normalized) > maximumPageUrlUtf8Bytes) return invalid();
  return normalized;
}

export function normalizeHandoffPageUrl(
  value: unknown,
  trustedOrigins: readonly string[],
) {
  const normalized = pageUrl(value);
  if (!trustedOrigins.includes(new URL(normalized).origin)) return invalid();
  return normalized;
}

export function normalizeHandoffEmailAddress(value: unknown) {
  if (
    typeof value !== "string" ||
    forbiddenControls.test(value) ||
    directionalControls.test(value)
  ) {
    return null;
  }
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length > 254 ||
    !/^[\x21-\x7e]+$/u.test(normalized) ||
    normalized.split("@").length !== 2
  ) {
    return null;
  }
  const [local, domain] = normalized.split("@") as [string, string];
  if (
    !local ||
    local.length > 64 ||
    !localPartPattern.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !domain ||
    domain.length > 253
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !domainLabelPattern.test(label))
  ) {
    return null;
  }
  return `${local}@${domain.toLowerCase()}`;
}

function contact(value: unknown): HandoffContact {
  const input = record(value);
  const keys = Object.keys(input).sort();
  if (
    (keys.length !== 1 && keys.length !== 2) ||
    keys[0] !== "email" ||
    (keys.length === 2 && keys[1] !== "name")
  ) {
    return invalid();
  }
  const email = normalizeHandoffEmailAddress(input.email);
  if (!email) return invalid();
  if (input.name === undefined) return Object.freeze({ email });
  const name = safeText(input.name, 500, { collapseWhitespace: true });
  if (codePointLength(name) > maximumContactNameCodePoints) return invalid();
  return Object.freeze({ email, name });
}

function lineRange(value: unknown) {
  const input = record(value);
  exactKeys(input, ["end", "start"]);
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    (input.start as number) < 1 ||
    (input.end as number) < (input.start as number)
  ) {
    return invalid();
  }
  return Object.freeze({ end: input.end as number, start: input.start as number });
}

function headingPath(value: unknown) {
  if (!Array.isArray(value) || value.length > maximumHeadingCount) return invalid();
  return Object.freeze(
    value.map((heading) => safeText(heading, maximumHeadingUtf8Bytes)),
  );
}

function citationClaim(value: unknown): HandoffCitationClaim {
  const input = record(value);
  exactKeys(input, [
    "articleContentHash",
    "articleId",
    "canonicalUrl",
    "contentHash",
    "headingPath",
    "id",
    "sourceId",
    "sourceLineRange",
    "title",
  ]);
  if (typeof input.id !== "string" || !citationIdPattern.test(input.id)) {
    return invalid();
  }
  return Object.freeze({
    articleContentHash: hash(input.articleContentHash),
    articleId: identifier(input.articleId),
    canonicalUrl: canonicalUrl(input.canonicalUrl),
    contentHash: hash(input.contentHash),
    headingPath: headingPath(input.headingPath),
    id: input.id,
    sourceId: identifier(input.sourceId),
    sourceLineRange: lineRange(input.sourceLineRange),
    title: safeText(input.title, maximumTitleUtf8Bytes),
  });
}

function citation(value: unknown): HandoffCitation {
  const input = record(value);
  exactKeys(input, [
    "articleContentHash",
    "articleId",
    "canonicalUrl",
    "contentHash",
    "headingPath",
    "sourceId",
    "sourceLineRange",
    "title",
  ]);
  return Object.freeze({
    articleContentHash: hash(input.articleContentHash),
    articleId: identifier(input.articleId),
    canonicalUrl: canonicalUrl(input.canonicalUrl),
    contentHash: hash(input.contentHash),
    headingPath: headingPath(input.headingPath),
    sourceId: identifier(input.sourceId),
    sourceLineRange: lineRange(input.sourceLineRange),
    title: safeText(input.title, maximumTitleUtf8Bytes),
  });
}

function transcript(value: unknown) {
  if (!Array.isArray(value) || value.length > maximumHandoffTranscriptMessages) {
    return invalid();
  }
  let totalBytes = 0;
  const messages = value.map((entry) => {
    const input = record(entry);
    exactKeys(input, ["content", "role"]);
    if (input.role !== "assistant" && input.role !== "user") return invalid();
    const content = safeText(input.content, maximumTranscriptMessageUtf8Bytes);
    totalBytes += utf8ByteLength(content);
    if (totalBytes > maximumTranscriptUtf8Bytes) return invalid();
    return Object.freeze({ content, role: input.role });
  });
  return Object.freeze(messages);
}

function outcome(value: unknown): HandoffOutcome {
  if (
    value !== "abstained" &&
    value !== "low-rated" &&
    value !== "user-requested"
  ) {
    return invalid();
  }
  return value;
}

function question(value: unknown) {
  const normalized = safeText(value, 2_000, { collapseWhitespace: true });
  if (codePointLength(normalized) > maximumQuestionCodePoints) return invalid();
  return normalized;
}

function boundedPayload<T>(value: T) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (utf8ByteLength(serialized) > maximumHandoffPayloadUtf8Bytes) {
    return invalid();
  }
  return Object.freeze(value);
}

export function normalizeHandoffIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    return invalid();
  }
  return value;
}

export function normalizeHandoffSubmission(value: unknown): HandoffSubmission {
  const input = record(value);
  exactKeys(input, [
    "citations",
    "contact",
    "outcome",
    "pageUrl",
    "question",
    "transcript",
  ]);
  if (
    !Array.isArray(input.citations) ||
    input.citations.length > maximumHandoffCitations
  ) {
    return invalid();
  }
  return boundedPayload({
    citations: Object.freeze(input.citations.map(citationClaim)),
    contact: contact(input.contact),
    outcome: outcome(input.outcome),
    pageUrl: pageUrl(input.pageUrl),
    question: question(input.question),
    transcript: transcript(input.transcript),
  });
}

export function normalizeHandoffPayload(value: unknown): HandoffPayload {
  const input = record(value);
  exactKeys(input, [
    "citations",
    "contact",
    "outcome",
    "pageUrl",
    "question",
    "transcript",
  ]);
  if (
    !Array.isArray(input.citations) ||
    input.citations.length > maximumHandoffCitations
  ) {
    return invalid();
  }
  return boundedPayload({
    citations: Object.freeze(input.citations.map(citation)),
    contact: contact(input.contact),
    outcome: outcome(input.outcome),
    pageUrl: pageUrl(input.pageUrl),
    question: question(input.question),
    transcript: transcript(input.transcript),
  });
}

function matchingCitation(claim: HandoffCitationClaim, evidence: HandoffEvidence) {
  return (
    claim.articleContentHash === evidence.articleContentHash &&
    claim.articleId === evidence.articleId &&
    claim.canonicalUrl === evidence.canonicalUrl &&
    claim.contentHash === evidence.contentHash &&
    claim.sourceId === evidence.id &&
    claim.title === evidence.title &&
    claim.headingPath.length === evidence.headingPath.length &&
    claim.headingPath.every((heading, index) => heading === evidence.headingPath[index]) &&
    claim.sourceLineRange.start === evidence.sourceLineRange.start &&
    claim.sourceLineRange.end === evidence.sourceLineRange.end
  );
}

export function resolveHandoffPayload(
  submission: HandoffSubmission,
  evidenceRecords: readonly HandoffEvidence[],
): HandoffPayload {
  if (!Array.isArray(evidenceRecords)) return invalid();
  const bySourceId = new Map<string, HandoffCitation>();
  for (const entry of evidenceRecords) {
    const serverCitation = citation({
      articleContentHash: entry.articleContentHash,
      articleId: entry.articleId,
      canonicalUrl: entry.canonicalUrl,
      contentHash: entry.contentHash,
      headingPath: entry.headingPath,
      sourceId: entry.id,
      sourceLineRange: entry.sourceLineRange,
      title: entry.title,
    });
    bySourceId.set(serverCitation.sourceId, serverCitation);
  }

  const citations: HandoffCitation[] = [];
  const included = new Set<string>();
  for (const claim of submission.citations) {
    const serverCitation = bySourceId.get(claim.sourceId);
    if (!serverCitation || !matchingCitation(claim, {
      ...serverCitation,
      id: serverCitation.sourceId,
    })) {
      return invalid();
    }
    if (!included.has(serverCitation.sourceId)) {
      included.add(serverCitation.sourceId);
      citations.push(serverCitation);
    }
  }

  return normalizeHandoffPayload({
    citations,
    contact: submission.contact,
    outcome: submission.outcome,
    pageUrl: submission.pageUrl,
    question: submission.question,
    transcript: submission.transcript,
  });
}
