// ABOUTME: Applies the team-authoring baseline backfill through native Cloudflare D1 batches.
// ABOUTME: Keeps each 25-article chunk atomic and verifies the durable pause inside every batch.

import type { AnyD1Database } from "drizzle-orm/d1";

import {
  migrationRevisionActorLabel,
  teamAuthoringBackfillVersion,
  type TeamAuthoringBackfillCompletion,
  type TeamAuthoringBackfillInspection,
  type TeamAuthoringBackfillStore,
  type TeamAuthoringBaseline,
} from "@/db/team-authoring-backfill";
import {
  sqliteInsertTeamAuthoringHeadSql,
  sqliteInsertTeamAuthoringRevisionAssetSql,
  sqliteInsertTeamAuthoringRevisionSql,
  sqliteInsertTeamAuthoringSlugClaimSql,
  sqliteReadTeamAuthoringArticleChunkSql,
  sqliteReadTeamAuthoringMigrationRevisionChunkSql,
  sqliteTeamAuthoringGuardStatements,
  sqliteTeamAuthoringSourceArticles,
  sqliteTeamAuthoringStoredBaselines,
  type SqliteTeamAuthoringSourceRow,
  type SqliteTeamAuthoringStoredSourceRow,
} from "@/db/sqlite/team-authoring-backfill";

type D1Parameter = ArrayBuffer | ArrayBufferView | null | number | string;

function prepared(
  database: AnyD1Database,
  source: string,
  parameters: readonly D1Parameter[] = [],
) {
  return database.prepare(source).bind(...parameters);
}

function resultRows<T>(result: unknown): T[] {
  return result !== null &&
    typeof result === "object" &&
    "results" in result &&
    Array.isArray(result.results)
    ? (result.results as T[])
    : [];
}

async function inspect(
  database: AnyD1Database,
): Promise<TeamAuthoringBackfillInspection> {
  const results = await database.batch([
    prepared(
      database,
      "insert into team_authoring_pause_assertions (assertion) values (1)",
    ),
    prepared(
      database,
      `select
         workspaces.id as workspace_id,
         controls.writes_paused,
         migrations.version as completed_version,
         case when migrations.version is null then (
           select count(*) from articles where articles.workspace_id = workspaces.id
         ) else 0 end as pending_article_count
       from workspaces
       left join workspace_authoring_controls controls
         on controls.workspace_id = workspaces.id
       left join workspace_authoring_migrations migrations
         on migrations.workspace_id = workspaces.id and migrations.version = ?
       order by workspaces.id`,
      [teamAuthoringBackfillVersion],
    ),
    prepared(
      database,
      `select count(*) as count
       from sqlite_master
       where type = 'trigger'
         and name in (
           'article_heads_authoring_control_insert_trigger',
           'categories_current_revision_delete_trigger'
         )`,
    ),
  ]);
  const rows = resultRows<{
    completed_version: number | null;
    pending_article_count: number;
    workspace_id: string;
    writes_paused: number | null;
  }>(results[1]);
  if (rows.some((row) => row.writes_paused !== 1)) {
    throw new Error("AUTHORING_MIGRATION_REQUIRES_PAUSE");
  }
  const guard = resultRows<{ count: number }>(results[2])[0];
  return {
    completedWorkspaceIds: rows
      .filter((row) => row.completed_version === teamAuthoringBackfillVersion)
      .map((row) => row.workspace_id),
    guardsInstalled: guard?.count === 2,
    pendingArticleCount: rows.reduce(
      (count, row) => count + row.pending_article_count,
      0,
    ),
    workspaceIds: rows.map((row) => row.workspace_id),
  };
}

function baselineStatements(database: AnyD1Database, baseline: TeamAuthoringBaseline) {
  const article = baseline.article;
  const published = article.status === "published";
  return [
    prepared(database, sqliteInsertTeamAuthoringRevisionSql, [
      baseline.revisionId,
      article.workspaceId,
      article.articleId,
      article.categoryId,
      article.categorySlug,
      article.categoryName,
      article.slug,
      article.title,
      article.mdx,
      article.isFaq ? 1 : 0,
      article.authorName,
      article.position,
      baseline.revisionHash,
      migrationRevisionActorLabel,
      article.workspaceId,
      article.articleId,
    ]),
    ...article.assetIdsAndHashes.map(({ id }) =>
      prepared(database, sqliteInsertTeamAuthoringRevisionAssetSql, [
        article.workspaceId,
        article.articleId,
        baseline.revisionId,
        id,
      ]),
    ),
    prepared(database, sqliteInsertTeamAuthoringSlugClaimSql, [
      article.workspaceId,
      article.slug,
      article.articleId,
    ]),
    prepared(database, sqliteInsertTeamAuthoringHeadSql, [
      article.articleId,
      article.workspaceId,
      baseline.revisionId,
      article.slug,
      published ? baseline.revisionId : null,
      published ? 1 : null,
      published ? "published" : "editing",
    ]),
    prepared(
      database,
      `insert into team_authoring_backfill_assertions
         (workspace_id, article_id, revision_id, revision_hash)
       values (?, ?, ?, ?)`,
      [
        article.workspaceId,
        article.articleId,
        baseline.revisionId,
        baseline.revisionHash,
      ],
    ),
  ];
}

async function verifyAudit(
  database: AnyD1Database,
  rows: readonly TeamAuthoringBackfillCompletion[],
  requireBaselineProjection = true,
) {
  const checksPerWorkspace = requireBaselineProjection ? 2 : 1;
  const results = await database.batch([
    prepared(
      database,
      "insert into team_authoring_pause_assertions (assertion) values (1)",
    ),
    ...rows.flatMap((row) => [
      ...(requireBaselineProjection
        ? [
            prepared(
              database,
              `select
                 (select count(*) from articles where workspace_id = ?) as articles,
                 (select count(*) from article_heads where workspace_id = ?) as heads,
                 (select count(*) from article_revisions
                   where workspace_id = ? and revision_number = 1) as revisions,
                 (select count(*) from article_slug_claims
                   where workspace_id = ? and working_claim = 1 and article_row_claim = 1) as claims`,
              [row.workspaceId, row.workspaceId, row.workspaceId, row.workspaceId],
            ),
          ]
        : []),
      prepared(
        database,
        `select article_count, projection_hash
         from workspace_authoring_migrations
         where workspace_id = ? and version = ?`,
        [row.workspaceId, teamAuthoringBackfillVersion],
      ),
    ]),
    prepared(
      database,
      `select count(*) as count
       from articles
       left join article_heads
         on article_heads.article_id = articles.id
         and article_heads.workspace_id = articles.workspace_id
       where article_heads.article_id is null`,
    ),
    prepared(database, "pragma foreign_key_check"),
  ]);

  for (const [index, row] of rows.entries()) {
    const offset = 1 + index * checksPerWorkspace;
    if (requireBaselineProjection) {
      const counts = resultRows<{
        articles: number;
        claims: number;
        heads: number;
        revisions: number;
      }>(results[offset])[0];
      if (
        !counts ||
        counts.articles !== row.articleCount ||
        counts.heads !== row.articleCount ||
        counts.revisions !== row.articleCount ||
        counts.claims !== row.articleCount
      ) {
        throw new Error("AUTHORING_BACKFILL_AUDIT_FAILED");
      }
    }
    const ledger = resultRows<{
      article_count: number;
      projection_hash: string;
    }>(results[offset + (requireBaselineProjection ? 1 : 0)])[0];
    if (
      ledger &&
      (ledger.article_count !== row.articleCount ||
        ledger.projection_hash !== row.projectionHash)
    ) {
      throw new Error("AUTHORING_BACKFILL_LEDGER_MISMATCH");
    }
  }

  const missingIndex = 1 + rows.length * checksPerWorkspace;
  if (resultRows<{ count: number }>(results[missingIndex])[0]?.count !== 0) {
    throw new Error("AUTHORING_BACKFILL_MISSING_HEAD");
  }
  if (resultRows(results[missingIndex + 1]).length !== 0) {
    throw new Error("AUTHORING_BACKFILL_FOREIGN_KEY_FAILED");
  }
}

export function createD1TeamAuthoringBackfillStore(
  database: AnyD1Database,
): TeamAuthoringBackfillStore {
  return {
    async applyChunk(rows) {
      await database.batch([
        prepared(
          database,
          "insert into team_authoring_pause_assertions (assertion) values (1)",
        ),
        ...rows.flatMap((row) => baselineStatements(database, row)),
      ]);
    },
    async assertAllWorkspacesPaused() {
      return inspect(database);
    },
    async audit(rows) {
      await verifyAudit(database, rows);
    },
    async auditCompleted(rows) {
      await verifyAudit(database, rows, false);
    },
    async finalize(rows, installGuards) {
      await database.batch([
        prepared(
          database,
          "insert into team_authoring_pause_assertions (assertion) values (1)",
        ),
        ...rows.map((row) =>
          prepared(
            database,
            `insert into workspace_authoring_migrations
               (workspace_id, version, article_count, projection_hash, completed_at)
             values (?, ?, ?, ?, ?)
             on conflict (workspace_id, version) do nothing`,
            [
              row.workspaceId,
              row.version,
              row.articleCount,
              row.projectionHash,
              row.completedAt.getTime(),
            ],
          ),
        ),
        ...(installGuards
          ? sqliteTeamAuthoringGuardStatements.map((source) =>
              prepared(database, source),
            )
          : []),
      ]);
      await verifyAudit(database, rows, installGuards);
    },
    async readArticleChunk(cursor, limit) {
      const workspaceId = cursor?.workspaceId ?? null;
      const result = await prepared(database, sqliteReadTeamAuthoringArticleChunkSql, [
        workspaceId,
        workspaceId,
        workspaceId,
        cursor?.articleId ?? "",
        limit,
      ]).all<SqliteTeamAuthoringSourceRow>();
      return sqliteTeamAuthoringSourceArticles(resultRows(result));
    },
    async readMigrationRevisionChunk(cursor, limit) {
      const workspaceId = cursor?.workspaceId ?? null;
      const result = await prepared(
        database,
        sqliteReadTeamAuthoringMigrationRevisionChunkSql,
        [
          migrationRevisionActorLabel,
          workspaceId,
          workspaceId,
          workspaceId,
          cursor?.articleId ?? "",
          limit,
        ],
      ).all<SqliteTeamAuthoringStoredSourceRow>();
      return sqliteTeamAuthoringStoredBaselines(resultRows(result));
    },
    async verifyChunk(rows) {
      await database.batch([
        prepared(
          database,
          "insert into team_authoring_pause_assertions (assertion) values (1)",
        ),
        ...rows.map((row) =>
          prepared(
            database,
            `insert into team_authoring_backfill_assertions
               (workspace_id, article_id, revision_id, revision_hash)
             values (?, ?, ?, ?)`,
            [
              row.article.workspaceId,
              row.article.articleId,
              row.revisionId,
              row.revisionHash,
            ],
          ),
        ),
      ]);
    },
  };
}
