// ABOUTME: Persists revision-pinned preview grants on SQLite and Cloudflare D1.
// ABOUTME: Uses atomic batches for rotation and exact grant checks for every private read.

import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type {
  ActiveArticlePreviewGrant,
  ActiveArticlePreviewLookup,
  ArticlePreviewAsset,
  ArticlePreviewRepository,
  ArticlePreviewRevision,
  ArticlePreviewRevocationRequest,
  ArticlePreviewRotationRequest,
} from "@/auth/article-preview";
import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
  withAuthoringErrorBoundary,
} from "@/db/authoring-controls";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};
type SqliteDatabase = D1BackedDatabase | BetterSQLite3Database<typeof schema>;
type DatabaseRow = Readonly<Record<string, unknown>>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function d1Statement(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
}

function resultRows<T extends DatabaseRow>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
    ? (value.results as T[])
    : [];
}

async function transaction(database: SqliteDatabase, statements: readonly SQL[]) {
  if (isD1Database(database)) {
    return database.$client.batch(
      statements.map((statement) => d1Statement(database, statement)),
    );
  }
  return database.transaction((connection) =>
    statements.map((statement) => connection.run(statement)),
  );
}

function changedRows(value: unknown) {
  if (
    value !== null &&
    typeof value === "object" &&
    "changes" in value &&
    typeof value.changes === "number"
  ) {
    return value.changes;
  }
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
  throw new Error("Preview repository returned an invalid mutation result.");
}

async function rows(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    return resultRows<DatabaseRow>(await d1Statement(database, statement).all());
  }
  return database.all<DatabaseRow>(statement);
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Preview repository returned an invalid ${field}.`);
  }
  return value;
}

function date(value: unknown, field: string) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(parsed.getTime())) {
    throw new Error(`Preview repository returned an invalid ${field}.`);
  }
  return parsed;
}

function integer(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Preview repository returned an invalid ${field}.`);
  }
  return parsed;
}

function boolean(value: unknown, field: string) {
  if (value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  throw new Error(`Preview repository returned an invalid ${field}.`);
}

function bytes(value: unknown) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (
    Array.isArray(value) &&
    value.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw new Error("Preview repository returned invalid asset content.");
}

function mediaType(value: unknown): ArticlePreviewAsset["mediaType"] {
  if (
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  ) {
    return value;
  }
  throw new Error("Preview repository returned an invalid asset media type.");
}

function assetHashes(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Preview repository returned invalid revision assets.");
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
  ) {
    throw new Error("Preview repository returned invalid revision assets.");
  }
  return Object.freeze(parsed);
}

function grant(row: DatabaseRow): ActiveArticlePreviewGrant {
  return Object.freeze({
    articleId: text(row.articleId, "article ID"),
    createdAt: date(row.createdAt, "grant creation time"),
    createdByMemberId: text(row.createdByMemberId, "grant creator"),
    expiresAt: date(row.expiresAt, "grant expiry"),
    grantId: text(row.grantId, "grant ID"),
    revisionId: text(row.revisionId, "revision ID"),
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

function revision(row: DatabaseRow): ArticlePreviewRevision {
  return Object.freeze({
    ...grant(row),
    assetHashes: assetHashes(row.assetHashesJson),
    authorName: text(row.authorName, "author name"),
    categoryName: text(row.categoryName, "category name"),
    categorySlug: text(row.categorySlug, "category slug"),
    isFaq: boolean(row.isFaq, "FAQ flag"),
    mdx: text(row.mdx, "revision source"),
    position: integer(row.position, "position"),
    revisionNumber: integer(row.revisionNumber, "revision number"),
    revisionSavedAt: date(row.revisionSavedAt, "revision save time"),
    slug: text(row.slug, "article slug"),
    title: text(row.title, "article title"),
  });
}

function asset(row: DatabaseRow): ArticlePreviewAsset {
  const content = bytes(row.content);
  const byteSize = integer(row.byteSize, "asset byte size");
  if (content.byteLength !== byteSize) {
    throw new Error("Preview repository returned an inconsistent asset size.");
  }
  return Object.freeze({
    ...grant(row),
    byteSize,
    content,
    hash: text(row.hash, "asset hash"),
    mediaType: mediaType(row.mediaType),
  });
}

function sqliteAssertion(condition: SQL) {
  return sql`
    select json_extract('[]', case when ${condition} then '$[0]' else '$[' end)
  `;
}

function actorCondition(
  request: ArticlePreviewRotationRequest | ArticlePreviewRevocationRequest,
  checkedAt: Date,
) {
  return sql`exists (
    select 1
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${request.actor.workspaceId}
      and member.id = ${request.actor.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'editor', 'reviewer')
      and session.id = ${request.actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
  )`;
}

function actorAssertion(
  request: ArticlePreviewRotationRequest | ArticlePreviewRevocationRequest,
  checkedAt: Date,
) {
  return sqliteAssertion(actorCondition(request, checkedAt));
}

function revisionAssertion(request: ArticlePreviewRotationRequest) {
  return sqliteAssertion(sql`exists (
    select 1
    from article_revisions revision
    inner join article_heads head
      on head.workspace_id = revision.workspace_id
     and head.article_id = revision.article_id
    where revision.workspace_id = ${request.actor.workspaceId}
      and revision.id = ${request.revisionId}
      and head.archived_at is null
  )`);
}

function activeGrantWhere(request: ActiveArticlePreviewLookup) {
  return sql`
    preview_grant.id = ${request.grantId}
    and preview_grant.workspace_id = ${request.workspaceId}
    and preview_grant.revision_id = ${request.revisionId}
    and preview_grant.revoked_at is null
    and preview_grant.expires_at > ${request.checkedAt.getTime()}
    and creator.status = 'active'
    and head.archived_at is null
  `;
}

function activeGrantSelect() {
  return sql`
    preview_grant.id as grantId,
    preview_grant.workspace_id as workspaceId,
    preview_grant.revision_id as revisionId,
    preview_grant.created_by_member_id as createdByMemberId,
    preview_grant.created_at as createdAt,
    preview_grant.expires_at as expiresAt,
    revision.article_id as articleId
  `;
}

async function findActiveGrant(
  database: SqliteDatabase,
  request: ActiveArticlePreviewLookup,
) {
  const records = await rows(database, sql`
    select ${activeGrantSelect()}
    from article_preview_grants preview_grant
    inner join article_revisions revision
      on revision.workspace_id = preview_grant.workspace_id
     and revision.id = preview_grant.revision_id
    inner join article_heads head
      on head.workspace_id = revision.workspace_id
     and head.article_id = revision.article_id
    inner join workspace_members creator
      on creator.workspace_id = preview_grant.workspace_id
     and creator.id = preview_grant.created_by_member_id
    where ${activeGrantWhere(request)}
    limit 1
  `);
  return records[0] ? grant(records[0]) : null;
}

async function readActiveRevision(
  database: SqliteDatabase,
  request: ActiveArticlePreviewLookup,
) {
  const records = await rows(database, sql`
    select
      ${activeGrantSelect()},
      revision.revision_number as revisionNumber,
      revision.category_slug as categorySlug,
      revision.category_name as categoryName,
      revision.slug,
      revision.title,
      revision.mdx,
      revision.is_faq as isFaq,
      revision.author_name as authorName,
      revision.position,
      revision.created_at as revisionSavedAt,
      coalesce((
        select json_group_array(hash)
        from (
          select asset.hash as hash
          from article_revision_assets revision_asset
          inner join assets asset
            on asset.workspace_id = revision_asset.workspace_id
           and asset.id = revision_asset.asset_id
          where revision_asset.workspace_id = revision.workspace_id
            and revision_asset.revision_id = revision.id
          order by asset.hash
        ) sorted_assets
      ), '[]') as assetHashesJson
    from article_preview_grants preview_grant
    inner join article_revisions revision
      on revision.workspace_id = preview_grant.workspace_id
     and revision.id = preview_grant.revision_id
    inner join article_heads head
      on head.workspace_id = revision.workspace_id
     and head.article_id = revision.article_id
    inner join workspace_members creator
      on creator.workspace_id = preview_grant.workspace_id
     and creator.id = preview_grant.created_by_member_id
    where ${activeGrantWhere(request)}
    limit 1
  `);
  return records[0] ? revision(records[0]) : null;
}

async function readActiveAsset(
  database: SqliteDatabase,
  request: ActiveArticlePreviewLookup & Readonly<{ hash: string }>,
) {
  const records = await rows(database, sql`
    select
      ${activeGrantSelect()},
      asset.hash,
      asset.media_type as mediaType,
      asset.byte_size as byteSize,
      asset.content
    from article_preview_grants preview_grant
    inner join article_revisions revision
      on revision.workspace_id = preview_grant.workspace_id
     and revision.id = preview_grant.revision_id
    inner join article_heads head
      on head.workspace_id = revision.workspace_id
     and head.article_id = revision.article_id
    inner join workspace_members creator
      on creator.workspace_id = preview_grant.workspace_id
     and creator.id = preview_grant.created_by_member_id
    inner join article_revision_assets revision_asset
      on revision_asset.workspace_id = revision.workspace_id
     and revision_asset.revision_id = revision.id
    inner join assets asset
      on asset.workspace_id = revision_asset.workspace_id
     and asset.id = revision_asset.asset_id
     and asset.hash = ${request.hash}
    where ${activeGrantWhere(request)}
    limit 1
  `);
  return records[0] ? asset(records[0]) : null;
}

async function actorIsAuthorized(
  database: SqliteDatabase,
  request: ArticlePreviewRotationRequest | ArticlePreviewRevocationRequest,
  checkedAt: Date,
) {
  const records = await rows(database, sql`
    select member.id
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${request.actor.workspaceId}
      and member.id = ${request.actor.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'editor', 'reviewer')
      and session.id = ${request.actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
    limit 1
  `);
  return records.length === 1;
}

async function revisionState(
  database: SqliteDatabase,
  workspaceId: string,
  revisionId: string,
) {
  const records = await rows(database, sql`
    select head.archived_at as archivedAt
    from article_revisions revision
    inner join article_heads head
      on head.workspace_id = revision.workspace_id
     and head.article_id = revision.article_id
    where revision.workspace_id = ${workspaceId}
      and revision.id = ${revisionId}
    limit 1
  `);
  return records[0] ?? null;
}

async function grantIdExists(database: SqliteDatabase, grantId: string) {
  return (
    await rows(
      database,
      sql`select id from article_preview_grants where id = ${grantId} limit 1`,
    )
  ).length === 1;
}

async function authoringIsOpen(database: SqliteDatabase, workspaceId: string) {
  const records = await rows(database, sql`
    select writes_paused as writesPaused
    from workspace_authoring_controls
    where workspace_id = ${workspaceId}
    limit 1
  `);
  if (records[0]?.writesPaused !== 0) throw new AuthoringPausedError();
}

export function createSqliteArticlePreviewRepository(
  database: SqliteDatabase,
): ArticlePreviewRepository {
  return withAuthoringErrorBoundary<ArticlePreviewRepository>({
    findActiveGrant(request) {
      return findActiveGrant(database, request);
    },
    readActiveAsset(request) {
      return readActiveAsset(database, request);
    },
    readActiveRevision(request) {
      return readActiveRevision(database, request);
    },
    async revokeGrant(request) {
      try {
        const results = await transaction(database, [
          actorAssertion(request, request.revokedAt),
          sql`
            update article_preview_grants
            set revoked_at = ${request.revokedAt.getTime()},
                revoked_by_member_id = ${request.actor.memberId}
            where id = ${request.grantId}
              and workspace_id = ${request.actor.workspaceId}
              and revoked_at is null
          `,
        ]);
        return changedRows(results[1]) === 1
          ? { outcome: "revoked" }
          : { outcome: "rejected", code: "GRANT_NOT_FOUND" };
      } catch (error) {
        if (!(await actorIsAuthorized(database, request, request.revokedAt))) {
          return { outcome: "rejected", code: "ACTOR_FORBIDDEN" };
        }
        throw normalizeAuthoringError(error);
      }
    },
    async rotateGrant(request) {
      try {
        await transaction(database, [
          authoringAssertion(request.actor.workspaceId, "sqlite"),
          actorAssertion(request, request.createdAt),
          revisionAssertion(request),
          sql`
            update article_preview_grants
            set revoked_at = ${request.createdAt.getTime()},
                revoked_by_member_id = ${request.actor.memberId}
            where workspace_id = ${request.actor.workspaceId}
              and revision_id = ${request.revisionId}
              and revoked_at is null
          `,
          sql`
            insert into article_preview_grants (
              id, workspace_id, revision_id, created_by_member_id,
              expires_at, revoked_at, revoked_by_member_id, created_at
            ) values (
              ${request.grantId}, ${request.actor.workspaceId}, ${request.revisionId},
              ${request.actor.memberId}, ${request.expiresAt.getTime()}, null, null,
              ${request.createdAt.getTime()}
            )
          `,
        ]);
        return { outcome: "issued" };
      } catch (error) {
        const normalized = normalizeAuthoringError(error);
        if (normalized instanceof AuthoringPausedError) throw normalized;
        await authoringIsOpen(database, request.actor.workspaceId);
        if (!(await actorIsAuthorized(database, request, request.createdAt))) {
          return { outcome: "rejected", code: "ACTOR_FORBIDDEN" };
        }
        const state = await revisionState(
          database,
          request.actor.workspaceId,
          request.revisionId,
        );
        if (!state) return { outcome: "rejected", code: "REVISION_NOT_FOUND" };
        if (state.archivedAt !== null) {
          return { outcome: "rejected", code: "ARTICLE_ARCHIVED" };
        }
        if (await grantIdExists(database, request.grantId)) {
          return { outcome: "rejected", code: "GRANT_ID_COLLISION" };
        }
        throw error;
      }
    },
  });
}
