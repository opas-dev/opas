// ABOUTME: Implements the bounded same-origin API boundary for support handoffs.
// ABOUTME: Returns only fixed statuses and errors while delegating trust to the handoff service.
import { HandoffError } from "@/handoff/errors";
import {
  consumeHandoffRequestAllowance,
  type HandoffRequestAllowance,
} from "@/handoff/gate";
import {
  maximumHandoffRequestUtf8Bytes,
  normalizeHandoffIdempotencyKey,
} from "@/handoff/payload";
import type { HandoffService } from "@/handoff/service";
import type { HandoffWriteAllowance } from "@/outcomes/admission";
import {
  recordConfiguredEscalation,
  reserveConfiguredHandoffWrite,
} from "@/outcomes/handoff";
import { outcomeFailureDetails } from "@/outcomes/public";

type HandoffRouteDependencies = Readonly<{
  consumeAllowance?: (request: Request) => Promise<HandoffRequestAllowance>;
  consumeDurableAllowance?: (id: string) => Promise<HandoffWriteAllowance>;
  createService?: () => Promise<HandoffService>;
  recordEscalation?: (id: string) => Promise<void>;
}>;

type RequestBody = Readonly<{ error: "invalid-request" | "payload-too-large" }> |
  Readonly<{ value: unknown }>;

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function response(body: unknown, status: number, headers?: Record<string, string>) {
  return Response.json(body, {
    headers: { ...responseHeaders, ...headers },
    status,
  });
}

function strictJsonContentType(value: string | null) {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

async function requestBody(request: Request): Promise<RequestBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) return { error: "invalid-request" };
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumHandoffRequestUtf8Bytes) {
      return { error: "payload-too-large" };
    }
  }
  if (!request.body) return { error: "invalid-request" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (request.signal.aborted) return { error: "invalid-request" };
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumHandoffRequestUtf8Bytes) {
        return { error: "payload-too-large" };
      }
      chunks.push(part.value);
    }
  } catch {
    return { error: "invalid-request" };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Request cleanup is best effort after an invalid body or disconnect.
    }
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { error: "invalid-request" };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: "invalid-request" };
  }
}

async function configuredService() {
  const { createConfiguredHandoffService } = await import("@/handoff/runtime");
  return createConfiguredHandoffService();
}

function errorResponse(error: unknown) {
  if (error instanceof HandoffError) {
    if (error.code === "invalid-input") {
      return response({ error: "invalid-request" }, 400);
    }
    if (error.code === "conflict") return response({ error: "conflict" }, 409);
    if (error.code === "cancelled") return response({ error: "cancelled" }, 499);
    if (error.code === "rate-limited" && error.retryAfterSeconds !== null) {
      return response({ error: "unavailable" }, 429, {
        "Retry-After": String(error.retryAfterSeconds),
      });
    }
  }
  return response({ error: "unavailable" }, 503);
}

export async function handleHandoffRequest(
  request: Request,
  dependencies: HandoffRouteDependencies = {},
) {
  if (request.method !== "POST") {
    return response({ error: "method-not-allowed" }, 405, { Allow: "POST" });
  }
  if (!strictJsonContentType(request.headers.get("content-type"))) {
    return response({ error: "unsupported-media-type" }, 415);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return response({ error: "invalid-request" }, 400);
  try {
    normalizeHandoffIdempotencyKey(idempotencyKey);
  } catch {
    return response({ error: "invalid-request" }, 400);
  }
  const body = await requestBody(request);
  if ("error" in body) {
    return response(
      { error: body.error },
      body.error === "payload-too-large" ? 413 : 400,
    );
  }
  let allowance: HandoffRequestAllowance;
  try {
    allowance = await (
      dependencies.consumeAllowance ?? consumeHandoffRequestAllowance
    )(request);
  } catch {
    return response({ error: "unavailable" }, 503);
  }
  if (!allowance.accepted) {
    return response({ error: "unavailable" }, 429, {
      "Retry-After": String(allowance.retryAfterSeconds),
    });
  }
  try {
    const service = await (dependencies.createService ?? configuredService)();
    const result = await service.submit({
      idempotencyKey,
      reserveDelivery:
        dependencies.consumeDurableAllowance ?? reserveConfiguredHandoffWrite,
      signal: request.signal,
      submission: body.value,
    });
    if (result.status !== "pending") {
      try {
        await (
          dependencies.recordEscalation ?? recordConfiguredEscalation
        )(idempotencyKey);
      } catch (error) {
        console.error(
          "Support escalation analytics persistence failed.",
          outcomeFailureDetails(error),
        );
      }
    }
    return response(result, result.status === "delivered" ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}
