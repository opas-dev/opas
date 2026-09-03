// ABOUTME: Enforces the bounded same-origin HTTP boundary for member-link acceptance.
// ABOUTME: Sets and clears only short-lived, deployment-scoped acceptance cookies.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  acceptMemberLink,
  exchangeMemberLink,
  resolveMemberAcceptance,
  type MemberAcceptanceConfiguration,
  type MemberAcceptanceInput,
} from "@/auth/member-acceptance";
import {
  memberLinkAcceptanceCookieName,
  memberLinkAcceptanceCookieOptions,
  type MemberLinkKind,
} from "@/auth/member-link-claims";
import type { MemberRepository } from "@/auth/member-repository";
import type { RandomBytes } from "@/auth/security-encoding";
import { resolveSiteOrigin } from "@/site";

const maximumExchangeBodyBytes = 256;
const maximumCompletionBodyBytes = 8 * 1_024;

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

export type MemberAcceptanceHttpDependencies = Readonly<{
  clock?: () => Date;
  configuration?: MemberAcceptanceConfiguration;
  randomBytes?: RandomBytes;
  repository?: MemberRepository;
  siteOrigin?: string;
}>;

class MemberAcceptanceRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("INVALID_MEMBER_ACCEPTANCE_REQUEST");
    this.name = "MemberAcceptanceRequestError";
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { headers: responseHeaders, status });
}

function strictJson(value: string | null) {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

function browserRequestIsSameOrigin(
  request: NextRequest,
  siteOrigin: string,
  requireOrigin: boolean,
) {
  let requestTargetsSite: boolean;
  try {
    const requestHost = request.headers.get("host");
    requestTargetsSite = requestHost
      ? requestHost.toLowerCase() === new URL(siteOrigin).host
      : new URL(request.url).origin === siteOrigin;
  } catch {
    return false;
  }
  return (
    requestTargetsSite &&
    (!requireOrigin || request.headers.get("origin") === siteOrigin) &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "cors" &&
    request.headers.get("sec-fetch-dest") === "empty"
  );
}

function declaredLength(value: string | null, maximumBytes: number) {
  if (value === null) return;
  if (!/^\d+$/u.test(value)) throw new MemberAcceptanceRequestError(400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
    throw new MemberAcceptanceRequestError(413);
  }
}

async function boundedText(request: NextRequest, maximumBytes: number) {
  declaredLength(request.headers.get("content-length"), maximumBytes);
  if (!request.body) throw new MemberAcceptanceRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new MemberAcceptanceRequestError(400);
      }
      total += result.value.byteLength;
      if (total > maximumBytes) throw new MemberAcceptanceRequestError(413);
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MemberAcceptanceRequestError(400);
  }
}

async function requestRecord(request: NextRequest, maximumBytes: number) {
  if (!strictJson(request.headers.get("content-type"))) {
    throw new MemberAcceptanceRequestError(415);
  }
  let value: unknown;
  try {
    value = JSON.parse(await boundedText(request, maximumBytes));
  } catch (error) {
    if (error instanceof MemberAcceptanceRequestError) throw error;
    throw new MemberAcceptanceRequestError(400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MemberAcceptanceRequestError(400);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(record).sort().join("\0") === [...expected].sort().join("\0");
}

async function dependencies(supplied: MemberAcceptanceHttpDependencies) {
  const configuration =
    supplied.configuration ??
    (await import("@/auth/config")).getAdminSessionConfig();
  const repository =
    supplied.repository ??
    (await (await import("@/auth/member-database")).getMemberRepository());
  return {
    configuration,
    repository,
    siteOrigin: supplied.siteOrigin ?? resolveSiteOrigin(),
  };
}

function cookieName(
  configuration: MemberAcceptanceConfiguration,
  kind: MemberLinkKind,
) {
  return memberLinkAcceptanceCookieName(configuration.deploymentId, kind);
}

function clearAcceptanceCookie(
  response: NextResponse,
  configuration: MemberAcceptanceConfiguration,
  kind: MemberLinkKind,
  now: Date,
) {
  response.cookies.set(
    cookieName(configuration, kind),
    "",
    memberLinkAcceptanceCookieOptions(new Date(0), now),
  );
  return response;
}

export async function handleMemberLinkExchange(
  request: NextRequest,
  kind: MemberLinkKind,
  supplied: MemberAcceptanceHttpDependencies = {},
) {
  let runtime;
  try {
    runtime = await dependencies(supplied);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!browserRequestIsSameOrigin(request, runtime.siteOrigin, true)) {
    return json({ error: "invalid-request" }, 403);
  }
  const now = supplied.clock?.() ?? new Date();
  try {
    const record = await requestRecord(request, maximumExchangeBodyBytes);
    if (!exactKeys(record, ["bearer"]) || typeof record.bearer !== "string") {
      throw new MemberAcceptanceRequestError(400);
    }
    const exchanged = await exchangeMemberLink(
      kind,
      record.bearer,
      runtime.configuration,
      {
        clock: () => now,
        repository: runtime.repository,
      },
    );
    if (!exchanged) {
      return clearAcceptanceCookie(
        json({ error: "invalid-link" }, 400),
        runtime.configuration,
        kind,
        now,
      );
    }
    const response = json({ outcome: "exchanged" });
    response.cookies.set(
      cookieName(runtime.configuration, kind),
      exchanged.acceptanceToken,
      memberLinkAcceptanceCookieOptions(exchanged.expiresAt, now),
    );
    return response;
  } catch (error) {
    if (error instanceof MemberAcceptanceRequestError) {
      return clearAcceptanceCookie(
        json({ error: "invalid-request" }, error.status),
        runtime.configuration,
        kind,
        now,
      );
    }
    return json({ error: "unavailable" }, 503);
  }
}

export async function handleMemberAcceptanceSession(
  request: NextRequest,
  kind: MemberLinkKind,
  supplied: MemberAcceptanceHttpDependencies = {},
) {
  let runtime;
  try {
    runtime = await dependencies(supplied);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!browserRequestIsSameOrigin(request, runtime.siteOrigin, false)) {
    return json({ error: "invalid-request" }, 403);
  }
  const now = supplied.clock?.() ?? new Date();
  try {
    const name = cookieName(runtime.configuration, kind);
    const session = await resolveMemberAcceptance(
      kind,
      request.cookies.get(name)?.value,
      runtime.configuration,
      { clock: () => now, repository: runtime.repository },
    );
    if (!session) {
      return clearAcceptanceCookie(
        json({ error: "invalid-link" }, 401),
        runtime.configuration,
        kind,
        now,
      );
    }
    return json({ acceptance: session.view });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

function completionInput(
  record: Record<string, unknown>,
  kind: MemberLinkKind,
): MemberAcceptanceInput {
  if (kind === "invite") {
    if (
      !exactKeys(record, ["displayName", "password"]) ||
      typeof record.displayName !== "string" ||
      typeof record.password !== "string"
    ) {
      throw new MemberAcceptanceRequestError(400);
    }
    return { displayName: record.displayName, kind, password: record.password };
  }
  if (!exactKeys(record, ["password"]) || typeof record.password !== "string") {
    throw new MemberAcceptanceRequestError(400);
  }
  return { kind, password: record.password };
}

export async function handleMemberAcceptanceCompletion(
  request: NextRequest,
  kind: MemberLinkKind,
  supplied: MemberAcceptanceHttpDependencies = {},
) {
  let runtime;
  try {
    runtime = await dependencies(supplied);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!browserRequestIsSameOrigin(request, runtime.siteOrigin, true)) {
    return json({ error: "invalid-request" }, 403);
  }
  try {
    const input = completionInput(
      await requestRecord(request, maximumCompletionBodyBytes),
      kind,
    );
    const name = cookieName(runtime.configuration, kind);
    const outcome = await acceptMemberLink(
      request.cookies.get(name)?.value,
      input,
      runtime.configuration,
      {
        clock: supplied.clock,
        randomBytes: supplied.randomBytes,
        repository: runtime.repository,
      },
    );
    if (outcome.outcome === "invalid_input") {
      return json({ error: "invalid-input", field: outcome.field }, 400);
    }
    const now = supplied.clock?.() ?? new Date();
    return clearAcceptanceCookie(
      outcome.outcome === "accepted"
        ? json({ outcome: "accepted" })
        : json({ error: "invalid-link" }, 401),
      runtime.configuration,
      kind,
      now,
    );
  } catch (error) {
    if (error instanceof MemberAcceptanceRequestError) {
      return json({ error: "invalid-request" }, error.status);
    }
    return json({ error: "unavailable" }, 503);
  }
}
