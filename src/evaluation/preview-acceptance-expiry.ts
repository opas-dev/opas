// ABOUTME: Moves one preview grant's expiry only inside a disposable acceptance database.
// ABOUTME: Keeps the native D1 operation workerd-safe and restores its immutable-grant guard atomically.

import { articlePreviewTokenContract } from "@/auth/preview-claims";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

export type PreviewAcceptanceExpiryResult = Readonly<{
  expiredAt: string;
  grantId: string;
  outcome: "expired";
}>;

export type PreviewAcceptanceExpiryRequest = Readonly<{
  checkedAt: Date;
  databaseName: string;
  expiredAt: Date;
  grantId: string;
  workspaceId: string;
}>;

const previewGrantTriggerName =
  "article_preview_grants_revocation_update_trigger";
const previewGrantTriggerSourceCandidate = sqliteTeamAuthoringGuardStatements.find(
  (statement) =>
    statement
      .trimStart()
      .startsWith(`create trigger \`${previewGrantTriggerName}\``),
);

if (!previewGrantTriggerSourceCandidate) {
  throw new Error("PREVIEW_EXPIRY_GUARD_SOURCE_MISSING");
}
const previewGrantTriggerSource: string = previewGrantTriggerSourceCandidate;

export function previewAcceptanceExpiryTimestamps(
  expiredAt: Date,
  checkedAt: Date,
) {
  const milliseconds = expiredAt.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isFinite(checkedAt.getTime()) ||
    milliseconds >= checkedAt.getTime()
  ) {
    throw new Error("PREVIEW_EXPIRY_TIME_INVALID");
  }
  return {
    createdAt: new Date(
      milliseconds - articlePreviewTokenContract.lifetimeSeconds * 1_000,
    ),
    expiredAt,
  };
}

export function previewAcceptanceExpiryResult(
  grantId: string,
  expiredAt: Date,
): PreviewAcceptanceExpiryResult {
  return Object.freeze({
    expiredAt: expiredAt.toISOString(),
    grantId,
    outcome: "expired",
  });
}

function changedRows(value: unknown) {
  if (
    value !== null &&
    typeof value === "object" &&
    "meta" in value &&
    value.meta !== null &&
    typeof value.meta === "object" &&
    "changes" in value.meta &&
    typeof value.meta.changes === "number"
  ) {
    return value.meta.changes;
  }
  throw new Error("PREVIEW_EXPIRY_D1_RESULT_INVALID");
}

export async function expireD1PreviewAcceptanceGrant(
  database: D1Database,
  request: PreviewAcceptanceExpiryRequest,
) {
  const timestamps = previewAcceptanceExpiryTimestamps(
    request.expiredAt,
    request.checkedAt,
  );
  const changed = await database.batch([
    database.prepare(`drop trigger \`${previewGrantTriggerName}\``),
    database
      .prepare(
        `update article_preview_grants
         set created_at = ?, expires_at = ?
         where id = ?
           and workspace_id = ?
           and revoked_at is null
           and expires_at > ?`,
      )
      .bind(
        timestamps.createdAt.getTime(),
        timestamps.expiredAt.getTime(),
        request.grantId,
        request.workspaceId,
        request.checkedAt.getTime(),
      ),
    database.prepare(previewGrantTriggerSource),
  ]);
  if (changedRows(changed[1]) !== 1) {
    throw new Error("PREVIEW_EXPIRY_ACTIVE_GRANT_NOT_FOUND");
  }
  return previewAcceptanceExpiryResult(request.grantId, timestamps.expiredAt);
}
