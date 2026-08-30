// ABOUTME: Coordinates server citation resolution, atomic deduplication, and handoff delivery.
// ABOUTME: Stores contact separately from support context before invoking an external destination.
import type { HandoffDelivery } from "@/handoff/delivery";
import { HandoffError } from "@/handoff/errors";
import {
  normalizeHandoffIdempotencyKey,
  normalizeHandoffPageUrl,
  normalizeHandoffSubmission,
  resolveHandoffPayload,
  type HandoffContact,
  type HandoffEvidence,
  type HandoffPayload,
} from "@/handoff/payload";

export type HandoffStorageStatus = "delivered" | "failed" | "pending";
export const handoffDeliveryTimeoutMilliseconds = 45_000;

export type HandoffStorageRecord = Readonly<{
  contact: HandoffContact;
  context: Omit<HandoffPayload, "contact">;
  createdAt: Date;
  id: string;
  payloadHash: string;
  status: HandoffStorageStatus;
  workspaceId: string;
}>;

export type HandoffReservation =
  | Readonly<{ state: "conflict" }>
  | Readonly<{ state: "duplicate"; status: HandoffStorageStatus }>
  | Readonly<{ state: "reserved" }>;

export interface HandoffStore {
  cleanup(workspaceId: string, createdBefore: Date, limit: number): Promise<number>;
  reserve(record: HandoffStorageRecord): Promise<HandoffReservation>;
  finish(request: Readonly<{
    finishedAt: Date;
    id: string;
    status: "delivered" | "failed";
    workspaceId: string;
  }>): Promise<void>;
}

export type HandoffSubmitRequest = Readonly<{
  idempotencyKey: string;
  reserveDelivery?: (id: string) => Promise<HandoffDeliveryAllowance>;
  signal?: AbortSignal;
  submission: unknown;
}>;

export type HandoffDeliveryAllowance =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterSeconds: number }>;

export type HandoffSubmitResult = Readonly<{
  status: "delivered" | "duplicate" | "pending";
}>;

export interface HandoffService {
  submit(request: HandoffSubmitRequest): Promise<HandoffSubmitResult>;
}

type HandoffServiceOptions = Readonly<{
  delivery: HandoffDelivery;
  deliveryTimeoutMilliseconds?: number;
  loadEvidence: () => Promise<readonly HandoffEvidence[]>;
  now?: () => Date;
  store: HandoffStore;
  trustedPageOrigins?: readonly string[];
  workspaceId: string;
}>;

type CanonicalValue =
  | boolean
  | number
  | string
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

function canonicalJson(value: CanonicalValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, CanonicalValue>)[key] as CanonicalValue,
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function payloadHash(payload: HandoffPayload) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(payload as CanonicalValue)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function safeTimestamp(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new HandoffError("configuration");
  }
  return new Date(value.getTime());
}

async function finishBestEffort(
  store: HandoffStore,
  request: Parameters<HandoffStore["finish"]>[0],
) {
  try {
    await store.finish(request);
  } catch {
    // A pending reservation still prevents a duplicate external side effect.
  }
}

function deliveryAttemptSignal(source: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new HandoffError(timedOut ? "delivery-failed" : "cancelled")),
      { once: true },
    );
  });
  if (source?.aborted) cancel();
  else source?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  return {
    aborted,
    close() {
      clearTimeout(timer);
      source?.removeEventListener("abort", cancel);
    },
    signal: controller.signal,
    timedOut: () => timedOut,
  };
}

export function createHandoffService(
  options: HandoffServiceOptions,
): HandoffService {
  if (
    !options.delivery ||
    typeof options.delivery.send !== "function" ||
    !options.store ||
    typeof options.store.reserve !== "function" ||
    typeof options.store.finish !== "function" ||
    typeof options.loadEvidence !== "function" ||
    typeof options.workspaceId !== "string" ||
    !options.workspaceId
  ) {
    throw new HandoffError("configuration");
  }
  const now = options.now ?? (() => new Date());
  const deliveryTimeout =
    options.deliveryTimeoutMilliseconds ?? handoffDeliveryTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(deliveryTimeout) ||
    deliveryTimeout < 1 ||
    deliveryTimeout >= 60_000
  ) {
    throw new HandoffError("configuration");
  }
  return Object.freeze({
    async submit(request: HandoffSubmitRequest) {
      if (request.signal?.aborted) throw new HandoffError("cancelled");
      const id = normalizeHandoffIdempotencyKey(request.idempotencyKey);
      const submission = normalizeHandoffSubmission(request.submission);
      const trustedPageOrigins = options.trustedPageOrigins ?? [
        (await import("@/site")).resolveSiteOrigin(),
        ...(await import("@/embed/config")).embedParentOrigins(),
      ];
      const trustedPageUrl = normalizeHandoffPageUrl(
        submission.pageUrl,
        trustedPageOrigins,
      );
      let evidence: readonly HandoffEvidence[];
      try {
        evidence = await options.loadEvidence();
      } catch {
        throw new HandoffError("unavailable");
      }
      if (request.signal?.aborted) throw new HandoffError("cancelled");
      const payload = resolveHandoffPayload(
        Object.freeze({ ...submission, pageUrl: trustedPageUrl }),
        evidence,
      );
      const createdAt = safeTimestamp(now());
      const hash = await payloadHash(payload);
      if (request.reserveDelivery) {
        let allowance: HandoffDeliveryAllowance;
        try {
          allowance = await request.reserveDelivery(id);
        } catch {
          throw new HandoffError("unavailable");
        }
        if (!allowance.accepted) {
          throw new HandoffError("rate-limited", allowance.retryAfterSeconds);
        }
      }
      const { contact, ...context } = payload;
      const record = Object.freeze({
        contact,
        context: Object.freeze(context),
        createdAt,
        id,
        payloadHash: hash,
        status: "pending" as const,
        workspaceId: options.workspaceId,
      });
      let reservation: HandoffReservation;
      try {
        reservation = await options.store.reserve(record);
      } catch {
        throw new HandoffError("unavailable");
      }
      if (reservation.state === "conflict") throw new HandoffError("conflict");
      if (reservation.state === "duplicate") {
        if (reservation.status === "failed") {
          throw new HandoffError("delivery-failed");
        }
        return Object.freeze({
          status:
            reservation.status === "delivered"
              ? ("duplicate" as const)
              : ("pending" as const),
        });
      }

      const attempt = deliveryAttemptSignal(request.signal, deliveryTimeout);
      try {
        await Promise.race([
          options.delivery.send({
            idempotencyKey: id,
            payload,
            signal: attempt.signal,
          }),
          attempt.aborted,
        ]);
      } catch (error) {
        await finishBestEffort(options.store, {
          finishedAt: safeTimestamp(now()),
          id,
          status: "failed",
          workspaceId: options.workspaceId,
        });
        if (attempt.timedOut()) throw new HandoffError("delivery-failed");
        if (error instanceof HandoffError) throw error;
        throw new HandoffError("delivery-failed");
      } finally {
        attempt.close();
      }
      await finishBestEffort(options.store, {
        finishedAt: safeTimestamp(now()),
        id,
        status: "delivered",
        workspaceId: options.workspaceId,
      });
      return Object.freeze({ status: "delivered" as const });
    },
  });
}
