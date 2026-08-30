// ABOUTME: Enforces bounded deployment topic rules and deterministic answer safety checks.
// ABOUTME: Rejects direct and retrieved prompt injection before any generation request.
export const maximumAnswerTopicConfigurationUtf8Bytes = 4_096;
export const maximumAnswerTopicCount = 32;

const maximumTopicCodePoints = 80;
const maximumTopicWords = 8;
const encoder = new TextEncoder();
const forbiddenControls = /[\u0000-\u001f\u007f]/u;
const directionalControls = /[\u202a-\u202e\u2066-\u2069]/u;
const topicPattern = /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u;
const explicitUrl = /\bhttps?:\/\/[^\s]+/u;
const sourceBoundary =
  /\b(?:documentation|evidence|instructions?|polic(?:y|ies)|prompts?|rules?|sources?)\b/u;
const overrideAction =
  /\b(?:bypass|disregard|forget|ignore|override|supersede)\b/u;
const extractionAction =
  /\b(?:dump|expose|print|reveal)\b/u;
const disclosureAction = /\b(?:list|output|show)\b/u;
const sensitiveTarget =
  /\b(?:credentials?|developer prompts?|hidden instructions?|passwords?|private keys?|secrets?|system instructions?|system prompts?)\b/u;
const qualifiedCredentialTarget =
  /\b(?:actual|all|every|hidden|private|stored)\b.*\b(?:api keys?|tokens?)\b/u;
const citationAction = /\b(?:cite|link|reference|treat|use)\b/u;
const fabricationAction =
  /\b(?:assert|claim|fabricate|invent|make up|pretend|promise|state)\b/u;
const truthBypass =
  /\b(?:contrary to|even though|regardless of|sources? (?:did|do|does) not|unsupported by|without (?:checking|evidence|source|sources|verification))\b/u;
const authorityAction = /\b(?:accept|regard|treat|use)\b/u;
const requestSubject = /\b(?:message|question|request|user input)\b/u;
const privilegedAuthority =
  /\b(?:admin(?:istrator)?|authorization|developer|owner|policy|system)\b/u;
const accessAction =
  /\b(?:access|display|include|list|read|retrieve|reveal|show|use)\b/u;
const foreignScope = /\b(?:another|cross|different|other)\b/u;
const scopeTarget = /\b(?:account|customer|tenant|workspace)\b/u;
const privatePublication =
  /(?:\b(?:deleted|draft|unpublished)\b|\bprivate (?:article|content|document|record|source)\b)/u;
const executableAction = /\b(?:execute|inject|render|run)\b/u;
const dangerousMarkup = /\b(?:iframe|raw html|script)\b/u;
const javascript = /\bjavascript\b/u;
const exfiltrationAction =
  /\b(?:exfiltrate|send|transmit|upload)\b/u;
const protectedData =
  /\b(?:account data|credentials?|customer data|private data|secrets?|tokens?|workspace data)\b/u;
const roleMarker =
  /(?:^|\s)(?:assistant|developer|system)\s*:/u;
const modelDirection =
  /\b(?:assistant|language model|model|respond with|you must)\b/u;
const instructionAction =
  /\b(?:cite|disregard|ignore|output|override|print|respond|reveal|send)\b/u;

export type AnswerGuardrailReason =
  | "out-of-scope"
  | "unsafe-evidence"
  | "unsafe-request";

export type AnswerGuardrailEnvironment = {
  OPAS_ANSWER_TOPIC_GUARDRAILS?: string;
};

export type AnswerGuardrailHistoryMessage = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type AnswerGuardrailEvidence = Readonly<{
  evidenceText: string;
  headingPath: readonly string[];
  title: string;
}>;

export type AnswerGuardrails = Readonly<{
  evaluateEvidence(
    evidence: readonly AnswerGuardrailEvidence[],
  ): AnswerGuardrailReason | null;
  evaluateInput(input: Readonly<{
    history: readonly AnswerGuardrailHistoryMessage[];
    question: string;
  }>): AnswerGuardrailReason | null;
  generationHistory(
    history: readonly AnswerGuardrailHistoryMessage[],
  ): readonly AnswerGuardrailHistoryMessage[];
  status: "ready" | "unavailable";
}>;

export type AnswerTopicGuardrailReport =
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{
      allow: readonly string[];
      deny: readonly string[];
      status: "configured";
    }>;

type TopicPolicy = Readonly<{
  allow: readonly (readonly string[])[];
  deny: readonly (readonly string[])[];
}>;

type ParsedTopicPolicy =
  | Readonly<{ status: "invalid" }>
  | Readonly<{ policy: TopicPolicy | null; status: "ready" }>;

function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function words(value: string) {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizedSafetyText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
}

function parsedTopicList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const topics: (readonly string[])[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !candidate ||
      candidate !== candidate.normalize("NFKC").trim().replace(/\s+/gu, " ") ||
      codePointLength(candidate) > maximumTopicCodePoints ||
      forbiddenControls.test(candidate) ||
      directionalControls.test(candidate) ||
      !topicPattern.test(candidate)
    ) {
      return null;
    }
    const tokens = words(candidate);
    if (tokens.length === 0 || tokens.length > maximumTopicWords) return null;
    const key = tokens.join("\u0000");
    if (keys.has(key)) return null;
    keys.add(key);
    topics.push(Object.freeze(tokens));
  }
  return Object.freeze({ keys, topics: Object.freeze(topics) });
}

function parsedTopicPolicy(configuration: string | undefined): ParsedTopicPolicy {
  if (configuration === undefined) {
    return Object.freeze({ policy: null, status: "ready" });
  }
  if (
    typeof configuration !== "string" ||
    !configuration.trim() ||
    utf8ByteLength(configuration) > maximumAnswerTopicConfigurationUtf8Bytes
  ) {
    return Object.freeze({ status: "invalid" });
  }

  let value: unknown;
  try {
    value = JSON.parse(configuration);
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ status: "invalid" });
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "allow" && key !== "deny") ||
    ("allow" in record && !Array.isArray(record.allow)) ||
    ("deny" in record && !Array.isArray(record.deny))
  ) {
    return Object.freeze({ status: "invalid" });
  }
  const allow = parsedTopicList(record.allow ?? []);
  const deny = parsedTopicList(record.deny ?? []);
  if (
    !allow ||
    !deny ||
    allow.topics.length + deny.topics.length === 0 ||
    allow.topics.length + deny.topics.length > maximumAnswerTopicCount ||
    [...allow.keys].some((key) => deny.keys.has(key))
  ) {
    return Object.freeze({ status: "invalid" });
  }
  return Object.freeze({
    policy: Object.freeze({ allow: allow.topics, deny: deny.topics }),
    status: "ready",
  });
}

export function describeAnswerTopicGuardrails(
  configuration: string | undefined,
): AnswerTopicGuardrailReport {
  const parsed = parsedTopicPolicy(configuration);
  if (parsed.status === "invalid") {
    return Object.freeze({ status: "invalid" });
  }
  if (!parsed.policy) {
    return Object.freeze({ status: "unconfigured" });
  }
  return Object.freeze({
    allow: Object.freeze(parsed.policy.allow.map((topic) => topic.join(" "))),
    deny: Object.freeze(parsed.policy.deny.map((topic) => topic.join(" "))),
    status: "configured",
  });
}

function containsTopic(tokens: readonly string[], topic: readonly string[]) {
  if (topic.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - topic.length; start += 1) {
    if (topic.every((token, offset) => tokens[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

function matchesAnyTopic(texts: readonly string[], topics: TopicPolicy["allow"]) {
  const tokenized = texts.map(words);
  return topics.some((topic) =>
    tokenized.some((tokens) => containsTopic(tokens, topic)),
  );
}

function unsafeDirectInput(value: string) {
  const text = normalizedSafetyText(value);
  if (overrideAction.test(text) && sourceBoundary.test(text)) return true;
  if (
    (extractionAction.test(text) &&
      (sensitiveTarget.test(text) || qualifiedCredentialTarget.test(text))) ||
    (disclosureAction.test(text) &&
      (sensitiveTarget.test(text) || qualifiedCredentialTarget.test(text)))
  ) {
    return true;
  }
  if (
    citationAction.test(text) &&
    explicitUrl.test(text) &&
    /\b(?:answer|citation|official|source)\b/u.test(text)
  ) {
    return true;
  }
  if (fabricationAction.test(text) && truthBypass.test(text)) {
    return true;
  }
  if (
    authorityAction.test(text) &&
    requestSubject.test(text) &&
    privilegedAuthority.test(text)
  ) {
    return true;
  }
  if (
    accessAction.test(text) &&
    foreignScope.test(text) &&
    scopeTarget.test(text)
  ) {
    return true;
  }
  if (accessAction.test(text) && privatePublication.test(text)) return true;
  if (
    executableAction.test(text) &&
    (dangerousMarkup.test(text) ||
      (javascript.test(text) &&
        (exfiltrationAction.test(text) || protectedData.test(text))))
  ) {
    return true;
  }
  if (
    exfiltrationAction.test(text) &&
    protectedData.test(text) &&
    (explicitUrl.test(text) || /\b(?:elsewhere|external|outside)\b/u.test(text))
  ) {
    return true;
  }
  return false;
}

function unsafeRetrievedEvidence(value: string) {
  const text = normalizedSafetyText(value);
  if (overrideAction.test(text) && sourceBoundary.test(text)) return true;
  if (
    roleMarker.test(text) &&
    (overrideAction.test(text) || instructionAction.test(text))
  ) {
    return true;
  }
  if (modelDirection.test(text) && instructionAction.test(text)) return true;
  if (
    exfiltrationAction.test(text) &&
    protectedData.test(text) &&
    explicitUrl.test(text)
  ) {
    return true;
  }
  return false;
}

function retainedHistory(
  history: readonly AnswerGuardrailHistoryMessage[],
  policy: TopicPolicy | null,
) {
  const retained: AnswerGuardrailHistoryMessage[] = [];
  const allowedUserText: string[] = [];
  let retainCurrentTurn = false;

  for (const message of history) {
    if (message.role === "assistant") {
      if (retainCurrentTurn) retained.push(message);
      continue;
    }

    const unsafe = unsafeDirectInput(message.content);
    const denied = policy
      ? matchesAnyTopic([message.content], policy.deny)
      : false;
    const allowed =
      !policy ||
      policy.allow.length === 0 ||
      matchesAnyTopic([...allowedUserText, message.content], policy.allow);
    retainCurrentTurn = !unsafe && !denied && allowed;
    if (retainCurrentTurn) {
      retained.push(message);
      allowedUserText.push(message.content);
    }
  }

  return Object.freeze([...retained]);
}

export function createAnswerGuardrails(
  topicConfiguration?: string,
): AnswerGuardrails {
  const parsed = parsedTopicPolicy(topicConfiguration);
  return Object.freeze({
    evaluateEvidence(evidence: readonly AnswerGuardrailEvidence[]) {
      if (parsed.status === "invalid") return "unsafe-evidence";
      for (const item of evidence) {
        if (
          unsafeRetrievedEvidence(item.title) ||
          item.headingPath.some(unsafeRetrievedEvidence) ||
          unsafeRetrievedEvidence(item.evidenceText)
        ) {
          return "unsafe-evidence";
        }
      }
      return null;
    },
    evaluateInput({ history, question }) {
      if (parsed.status === "invalid") return "unsafe-request";
      const safeHistory = retainedHistory(history, parsed.policy);
      const allowContext = [
        ...safeHistory
          .filter(({ role }) => role === "user")
          .map(({ content }) => content),
        question,
      ];
      if (unsafeDirectInput(question)) return "unsafe-request";
      if (!parsed.policy) return null;
      if (matchesAnyTopic([question], parsed.policy.deny)) return "out-of-scope";
      if (
        parsed.policy.allow.length > 0 &&
        !matchesAnyTopic(allowContext, parsed.policy.allow)
      ) {
        return "out-of-scope";
      }
      return null;
    },
    generationHistory(history) {
      return retainedHistory(
        history,
        parsed.status === "ready" ? parsed.policy : null,
      );
    },
    status: parsed.status === "invalid" ? "unavailable" : "ready",
  });
}
