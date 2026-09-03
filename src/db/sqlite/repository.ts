// ABOUTME: Implements the OPAS repository for injected SQLite-compatible D1 databases.
// ABOUTME: Normalizes D1 records to the same domain contract used by Postgres deployments.
import { and, asc, count, eq, exists, gte, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import { articleEventRetentionStart } from "@/analytics/records";
import {
  AssetValidationError,
  prepareAsset,
} from "@/db/assets";
import { authoringAssertion, withAuthoringErrorBoundary } from "@/db/authoring-controls";
import type { AssetAuthoringRequest } from "@/db/repository";
import type { Repository } from "@/db/repository";
import { searchMissRetentionStart } from "@/db/search-misses";
import { createSqliteAnswerInferenceRepository } from "@/db/sqlite/answer-inference-repository";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { createSqliteKnowledgeImportRepository } from "@/db/sqlite/knowledge-import-repository";
import { createSqliteQualityAuthoringRepository } from "@/db/sqlite/quality-authoring-repository";
import {
  createSqliteEvidenceRepository,
} from "@/db/sqlite/evidence-repository";
import {
  articleFeedback,
  articleAssets,
  articles,
  articleViews,
  assetManifests,
  assets,
  categories,
  searchMisses,
  themes,
} from "@/db/schema/sqlite";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

function assetActorAssertion(request: AssetAuthoringRequest) {
  return sql`select json_extract('[]', case when exists (
    select 1 from workspace_members member inner join admin_sessions session
      on session.workspace_id = member.workspace_id and session.member_id = member.id
    where member.workspace_id = ${request.workspaceId} and member.id = ${request.memberId}
      and member.status = 'active' and member.role in ('administrator', 'editor')
      and session.id = ${request.sessionId} and session.revoked_at is null
      and session.expires_at > ${request.checkedAt.getTime()}
  ) then '$[0]' else '$[' end)`;
}

const articleFields = {
  id: articles.id,
  workspaceId: articles.workspaceId,
  categoryId: articles.categoryId,
  slug: articles.slug,
  title: articles.title,
  mdx: articles.mdx,
  contentHash: articles.contentHash,
  status: articles.status,
  isFaq: articles.isFaq,
  authorName: articles.authorName,
  position: articles.position,
  publishedAt: articles.publishedAt,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
};

const publishedArticleFields = {
  id: articles.id,
  workspaceId: articles.workspaceId,
  categoryId: articles.categoryId,
  slug: articles.slug,
  title: articles.title,
  mdx: articles.mdx,
  isFaq: articles.isFaq,
  authorName: articles.authorName,
  position: articles.position,
  publishedAt: articles.publishedAt,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
};

function normalizeCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isD1Database(
  database: SqliteDatabase,
): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

async function executeAtomically(database: SqliteDatabase, statements: SQL[]) {
  if (statements.length === 0) {
    return;
  }

  if (isD1Database(database)) {
    const queries = statements.map((statement) => {
      const query = database.run(statement).getQuery();
      return database.$client.prepare(query.sql).bind(...query.params);
    });
    await database.$client.batch(queries);
    return;
  }

  database.transaction((transaction) => {
    for (const statement of statements) {
      transaction.run(statement);
    }
  });
}

function orphanAssetCleanup(workspaceId: string) {
  return sql`
    delete from assets
    where workspace_id = ${workspaceId}
      and not exists (
        select 1 from article_assets where article_assets.asset_id = assets.id
      )
      and not exists (
        select 1 from article_revision_assets where article_revision_assets.asset_id = assets.id
      )
      and not exists (
        select 1 from asset_manifest_items where asset_manifest_items.asset_id = assets.id
      )
  `;
}

function discardManifestStatements(workspaceId: string, manifestId: string) {
  return [
    sql`delete from asset_manifests where id = ${manifestId} and workspace_id = ${workspaceId}`,
    orphanAssetCleanup(workspaceId),
  ];
}

export function createSqliteRepository(
  database: SqliteDatabase,
  knowledgeImportClock: () => Date = () => new Date(),
): Repository {
  // Both drivers expose the same execute methods, but Drizzle drops them from its union type.
  const executableDatabase = database as DrizzleD1Database<typeof schema>;

  return withAuthoringErrorBoundary<Repository>({
    ...createSqliteAnswerInferenceRepository(database),
    ...createSqliteArticleDraftRepository(database),
    ...createSqliteEvidenceRepository(database),
    ...createSqliteKnowledgeImportRepository(database, knowledgeImportClock),
    ...createSqliteQualityAuthoringRepository(database),
    async checkHealth() {
      await executableDatabase.run(sql`select 1`);
    },

    async findPublishedArticle(workspaceId, slug) {
      const [article] = await executableDatabase
        .select(publishedArticleFields)
        .from(articles)
        .where(
          and(
            eq(articles.workspaceId, workspaceId),
            eq(articles.slug, slug),
            eq(articles.status, "published"),
          ),
        )
        .limit(1)
        .execute();

      return article ?? null;
    },

    async listPublishedArticles(workspaceId) {
      return executableDatabase
        .select(publishedArticleFields)
        .from(articles)
        .innerJoin(categories, eq(articles.categoryId, categories.id))
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.status, "published")))
        .orderBy(
          asc(categories.position),
          asc(categories.id),
          asc(articles.position),
          asc(articles.id),
        )
        .execute();
    },

    async listCategories(workspaceId) {
      return executableDatabase
        .select({
          id: categories.id,
          workspaceId: categories.workspaceId,
          slug: categories.slug,
          name: categories.name,
          description: categories.description,
          position: categories.position,
        })
        .from(categories)
        .where(
          and(
            eq(categories.workspaceId, workspaceId),
            exists(
              executableDatabase
                .select({ id: articles.id })
                .from(articles)
                .where(
                  and(
                    eq(articles.workspaceId, categories.workspaceId),
                    eq(articles.categoryId, categories.id),
                    eq(articles.status, "published"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(categories.position), asc(categories.id))
        .execute();
    },

    async listArticles(workspaceId) {
      return executableDatabase
        .select(articleFields)
        .from(articles)
        .innerJoin(categories, eq(articles.categoryId, categories.id))
        .where(eq(articles.workspaceId, workspaceId))
        .orderBy(
          asc(categories.position),
          asc(categories.id),
          asc(articles.position),
          asc(articles.id),
        )
        .execute();
    },

    async getArticle(workspaceId, id) {
      const [article] = await executableDatabase
        .select(articleFields)
        .from(articles)
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.id, id)))
        .limit(1)
        .execute();

      return article ?? null;
    },

    async getAsset(workspaceId, hash) {
      const [asset] = await executableDatabase
        .select({
          workspaceId: assets.workspaceId,
          hash: assets.hash,
          mediaType: assets.mediaType,
          byteSize: assets.byteSize,
          content: assets.content,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .where(and(eq(assets.workspaceId, workspaceId), eq(assets.hash, hash)))
        .limit(1)
        .execute();

      return asset ? { ...asset, content: new Uint8Array(asset.content) } : null;
    },

    async getPublishedAsset(workspaceId, hash) {
      const [asset] = await executableDatabase
        .select({
          workspaceId: assets.workspaceId,
          hash: assets.hash,
          mediaType: assets.mediaType,
          byteSize: assets.byteSize,
          content: assets.content,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .innerJoin(
          articleAssets,
          and(
            eq(articleAssets.assetId, assets.id),
            eq(articleAssets.workspaceId, assets.workspaceId),
          ),
        )
        .innerJoin(
          articles,
          and(
            eq(articles.id, articleAssets.articleId),
            eq(articles.workspaceId, articleAssets.workspaceId),
          ),
        )
        .where(
          and(
            eq(assets.workspaceId, workspaceId),
            eq(assets.hash, hash),
            eq(articles.status, "published"),
          ),
        )
        .limit(1);

      return asset ? { ...asset, content: new Uint8Array(asset.content) } : null;
    },

    async listArticleAssetHashes(workspaceId, articleId) {
      const rows = await executableDatabase
        .select({ hash: assets.hash })
        .from(articleAssets)
        .innerJoin(assets, eq(articleAssets.assetId, assets.id))
        .where(
          and(
            eq(articleAssets.workspaceId, workspaceId),
            eq(articleAssets.articleId, articleId),
          ),
        )
        .orderBy(asc(assets.hash))
        .execute();
      return rows.map(({ hash }) => hash);
    },

    async createAuthorizedAssetManifest(request, expiresAt) {
      const createdAt = request.checkedAt;
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= createdAt) {
        throw new AssetValidationError("Asset manifests must expire in the future.");
      }
      const manifest = {
        id: `asset_manifest_${crypto.randomUUID()}`,
        workspaceId: request.workspaceId,
        expiresAt,
        createdAt,
      };
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "sqlite"),
        assetActorAssertion(request),
        executableDatabase.insert(assetManifests).values(manifest).getSQL(),
      ]);
      return manifest;
    },

    async stageAuthorizedAsset(request, manifestId, upload) {
      const prepared = await prepareAsset(upload);
      const insert = executableDatabase
        .insert(assets)
        .values({
          id: `asset_${crypto.randomUUID()}`,
          workspaceId: request.workspaceId,
          ...prepared,
        })
        .onConflictDoNothing({ target: [assets.workspaceId, assets.hash] });
      const attach = sql`with valid(manifest_id, asset_id, workspace_id) as (
        select manifest.id, asset.id, manifest.workspace_id from asset_manifests manifest
        inner join assets asset on asset.workspace_id = manifest.workspace_id
        where manifest.id = ${manifestId} and manifest.workspace_id = ${request.workspaceId}
          and manifest.expires_at > ${request.checkedAt.getTime()} and asset.hash = ${prepared.hash}
          and asset.media_type = ${prepared.mediaType} and asset.byte_size = ${prepared.byteSize}
      ), rows(manifest_id, asset_id, workspace_id) as (
        select * from valid union all select null, null, ${request.workspaceId}
        where not exists (select 1 from valid)
      ) insert into asset_manifest_items (manifest_id, asset_id, workspace_id)
        select * from rows where true on conflict do nothing`;
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "sqlite"),
        assetActorAssertion(request),
        insert.getSQL(),
        attach,
      ]);
      const asset = await this.getAsset(request.workspaceId, prepared.hash);
      if (!asset) {
        throw new Error("The staged asset could not be read after storage.");
      }
      return asset;
    },

    async discardAuthorizedAssetManifest(request, manifestId) {
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "sqlite"),
        assetActorAssertion(request),
        ...discardManifestStatements(request.workspaceId, manifestId),
      ]);
    },

    async cleanupAuthorizedExpiredAssets(request) {
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "sqlite"),
        assetActorAssertion(request),
        sql`delete from asset_manifests where workspace_id = ${request.workspaceId} and expires_at <= ${request.checkedAt.getTime()}`,
        orphanAssetCleanup(request.workspaceId),
      ]);
    },

    async getTheme(workspaceId) {
      const [theme] = await executableDatabase
        .select({
          id: themes.id,
          workspaceId: themes.workspaceId,
          name: themes.name,
          config: themes.config,
          createdAt: themes.createdAt,
          updatedAt: themes.updatedAt,
        })
        .from(themes)
        .where(eq(themes.workspaceId, workspaceId))
        .limit(1)
        .execute();

      return theme ?? null;
    },

    async getAnalytics(workspaceId) {
      const now = new Date();
      const articleEventCutoff = articleEventRetentionStart(now);
      const searchMissCutoff = searchMissRetentionStart(now);
      const [articleRows, viewRows, feedbackRows, searchMissRows] = await Promise.all([
        executableDatabase
          .select({
            articleId: articles.id,
            title: articles.title,
            status: articles.status,
          })
          .from(articles)
          .where(eq(articles.workspaceId, workspaceId))
          .execute(),
        executableDatabase
          .select({
            articleId: articleViews.articleId,
            views: count(articleViews.id),
          })
          .from(articleViews)
          .innerJoin(articles, eq(articleViews.articleId, articles.id))
          .where(
            and(
              eq(articles.workspaceId, workspaceId),
              gte(articleViews.viewedAt, articleEventCutoff),
            ),
          )
          .groupBy(articleViews.articleId)
          .execute(),
        executableDatabase
          .select({
            articleId: articleFeedback.articleId,
            feedbackCount: count(articleFeedback.id),
            helpfulCount:
              sql<number>`sum(case when ${articleFeedback.helpful} then 1 else 0 end)`.mapWith(
                Number,
              ),
          })
          .from(articleFeedback)
          .innerJoin(articles, eq(articleFeedback.articleId, articles.id))
          .where(
            and(
              eq(articles.workspaceId, workspaceId),
              gte(articleFeedback.createdAt, articleEventCutoff),
            ),
          )
          .groupBy(articleFeedback.articleId)
          .execute(),
        executableDatabase
          .select({
            query: searchMisses.query,
            count: count(searchMisses.id),
          })
          .from(searchMisses)
          .where(
            and(
              eq(searchMisses.workspaceId, workspaceId),
              gte(searchMisses.createdAt, searchMissCutoff),
            ),
          )
          .groupBy(searchMisses.query)
          .execute(),
      ]);

      const viewsByArticleId = new Map(
        viewRows.map((row) => [row.articleId, normalizeCount(row.views)]),
      );
      const feedbackByArticleId = new Map(
        feedbackRows.map((row) => [
          row.articleId,
          {
            feedbackCount: normalizeCount(row.feedbackCount),
            helpfulCount: normalizeCount(row.helpfulCount),
          },
        ]),
      );
      const articleAnalytics = articleRows
        .map((article) => ({
          ...article,
          views: viewsByArticleId.get(article.articleId) ?? 0,
          feedbackCount:
            feedbackByArticleId.get(article.articleId)?.feedbackCount ?? 0,
          helpfulCount: feedbackByArticleId.get(article.articleId)?.helpfulCount ?? 0,
        }))
        .sort(
          (left, right) =>
            right.views - left.views ||
            compareText(left.title, right.title) ||
            compareText(left.articleId, right.articleId),
        );
      const topSearchMisses = searchMissRows
        .map((miss) => ({ query: miss.query, count: normalizeCount(miss.count) }))
        .sort(
          (left, right) =>
            right.count - left.count || compareText(left.query, right.query),
        )
        .slice(0, 10);

      return { articles: articleAnalytics, searchMisses: topSearchMisses };
    },

    async createFeedback(feedback) {
      await executableDatabase
        .delete(articleFeedback)
        .where(
          and(
            eq(articleFeedback.articleId, feedback.articleId),
            lt(articleFeedback.createdAt, articleEventRetentionStart(feedback.createdAt)),
          ),
        )
        .execute();
      await executableDatabase
        .insert(articleFeedback)
        .values({
          id: feedback.id,
          articleId: feedback.articleId,
          helpful: feedback.helpful,
          comment: feedback.comment ?? null,
          createdAt: feedback.createdAt,
        })
        .onConflictDoNothing({ target: articleFeedback.id })
        .execute();
    },

    async recordView(view) {
      await executableDatabase
        .delete(articleViews)
        .where(
          and(
            eq(articleViews.articleId, view.articleId),
            lt(articleViews.viewedAt, articleEventRetentionStart(view.viewedAt)),
          ),
        )
        .execute();
      await executableDatabase
        .insert(articleViews)
        .values(view)
        .onConflictDoNothing({ target: articleViews.id })
        .execute();
    },

    async recordSearchMiss(miss) {
      await executableDatabase
        .delete(searchMisses)
        .where(
          and(
            eq(searchMisses.workspaceId, miss.workspaceId),
            lt(searchMisses.createdAt, searchMissRetentionStart(miss.createdAt)),
          ),
        )
        .execute();
      await executableDatabase
        .insert(searchMisses)
        .values(miss)
        .onConflictDoNothing({ target: searchMisses.id })
        .execute();
    },
  });
}
