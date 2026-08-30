// ABOUTME: Defines bounded retention for explicit support-handoff contact and context records.
// ABOUTME: Keeps handoff deletion independent from redacted answer-analytics configuration.
export const defaultHandoffRetentionDays = 30;
export const maximumHandoffRetentionDays = 365;

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export type HandoffRetentionEnvironment = Readonly<{
  OPAS_HANDOFF_RETENTION_DAYS?: string;
}>;

export function configuredHandoffRetentionDays(
  environment: HandoffRetentionEnvironment,
) {
  const value = environment.OPAS_HANDOFF_RETENTION_DAYS;
  if (value === undefined) return defaultHandoffRetentionDays;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days <= maximumHandoffRetentionDays
    ? days
    : null;
}

export function handoffRetentionStartedAt(readAt: Date, retentionDays: number) {
  return new Date(readAt.getTime() - retentionDays * millisecondsPerDay);
}
