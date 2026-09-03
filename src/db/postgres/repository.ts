// ABOUTME: Implements the OPAS repository for Postgres-compatible Drizzle databases.
// ABOUTME: Shares identical queries between Docker Postgres and Neon deployments.
import { and, asc, count, eq, exists, gte, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { articleEventRetentionStart } from "@/analytics/records";
import {
  AssetValidationError,
  prepareAsset,
} from "@/db/assets";
import { authoringAssertion, withAuthoringErrorBoundary } from "@/db/authoring-controls";
import type { AssetAuthoringRequest } from "@/db/repository";
import type { Repository } from "@/db/repository";
import { searchMissRetentionStart } from "@/db/search-misses";
import { createPostgresAnswerInferenceRepository } from "@/db/postgres/answer-inference-repository";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { createPostgresKnowledgeImportRepository } from "@/db/postgres/knowledge-import-repository";
import { createPostgresQualityAuthoringRepository } from "@/db/postgres/quality-authoring-repository";
import {
  createPostgresEvidenceRepository,
} from "@/db/postgres/evidence-repository";
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
} from "@/db/schema/postgres";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

function assetActorAssertion(request: AssetAuthoringRequest) {
  return sql`select 1 / count(*)::integer from workspace_members member
    inner join admin_sessions session on session.workspace_id = member.workspace_id and session.member_id = member.id
    where member.workspace_id = ${request.workspaceId} and member.id = ${request.memberId}
      and member.status = 'active' and member.role in ('administrator', 'editor')
      and session.id = ${request.sessionId} and session.revoked_at is null
      and session.expires_at > ${request.checkedAt}`;
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

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

async function executeAtomically(database: PostgresDatabase, statements: SQL[]) {
  if (statements.length === 0) {
    return;
  }

  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    await database.batch(queries as [Query, ...Query[]]);
    return;
  }

  await database.transaction(async (transaction) => {
    for (const statement of statements) {
      await transaction.execute(statement);
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

export function createPostgresRepository(
  database: PostgresDatabase,
  knowledgeImportClock: () => Date = () => new Date(),
): Repository {
  return withAuthoringErrorBoundary<Repository>({
    ...createPostgresAnswerInferenceRepository(database),
    ...createPostgresArticleDraftRepository(database),
    ...createPostgresEvidenceRepository(database),
    ...createPostgresKnowledgeImportRepository(database, knowledgeImportClock),
    ...createPostgresQualityAuthoringRepository(database),
    async checkHealth() {
      await database.execute(sql`select 1`);
    },

    async findPublishedArticle(workspaceId, slug) {
      const [article] = await database
        .select(publishedArticleFields)
        .from(articles)
        .where(
          and(
            eq(articles.workspaceId, workspaceId),
            eq(articles.slug, slug),
            eq(articles.status, "published"),
          ),
        )
        .limit(1);

      return article ?? null;
    },

    async listPublishedArticles(workspaceId) {
      return database
        .select(publishedArticleFields)
        .from(articles)
        .innerJoin(categories, eq(articles.categoryId, categories.id))
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.status, "published")))
        .orderBy(
          asc(categories.position),
          asc(categories.id),
          asc(articles.position),
          asc(articles.id),
        );
    },

    async listCategories(workspaceId) {
      return database
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
              database
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
        .orderBy(asc(categories.position), asc(categories.id));
    },

    async listArticles(workspaceId) {
      return database
        .select(articleFields)
        .from(articles)
        .innerJoin(categories, eq(articles.categoryId, categories.id))
        .where(eq(articles.workspaceId, workspaceId))
        .orderBy(
          asc(categories.position),
          asc(categories.id),
          asc(articles.position),
          asc(articles.id),
        );
    },

    async getArticle(workspaceId, id) {
      const [article] = await database
        .select(articleFields)
        .from(articles)
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.id, id)))
        .limit(1);

      return article ?? null;
    },

    async getAsset(workspaceId, hash) {
      const [asset] = await database
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
        .limit(1);

      return asset ? { ...asset, content: new Uint8Array(asset.content) } : null;
    },

    async getPublishedAsset(workspaceId, hash) {
      const [asset] = await database
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
      const rows = await database
        .select({ hash: assets.hash })
        .from(articleAssets)
        .innerJoin(assets, eq(articleAssets.assetId, assets.id))
        .where(
          and(
            eq(articleAssets.workspaceId, workspaceId),
            eq(articleAssets.articleId, articleId),
          ),
        )
        .orderBy(asc(assets.hash));
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
        authoringAssertion(request.workspaceId, "postgres"),
        assetActorAssertion(request),
        database.insert(assetManifests).values(manifest).getSQL(),
      ]);
      return manifest;
    },

    async stageAuthorizedAsset(request, manifestId, upload) {
      const prepared = await prepareAsset(upload);
      const insert = database
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
          and manifest.expires_at > ${request.checkedAt} and asset.hash = ${prepared.hash}
          and asset.media_type = ${prepared.mediaType} and asset.byte_size = ${prepared.byteSize}
      ), rows(manifest_id, asset_id, workspace_id) as (
        select * from valid union all select null::text, null::text, ${request.workspaceId}
        where not exists (select 1 from valid)
      ) insert into asset_manifest_items (manifest_id, asset_id, workspace_id)
        select * from rows on conflict do nothing`;
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "postgres"),
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
        authoringAssertion(request.workspaceId, "postgres"),
        assetActorAssertion(request),
        ...discardManifestStatements(request.workspaceId, manifestId),
      ]);
    },

    async cleanupAuthorizedExpiredAssets(request) {
      await executeAtomically(database, [
        authoringAssertion(request.workspaceId, "postgres"),
        assetActorAssertion(request),
        sql`delete from asset_manifests where workspace_id = ${request.workspaceId} and expires_at <= ${request.checkedAt}`,
        orphanAssetCleanup(request.workspaceId),
      ]);
    },

    async getTheme(workspaceId) {
      const [theme] = await database
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
        .limit(1);

      return theme ?? null;
    },

    async getAnalytics(workspaceId) {
      const now = new Date();
      const articleEventCutoff = articleEventRetentionStart(now);
      const searchMissCutoff = searchMissRetentionStart(now);
      const [articleRows, viewRows, feedbackRows, searchMissRows] = await Promise.all([
        database
          .select({
            articleId: articles.id,
            title: articles.title,
            status: articles.status,
          })
          .from(articles)
          .where(eq(articles.workspaceId, workspaceId)),
        database
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
          .groupBy(articleViews.articleId),
        database
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
          .groupBy(articleFeedback.articleId),
        database
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
          .groupBy(searchMisses.query),
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
      await database
        .delete(articleFeedback)
        .where(
          and(
            eq(articleFeedback.articleId, feedback.articleId),
            lt(articleFeedback.createdAt, articleEventRetentionStart(feedback.createdAt)),
          ),
        );
      await database
        .insert(articleFeedback)
        .values({
          id: feedback.id,
          articleId: feedback.articleId,
          helpful: feedback.helpful,
          comment: feedback.comment ?? null,
          createdAt: feedback.createdAt,
        })
        .onConflictDoNothing({
          target: articleFeedback.id,
        });
    },

    async recordView(view) {
      await database
        .delete(articleViews)
        .where(
          and(
            eq(articleViews.articleId, view.articleId),
            lt(articleViews.viewedAt, articleEventRetentionStart(view.viewedAt)),
          ),
        );
      await database.insert(articleViews).values(view).onConflictDoNothing({
        target: articleViews.id,
      });
    },

    async recordSearchMiss(miss) {
      await database
        .delete(searchMisses)
        .where(
          and(
            eq(searchMisses.workspaceId, miss.workspaceId),
            lt(searchMisses.createdAt, searchMissRetentionStart(miss.createdAt)),
          ),
        );
      await database.insert(searchMisses).values(miss).onConflictDoNothing({
        target: searchMisses.id,
      });
    },
  });
}
