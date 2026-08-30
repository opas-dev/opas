// ABOUTME: Defines expiry-scoped storage operations for redacted answer analytics.
// ABOUTME: Keeps Postgres, Neon, SQLite, and D1 behavior behind one bounded contract.
import type {
  ConversationAnalyticsRecord,
  ConversationOutcome,
} from "@/outcomes/records";

export type ConversationAnalyticsReadScope = Readonly<{
  readAt: Date;
  retentionStartedAt: Date;
}>;

export type ConversationOutcomeUpdate = Readonly<{
  id: string;
  outcome: Extract<ConversationOutcome, "abandoned" | "escalated" | "low-rated">;
  reason: string | null;
  scope: ConversationAnalyticsReadScope;
  updatedAt: Date;
  workspaceId: string;
}>;

export type ConversationAnalyticsCleanup = Readonly<{
  limit: number;
  scope: ConversationAnalyticsReadScope;
  workspaceId: string;
}>;

export interface ConversationAnalyticsStore {
  cleanup(request: ConversationAnalyticsCleanup): Promise<number>;
  get(
    workspaceId: string,
    id: string,
    scope: ConversationAnalyticsReadScope,
  ): Promise<ConversationAnalyticsRecord | null>;
  list(
    workspaceId: string,
    scope: ConversationAnalyticsReadScope,
    limit: number,
  ): Promise<readonly ConversationAnalyticsRecord[]>;
  put(record: ConversationAnalyticsRecord): Promise<boolean>;
  updateOutcome(request: ConversationOutcomeUpdate): Promise<boolean>;
}
