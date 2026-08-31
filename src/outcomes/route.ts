// ABOUTME: Validates bounded public low-rating and abandonment outcome updates.
// ABOUTME: Applies ephemeral abuse limits and returns only fixed privacy-safe responses.
import {
  consumeOutcomeWriteAllowance,
  type OutcomeWriteAllowance,
} from "@/outcomes/gate";
import {
  isConversationStreamActiveReason,
  normalizeConversationAnalyticsId,
} from "@/outcomes/records";
import {
  outcomeFailureDetails,
  recordConfiguredPublicOutcome,
} from "@/outcomes/public";

export const maximumOutcomeWriteBodyUtf8Bytes = 4_096;

type RouteDependencies = Readonly<{
  consumeAllowance?: (request: Request) => Promise<OutcomeWriteAllowance>;
  recordOutcome?: typeof recordConfiguredPublicOutcome;
  reportFailure?: (details: Readonly<{ type: string }>) => void;
}>;

const encoder = new TextEncoder();
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function response(body: unknown, status: number, headers?: HeadersInit) {
  return Response.json(body, {
    headers: { ...responseHeaders, ...Object.fromEntries(new Headers(headers)) },
    status,
  });
}

function strictJsonContentType(value: string | null) {
  return value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value);
}

async function boundedBody(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) return null;
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > maximumOutcomeWriteBodyUtf8Bytes) {
      return "too-large" as const;
    }
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumOutcomeWriteBodyUtf8Bytes) return "too-large" as const;
      chunks.push(part.value);
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Releasing a consumed or disconnected body is best effort.
    }
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function parsedPayload(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ("reason" in record
    ? ["conversationId", "outcome", "reason"]
    : ["conversationId", "outcome"]
  ).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    !normalizeConversationAnalyticsId(record.conversationId) ||
    (record.outcome !== "abandoned" && record.outcome !== "low-rated") ||
    (record.outcome === "abandoned" &&
      isConversationStreamActiveReason(record.reason)) ||
    ("reason" in record &&
      record.reason !== null &&
      (typeof record.reason !== "string" ||
        encoder.encode(record.reason).byteLength > 1_024 ||
        forbiddenControls.test(record.reason)))
  ) {
    return null;
  }
  return {
    conversationId: record.conversationId as string,
    outcome: record.outcome,
    reason: typeof record.reason === "string" ? record.reason : null,
  } as const;
}

export async function handlePublicOutcomeRequest(
  request: Request,
  dependencies: RouteDependencies = {},
) {
  if (request.method !== "POST") {
    return response({ error: "method-not-allowed" }, 405, { Allow: "POST" });
  }
  if (!strictJsonContentType(request.headers.get("content-type"))) {
    return response({ error: "unsupported-media-type" }, 415);
  }
  const body = await boundedBody(request);
  if (body === "too-large") return response({ error: "payload-too-large" }, 413);
  const payload = typeof body === "string" ? parsedPayload(body) : null;
  if (!payload) return response({ error: "invalid-request" }, 400);

  let allowance: OutcomeWriteAllowance;
  try {
    allowance = await (
      dependencies.consumeAllowance ?? consumeOutcomeWriteAllowance
    )(request);
  } catch {
    return response({ error: "unavailable" }, 503);
  }
  if (!allowance.accepted) {
    return response({ error: "rate-limited" }, 429, {
      "Retry-After": String(allowance.retryAfterSeconds),
    });
  }
  try {
    await (dependencies.recordOutcome ?? recordConfiguredPublicOutcome)(
      payload.conversationId,
      payload.outcome,
      payload.reason,
    );
    return response({ accepted: true }, 202);
  } catch (error) {
    (dependencies.reportFailure ?? ((details) => {
      console.error("Public outcome persistence failed.", details);
    }))(outcomeFailureDetails(error));
    return response({ error: "unavailable" }, 503);
  }
}
