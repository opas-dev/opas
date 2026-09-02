// ABOUTME: Implements the OPAS repository for Postgres-compatible Drizzle databases.
// ABOUTME: Shares identical queries between Docker Postgres and Neon deployments.
import { and, asc, count, eq, gte, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { articleEventRetentionStart } from "@/analytics/records";
import {
  AssetValidationError,
  prepareAsset,
  prepareAssetSelection,
} from "@/db/assets";
import { validateArticleEvidence } from "@/db/evidence";
import { withAuthoringErrorBoundary } from "@/db/authoring-controls";
import type {
  ArticleAssetSelection,
  ArticleSubmission,
  KnowledgeImport,
  KnowledgeImportArticle,
  Repository,
} from "@/db/repository";
import { searchMissRetentionStart } from "@/db/search-misses";
import { createPostgresAnswerInferenceRepository } from "@/db/postgres/answer-inference-repository";
import {
  articleEvidenceCommitStatements,
  articleEvidenceInvalidationStatements,
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

function articleAttachmentStatements(
  article: ArticleSubmission,
  selection: ArticleAssetSelection,
  checkedAt: Date,
) {
  const { manifestId, hashes } = prepareAssetSelection(selection);
  const serializedHashes = JSON.stringify(hashes);
  const attachedAssets = sql`
    with requested(hash) as (
      select distinct value
      from jsonb_array_elements_text(${serializedHashes}::jsonb)
    ),
    allowed(asset_id, hash) as (
      select assets.id, assets.hash
      from assets
      inner join requested on requested.hash = assets.hash
      where assets.workspace_id = ${article.workspaceId}
        and (
          exists (
            select 1
            from article_assets
            where article_assets.article_id = ${article.id}
              and article_assets.workspace_id = ${article.workspaceId}
              and article_assets.asset_id = assets.id
          )
          or exists (
            select 1
            from asset_manifests
            inner join asset_manifest_items
              on asset_manifest_items.manifest_id = asset_manifests.id
             and asset_manifest_items.workspace_id = asset_manifests.workspace_id
            where asset_manifests.id = ${manifestId ?? null}
              and asset_manifests.workspace_id = ${article.workspaceId}
              and asset_manifests.expires_at > ${checkedAt}
              and asset_manifest_items.asset_id = assets.id
          )
        )
    ),
    attachment_rows(article_id, asset_id, workspace_id) as (
      select ${article.id}, allowed.asset_id, ${article.workspaceId}
      from allowed
      union all
      select ${article.id}, null::text, ${article.workspaceId}
      where not exists (
        select 1 from articles
        where articles.id = ${article.id}
          and articles.workspace_id = ${article.workspaceId}
      )
        or (select count(*) from requested) <> (select count(*) from allowed)
        or (
          ${manifestId ?? null}::text is not null
          and not exists (
            select 1 from asset_manifests
            where asset_manifests.id = ${manifestId ?? null}
              and asset_manifests.workspace_id = ${article.workspaceId}
              and asset_manifests.expires_at > ${checkedAt}
          )
        )
    )
    insert into article_assets (article_id, asset_id, workspace_id)
    select article_id, asset_id, workspace_id from attachment_rows
    on conflict do nothing
  `;
  const removedAssets = sql`
    with requested(hash) as (
      select distinct value
      from jsonb_array_elements_text(${serializedHashes}::jsonb)
    )
    delete from article_assets
    where article_id = ${article.id}
      and workspace_id = ${article.workspaceId}
      and not exists (
        select 1
        from assets
        inner join requested on requested.hash = assets.hash
        where assets.id = article_assets.asset_id
          and assets.workspace_id = article_assets.workspace_id
      )
  `;

  return [
    attachedAssets,
    removedAssets,
    ...(manifestId
      ? [
          sql`delete from asset_manifests where id = ${manifestId} and workspace_id = ${article.workspaceId}`,
        ]
      : []),
    orphanAssetCleanup(article.workspaceId),
  ];
}

function validImportManifestStatement(
  workspaceId: string,
  manifestId: string,
  checkedAt: Date,
) {
  return sql`
    insert into asset_manifest_items (manifest_id, asset_id, workspace_id)
    select null, null, ${workspaceId}
    where not exists (
      select 1
      from asset_manifests
      where id = ${manifestId}
        and workspace_id = ${workspaceId}
        and expires_at > ${checkedAt}
    )
  `;
}

function validImportCategoryStatement(
  workspaceId: string,
  categoryId: string,
) {
  return sql`
    insert into asset_manifest_items (manifest_id, asset_id, workspace_id)
    select null, null, ${workspaceId}
    where not exists (
      select 1
      from categories
      where id = ${categoryId}
        and workspace_id = ${workspaceId}
    )
  `;
}

function importArticleAttachmentStatement(
  workspaceId: string,
  manifestId: string,
  article: KnowledgeImportArticle,
  checkedAt: Date,
) {
  const { hashes } = prepareAssetSelection({ hashes: article.assetHashes });
  const serializedHashes = JSON.stringify(hashes);

  return sql`
    with requested(hash) as (
      select distinct value
      from jsonb_array_elements_text(${serializedHashes}::jsonb)
    ),
    allowed(asset_id, hash) as (
      select assets.id, assets.hash
      from assets
      inner join requested on requested.hash = assets.hash
      inner join asset_manifest_items
        on asset_manifest_items.asset_id = assets.id
       and asset_manifest_items.workspace_id = assets.workspace_id
      inner join asset_manifests
        on asset_manifests.id = asset_manifest_items.manifest_id
       and asset_manifests.workspace_id = asset_manifest_items.workspace_id
      where assets.workspace_id = ${workspaceId}
        and asset_manifests.id = ${manifestId}
        and asset_manifests.expires_at > ${checkedAt}
    ),
    attachment_rows(article_id, asset_id, workspace_id) as (
      select ${article.id}, allowed.asset_id, ${workspaceId}
      from allowed
      union all
      select null::text, null::text, ${workspaceId}
      where not exists (
        select 1
        from articles
        where id = ${article.id}
          and workspace_id = ${workspaceId}
      )
        or (select count(*) from requested) <> (select count(*) from allowed)
    )
    insert into article_assets (article_id, asset_id, workspace_id)
    select article_id, asset_id, workspace_id from attachment_rows
    on conflict do nothing
  `;
}

function knowledgeImportStatements(
  database: PostgresDatabase,
  knowledgeImport: KnowledgeImport,
  checkedAt: Date,
) {
  const { workspaceId, manifestId } = knowledgeImport;
  const statements: SQL[] = [
    validImportManifestStatement(workspaceId, manifestId, checkedAt),
  ];

  for (const category of knowledgeImport.categories) {
    statements.push(
      database
        .insert(categories)
        .values({ ...category, workspaceId })
        .getSQL(),
    );
  }

  for (const article of knowledgeImport.articles) {
    validateArticleEvidence(
      {
        id: article.id,
        workspaceId,
        categoryId: article.categoryId,
        slug: article.slug,
        title: article.title,
        mdx: article.mdx,
        status: article.status,
        isFaq: article.isFaq,
        authorName: article.authorName,
        position: article.position,
        publishedAt: article.publishedAt,
      },
      article.evidence,
    );
    statements.push(
      validImportCategoryStatement(workspaceId, article.categoryId),
      database
        .insert(articles)
        .values({
          id: article.id,
          workspaceId,
          categoryId: article.categoryId,
          slug: article.slug,
          title: article.title,
          mdx: article.mdx,
          contentHash: article.evidence?.articleContentHash ?? null,
          status: article.status,
          isFaq: article.isFaq,
          authorName: article.authorName,
          position: article.position,
          publishedAt: article.publishedAt,
        })
        .getSQL(),
      importArticleAttachmentStatement(
        workspaceId,
        manifestId,
        article,
        checkedAt,
      ),
    );
  }

  statements.push(
    ...articleEvidenceCommitStatements(
      database,
      knowledgeImport.articles.flatMap((article) =>
        article.evidence ? [article.evidence] : [],
      ),
      checkedAt,
    ),
  );

  statements.push(
    sql`delete from asset_manifests where id = ${manifestId} and workspace_id = ${workspaceId}`,
    orphanAssetCleanup(workspaceId),
  );
  return statements;
}

export function createPostgresRepository(database: PostgresDatabase): Repository {
  return withAuthoringErrorBoundary<Repository>({
    ...createPostgresAnswerInferenceRepository(database),
    ...createPostgresEvidenceRepository(database),
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
        .where(eq(categories.workspaceId, workspaceId))
        .orderBy(asc(categories.position), asc(categories.id));
    },

    async createCategory(category) {
      await database.insert(categories).values(category);
    },

    async updateCategory(category) {
      const updated = await database
        .update(categories)
        .set({
          slug: category.slug,
          name: category.name,
          description: category.description,
          position: category.position,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(categories.workspaceId, category.workspaceId),
            eq(categories.id, category.id),
            or(
              eq(categories.slug, category.slug),
              notExists(
                database
                  .select({ id: articles.id })
                  .from(articles)
                  .where(
                    and(
                      eq(articles.workspaceId, category.workspaceId),
                      eq(articles.categoryId, category.id),
                      eq(articles.status, "published"),
                      isNotNull(articles.contentHash),
                    ),
                  ),
              ),
            ),
          ),
        )
        .returning();
      return updated.length === 1;
    },

    async deleteCategory(workspaceId, id) {
      const deleted = await database
        .delete(categories)
        .where(
          and(
            eq(categories.workspaceId, workspaceId),
            eq(categories.id, id),
            notExists(
              database
                .select({ id: articles.id })
                .from(articles)
                .where(eq(articles.categoryId, id)),
            ),
          ),
        )
        .returning();
      return deleted.length === 1;
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

    async createArticle(article, assetSelection, evidence) {
      const changedAt = new Date();
      const manifestId = assetSelection?.manifestId;
      const insert = database
        .insert(articles)
        .values({
          ...article,
          contentHash: evidence?.articleContentHash ?? null,
          position: article.position ?? 0,
        });

      try {
        validateArticleEvidence(article, evidence);
        await executeAtomically(database, [
          insert.getSQL(),
          ...(assetSelection
            ? articleAttachmentStatements(article, assetSelection, changedAt)
            : []),
          ...(evidence
            ? articleEvidenceCommitStatements(database, [evidence], changedAt)
            : []),
        ]);
      } catch (error) {
        if (manifestId) {
          try {
            await executeAtomically(
              database,
              discardManifestStatements(article.workspaceId, manifestId),
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "The article save and staged asset cleanup both failed.",
            );
          }
        }
        throw error;
      }
    },

    async updateArticle(article, assetSelection, evidence) {
      const changedAt = new Date();
      const manifestId = assetSelection?.manifestId;
      const update = database
        .update(articles)
        .set({
          categoryId: article.categoryId,
          slug: article.slug,
          title: article.title,
          mdx: article.mdx,
          contentHash: evidence?.articleContentHash ?? null,
          status: article.status,
          isFaq: article.isFaq,
          authorName: article.authorName,
          position: article.position,
          publishedAt: article.publishedAt,
          updatedAt: changedAt,
        })
        .where(
          and(eq(articles.workspaceId, article.workspaceId), eq(articles.id, article.id)),
        );

      try {
        validateArticleEvidence(article, evidence);
        await executeAtomically(database, [
          ...(!evidence
            ? articleEvidenceInvalidationStatements(
                database,
                article.workspaceId,
                [article.id],
                changedAt,
              )
            : []),
          update.getSQL(),
          ...(assetSelection
            ? articleAttachmentStatements(article, assetSelection, changedAt)
            : []),
          ...(evidence
            ? articleEvidenceCommitStatements(database, [evidence], changedAt)
            : []),
        ]);
      } catch (error) {
        if (manifestId) {
          try {
            await executeAtomically(
              database,
              discardManifestStatements(article.workspaceId, manifestId),
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "The article save and staged asset cleanup both failed.",
            );
          }
        }
        throw error;
      }
    },

    async deleteArticle(workspaceId, id) {
      const deletedAt = new Date();
      await executeAtomically(database, [
        ...articleEvidenceInvalidationStatements(
          database,
          workspaceId,
          [id],
          deletedAt,
        ),
        sql`delete from articles where workspace_id = ${workspaceId} and id = ${id}`,
        orphanAssetCleanup(workspaceId),
      ]);
    },

    async createAssetManifest(workspaceId, expiresAt) {
      const createdAt = new Date();
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= createdAt) {
        throw new AssetValidationError("Asset manifests must expire in the future.");
      }

      const manifest = {
        id: `asset_manifest_${crypto.randomUUID()}`,
        workspaceId,
        expiresAt,
        createdAt,
      };
      await database.insert(assetManifests).values(manifest);
      return manifest;
    },

    async stageAsset(workspaceId, manifestId, upload) {
      const prepared = await prepareAsset(upload);
      const assetId = `asset_${crypto.randomUUID()}`;
      const checkedAt = new Date();
      const insert = database
        .insert(assets)
        .values({ id: assetId, workspaceId, ...prepared })
        .onConflictDoNothing({ target: [assets.workspaceId, assets.hash] });
      const attach = sql`
        with valid(manifest_id, asset_id, workspace_id) as (
          select asset_manifests.id, assets.id, asset_manifests.workspace_id
          from asset_manifests
          inner join assets on assets.workspace_id = asset_manifests.workspace_id
          where asset_manifests.id = ${manifestId}
            and asset_manifests.workspace_id = ${workspaceId}
            and asset_manifests.expires_at > ${checkedAt}
            and assets.hash = ${prepared.hash}
            and assets.media_type = ${prepared.mediaType}
            and assets.byte_size = ${prepared.byteSize}
        ),
        manifest_rows(manifest_id, asset_id, workspace_id) as (
          select manifest_id, asset_id, workspace_id from valid
          union all
          select null::text, null::text, ${workspaceId}
          where not exists (select 1 from valid)
        )
        insert into asset_manifest_items (manifest_id, asset_id, workspace_id)
        select manifest_id, asset_id, workspace_id from manifest_rows
        on conflict do nothing
      `;

      await executeAtomically(database, [insert.getSQL(), attach]);
      const asset = await this.getAsset(workspaceId, prepared.hash);
      if (!asset) {
        throw new Error("The staged asset could not be read after storage.");
      }
      return asset;
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

    async discardAssetManifest(workspaceId, manifestId) {
      await executeAtomically(
        database,
        discardManifestStatements(workspaceId, manifestId),
      );
    },

    async cleanupExpiredAssets(workspaceId, expiredAt) {
      await executeAtomically(database, [
        sql`delete from asset_manifests where workspace_id = ${workspaceId} and expires_at <= ${expiredAt}`,
        orphanAssetCleanup(workspaceId),
      ]);
    },

    async activateKnowledgeImport(knowledgeImport) {
      try {
        await executeAtomically(
          database,
          knowledgeImportStatements(database, knowledgeImport, new Date()),
        );
      } catch (error) {
        try {
          await executeAtomically(
            database,
            discardManifestStatements(
              knowledgeImport.workspaceId,
              knowledgeImport.manifestId,
            ),
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "The knowledge import and staged asset cleanup both failed.",
          );
        }
        throw error;
      }
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

    async updateTheme(theme) {
      await database
        .update(themes)
        .set({
          name: theme.name,
          config: theme.config,
          updatedAt: new Date(),
        })
        .where(eq(themes.workspaceId, theme.workspaceId));
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
