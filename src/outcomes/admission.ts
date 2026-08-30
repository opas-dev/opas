// ABOUTME: Applies a durable workspace cap to public support-handoff side effects.
// ABOUTME: Keeps idempotent retries admissible without storing requester metadata.
import { normalizeConversationAnalyticsId } from "@/outcomes/records";

export const defaultDailyHandoffLimit = 100;
export const maximumDailyHandoffLimit = 1_000;

const rollingWindowMilliseconds = 24 * 60 * 60 * 1_000;
const reservationRetentionMilliseconds = 31 * 24 * 60 * 60 * 1_000;

export type PublicWriteReservation = Readonly<{
  createdAt: Date;
  expiresAt: Date;
  id: string;
  kind: "handoff";
  maximumWrites: number;
  windowStartedAt: Date;
  workspaceId: string;
}>;

export type PublicWriteReservationResult =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterAt: Date }>;

export interface PublicWriteAdmissionStore {
  cleanup(workspaceId: string, expiredAt: Date, limit: number): Promise<number>;
  reserve(
    reservation: PublicWriteReservation,
  ): Promise<PublicWriteReservationResult>;
}

export type PublicWriteAdmissionEnvironment = Readonly<{
  OPAS_HANDOFF_DAILY_LIMIT?: string;
}>;

export type HandoffWriteAllowance =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterSeconds: number }>;

function configuredLimit(value: string | undefined) {
  if (value === undefined) return defaultDailyHandoffLimit;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximumDailyHandoffLimit
    ? parsed
    : null;
}

function safeDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function createHandoffWriteAdmission(options: Readonly<{
  environment: PublicWriteAdmissionEnvironment;
  now?: () => Date;
  store: PublicWriteAdmissionStore;
  workspaceId: string;
}>) {
  const limit = configuredLimit(options.environment.OPAS_HANDOFF_DAILY_LIMIT);
  if (!limit || !options.workspaceId) {
    throw new Error("Public handoff admission is unavailable");
  }
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async reserve(idValue: unknown): Promise<HandoffWriteAllowance> {
      const id = normalizeConversationAnalyticsId(idValue);
      const createdAt = now();
      if (!id || !safeDate(createdAt)) {
        throw new Error("Public handoff admission is unavailable");
      }
      const result = await options.store.reserve({
        createdAt,
        expiresAt: new Date(createdAt.getTime() + reservationRetentionMilliseconds),
        id,
        kind: "handoff",
        maximumWrites: limit,
        windowStartedAt: new Date(createdAt.getTime() - rollingWindowMilliseconds),
        workspaceId: options.workspaceId,
      });
      if (result.accepted) return result;
      return Object.freeze({
        accepted: false as const,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((result.retryAfterAt.getTime() - createdAt.getTime()) / 1_000),
        ),
      });
    },
  });
}
