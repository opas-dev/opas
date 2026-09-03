// ABOUTME: Persists private article drafts and immutable revisions on SQLite and D1.
// ABOUTME: Serializes authorization, category, head, slug, and asset checks with each write.
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import { articleRevisionHash, type ArticleRevisionSnapshot } from "@/content/article-revision";
import { prepareAssetSelection } from "@/db/assets";
import {
  draftChangeSummary,
  draftRepositoryClock,
  draftRepositoryRevisionId,
  type ArticleDraftRepository,
  type ArticleDraftRepositoryOptions,
  type CreateDraftArticleRequest,
  type DraftWriteResult,
  type SaveDraftArticleRequest,
} from "@/db/article-drafts";
import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
  withAuthoringErrorBoundary,
} from "@/db/authoring-controls";
import {
  adminSessions,
  articleHeads,
  articleRevisionAssets,
  articleRevisions,
  articleSlugClaims,
  articles,
  assetManifestItems,
  assetManifests,
  assets,
  categories,
  workspaceAuthoringControls,
  workspaceMembers,
} from "@/db/schema/sqlite";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

type CategorySnapshot = {
  id: string;
  slug: string;
  name: string;
};

type CurrentDraft = {
  articleSlug: string;
  articleStatus: "draft" | "published";
  archivedAt: Date | null;
  publishedRevisionId: string | null;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
  reviewState: "editing" | "in_review" | "changes_requested" | "approved" | "published";
  workingSlug: string;
};

function isEditableState(state: CurrentDraft["reviewState"]) {
  return state !== "in_review";
}

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

async function executeAtomically(database: SqliteDatabase, statements: SQL[]) {
  if (isD1Database(database)) {
    const queries = statements.map((statement) => {
      const query = database.run(statement).getQuery();
      return database.$client.prepare(query.sql).bind(...query.params);
    });
    await database.$client.batch(queries);
    return;
  }

  database.transaction((transaction) => {
    for (const statement of statements) transaction.run(statement);
  });
}

function snapshot(
  request: CreateDraftArticleRequest | SaveDraftArticleRequest,
  category: CategorySnapshot,
  assetHashes: readonly string[],
): ArticleRevisionSnapshot {
  return {
    workspaceId: request.article.workspaceId,
    articleId: request.article.id,
    categoryId: category.id,
    categorySlug: category.slug,
    categoryName: category.name,
    slug: request.article.slug,
    title: request.article.title,
    mdx: request.article.mdx,
    isFaq: request.article.isFaq,
    authorName: request.article.authorName,
    position: request.article.position,
    assetHashes,
  };
}

function sqliteAssertion(condition: SQL) {
  return sql`
    select json_extract('[]', case when ${condition} then '$[0]' else '$[' end)
  `;
}

function actorAssertion(
  request: CreateDraftArticleRequest | SaveDraftArticleRequest,
  checkedAt: Date,
) {
  return sqliteAssertion(sql`exists (
    select 1
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
      and session.member_id = member.id
    where member.workspace_id = ${request.article.workspaceId}
      and member.id = ${request.actor.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'editor')
      and session.id = ${request.actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
  )`);
}

function categoryAssertion(workspaceId: string, category: CategorySnapshot) {
  return sqliteAssertion(sql`exists (
    select 1 from categories category
    where category.workspace_id = ${workspaceId}
      and category.id = ${category.id}
      and category.slug = ${category.slug}
      and category.name = ${category.name}
  )`);
}

function currentHeadAssertion(request: SaveDraftArticleRequest, state: CurrentDraft) {
  return sqliteAssertion(sql`exists (
    select 1 from article_heads head
    where head.workspace_id = ${request.article.workspaceId}
      and head.article_id = ${request.article.id}
      and head.working_revision_id = ${state.revisionId}
      and head.working_revision_number = ${request.expectedWorkingRevisionNumber}
      and head.review_state = ${state.reviewState}
      and head.archived_at is null
      and head.review_state in ('editing', 'changes_requested', 'approved', 'published')
  )`);
}

function slugAssertion(
  workspaceId: string,
  articleId: string,
  slug: string,
  creating: boolean,
) {
  return sqliteAssertion(sql`
    not exists (
      select 1 from article_slug_claims
      where workspace_id = ${workspaceId}
        and normalized_slug = ${slug}
        and article_id <> ${articleId}
    )
    and not exists (
      select 1 from articles
      where workspace_id = ${workspaceId}
        and slug = ${slug}
        and id <> ${articleId}
    )
    and (${creating ? 1 : 0} = 0 or not exists (
      select 1 from articles
      where workspace_id = ${workspaceId} and id = ${articleId}
    ))
  `);
}

function assetAvailabilityCondition(
  workspaceId: string,
  manifestId: string | undefined,
  currentRevisionId: string | null,
  checkedAt: Date,
) {
  return sql`
    exists (
      select 1
      from article_revision_assets revision_asset
      where revision_asset.workspace_id = ${workspaceId}
        and revision_asset.revision_id = ${currentRevisionId}
        and revision_asset.asset_id = asset.id
    )
    or exists (
      select 1
      from asset_manifests manifest
      inner join asset_manifest_items manifest_item
        on manifest_item.workspace_id = manifest.workspace_id
        and manifest_item.manifest_id = manifest.id
      where manifest.workspace_id = ${workspaceId}
        and manifest.id = ${manifestId ?? null}
        and manifest.expires_at > ${checkedAt.getTime()}
        and manifest_item.asset_id = asset.id
    )
  `;
}

function assetAssertion(
  workspaceId: string,
  hashes: readonly string[],
  manifestId: string | undefined,
  currentRevisionId: string | null,
  checkedAt: Date,
) {
  const serializedHashes = JSON.stringify(hashes);
  return sqliteAssertion(sql`
    (select count(*) from json_each(${serializedHashes})) = (
      select count(*)
      from assets asset
      inner join json_each(${serializedHashes}) requested
        on requested.value = asset.hash
      where asset.workspace_id = ${workspaceId}
        and (${assetAvailabilityCondition(
          workspaceId,
          manifestId,
          currentRevisionId,
          checkedAt,
        )})
    )
    and (${manifestId ?? null} is null or exists (
      select 1 from asset_manifests
      where workspace_id = ${workspaceId}
        and id = ${manifestId ?? null}
        and expires_at > ${checkedAt.getTime()}
    ))
  `);
}

function upsertSlugClaim(
  workspaceId: string,
  articleId: string,
  slug: string,
  articleRowClaim: boolean,
) {
  return sql`
    insert into article_slug_claims (
      workspace_id, normalized_slug, article_id, working_claim, article_row_claim
    ) values (${workspaceId}, ${slug}, ${articleId}, 1, ${articleRowClaim ? 1 : 0})
    on conflict (workspace_id, normalized_slug) do update set
      working_claim = case
        when article_slug_claims.article_id = excluded.article_id then 1
        else article_slug_claims.working_claim
      end,
      article_row_claim = case
        when article_slug_claims.article_id = excluded.article_id
          then max(article_slug_claims.article_row_claim, excluded.article_row_claim)
        else article_slug_claims.article_row_claim
      end
  `;
}

function revisionInsert(
  request: CreateDraftArticleRequest | SaveDraftArticleRequest,
  category: CategorySnapshot,
  revisionId: string,
  revisionNumber: number,
  revisionHash: string,
  changedAt: Date,
) {
  return sql`
    insert into article_revisions (
      id, workspace_id, article_id, revision_number, category_id, category_slug,
      category_name, slug, title, mdx, is_faq, author_name, position,
      revision_hash, change_kind, created_by_member_id, created_by_system_label,
      change_summary, created_at, restored_from_revision_id
    ) values (
      ${revisionId}, ${request.article.workspaceId}, ${request.article.id},
      ${revisionNumber}, ${category.id}, ${category.slug}, ${category.name},
      ${request.article.slug}, ${request.article.title}, ${request.article.mdx},
      ${request.article.isFaq ? 1 : 0}, ${request.article.authorName},
      ${request.article.position}, ${revisionHash}, ${request.changeKind},
      ${request.actor.memberId}, null, ${draftChangeSummary(request.changeSummary)},
      ${changedAt.getTime()}, null
    )
  `;
}

function revisionAssetInsert(
  workspaceId: string,
  articleId: string,
  revisionId: string,
  revisionNumber: number,
  hashes: readonly string[],
  manifestId: string | undefined,
  currentRevisionId: string | null,
  checkedAt: Date,
) {
  const serializedHashes = JSON.stringify(hashes);
  return sql`
    insert into article_revision_assets (
      workspace_id, article_id, revision_id, revision_number, asset_id
    )
    select ${workspaceId}, ${articleId}, ${revisionId}, ${revisionNumber}, asset.id
    from assets asset
    inner join json_each(${serializedHashes}) requested on requested.value = asset.hash
    where asset.workspace_id = ${workspaceId}
      and (${assetAvailabilityCondition(
        workspaceId,
        manifestId,
        currentRevisionId,
        checkedAt,
      )})
  `;
}

function consumeManifestAndOrphans(
  workspaceId: string,
  manifestId: string | undefined,
) {
  return [
    ...(manifestId
      ? [
          sql`delete from asset_manifests where workspace_id = ${workspaceId} and id = ${manifestId}`,
        ]
      : []),
    sql`
      delete from assets
      where workspace_id = ${workspaceId}
        and not exists (select 1 from article_assets where asset_id = assets.id)
        and not exists (select 1 from article_revision_assets where asset_id = assets.id)
        and not exists (select 1 from asset_manifest_items where asset_id = assets.id)
    `,
  ];
}

function executable(database: SqliteDatabase) {
  return database as DrizzleD1Database<typeof schema>;
}

async function actorIsAuthorized(
  database: SqliteDatabase,
  request: CreateDraftArticleRequest | SaveDraftArticleRequest,
  checkedAt: Date,
) {
  const [actor] = await executable(database)
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(
      adminSessions,
      and(
        eq(adminSessions.workspaceId, workspaceMembers.workspaceId),
        eq(adminSessions.memberId, workspaceMembers.id),
      ),
    )
    .where(
      and(
        eq(workspaceMembers.workspaceId, request.article.workspaceId),
        eq(workspaceMembers.id, request.actor.memberId),
        eq(workspaceMembers.status, "active"),
        or(
          eq(workspaceMembers.role, "administrator"),
          eq(workspaceMembers.role, "editor"),
        ),
        eq(adminSessions.id, request.actor.sessionId),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, checkedAt),
      ),
    )
    .limit(1)
    .execute();
  return actor !== undefined;
}

async function authoringIsOpen(database: SqliteDatabase, workspaceId: string) {
  const [control] = await executable(database)
    .select({ writesPaused: workspaceAuthoringControls.writesPaused })
    .from(workspaceAuthoringControls)
    .where(eq(workspaceAuthoringControls.workspaceId, workspaceId))
    .limit(1)
    .execute();
  if (!control || control.writesPaused) throw new AuthoringPausedError();
}

async function readCategory(
  database: SqliteDatabase,
  workspaceId: string,
  categoryId: string,
) {
  const [category] = await executable(database)
    .select({ id: categories.id, slug: categories.slug, name: categories.name })
    .from(categories)
    .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
    .limit(1)
    .execute();
  return category ?? null;
}

async function readCurrentDraft(
  database: SqliteDatabase,
  workspaceId: string,
  articleId: string,
): Promise<CurrentDraft | null> {
  const [state] = await executable(database)
    .select({
      articleSlug: articles.slug,
      articleStatus: articles.status,
      archivedAt: articleHeads.archivedAt,
      publishedRevisionId: articleHeads.publishedRevisionId,
      revisionHash: articleRevisions.revisionHash,
      revisionId: articleHeads.workingRevisionId,
      revisionNumber: articleHeads.workingRevisionNumber,
      reviewState: articleHeads.reviewState,
      workingSlug: articleHeads.workingSlug,
    })
    .from(articleHeads)
    .innerJoin(
      articleRevisions,
      and(
        eq(articleRevisions.workspaceId, articleHeads.workspaceId),
        eq(articleRevisions.articleId, articleHeads.articleId),
        eq(articleRevisions.id, articleHeads.workingRevisionId),
        eq(articleRevisions.revisionNumber, articleHeads.workingRevisionNumber),
      ),
    )
    .innerJoin(
      articles,
      and(
        eq(articles.workspaceId, articleHeads.workspaceId),
        eq(articles.id, articleHeads.articleId),
      ),
    )
    .where(
      and(eq(articleHeads.workspaceId, workspaceId), eq(articleHeads.articleId, articleId)),
    )
    .limit(1)
    .execute();
  return state ?? null;
}

async function slugIsAvailable(
  database: SqliteDatabase,
  workspaceId: string,
  articleId: string,
  slug: string,
) {
  const [claims, articleRows] = await Promise.all([
    executable(database)
      .select({ articleId: articleSlugClaims.articleId })
      .from(articleSlugClaims)
      .where(
        and(
          eq(articleSlugClaims.workspaceId, workspaceId),
          eq(articleSlugClaims.normalizedSlug, slug),
        ),
      )
      .limit(1)
      .execute(),
    executable(database)
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.workspaceId, workspaceId), eq(articles.slug, slug)))
      .limit(1)
      .execute(),
  ]);
  return (
    (!claims[0] || claims[0].articleId === articleId) &&
    (!articleRows[0] || articleRows[0].id === articleId)
  );
}

async function assetsAreAvailable(
  database: SqliteDatabase,
  workspaceId: string,
  hashes: readonly string[],
  manifestId: string | undefined,
  currentRevisionId: string | null,
  checkedAt: Date,
) {
  const db = executable(database);
  if (manifestId) {
    const [manifest] = await db
      .select({ id: assetManifests.id })
      .from(assetManifests)
      .where(
        and(
          eq(assetManifests.workspaceId, workspaceId),
          eq(assetManifests.id, manifestId),
          gt(assetManifests.expiresAt, checkedAt),
        ),
      )
      .limit(1)
      .execute();
    if (!manifest) return false;
  }
  if (hashes.length === 0) return true;

  const matchingAssets = await db
    .select({ id: assets.id, hash: assets.hash })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.hash, hashes)))
    .execute();
  if (matchingAssets.length !== hashes.length) return false;

  const allowedIds = new Set<string>();
  if (currentRevisionId) {
    const historical = await db
      .select({ assetId: articleRevisionAssets.assetId })
      .from(articleRevisionAssets)
      .where(
        and(
          eq(articleRevisionAssets.workspaceId, workspaceId),
          eq(articleRevisionAssets.revisionId, currentRevisionId),
        ),
      )
      .execute();
    for (const row of historical) allowedIds.add(row.assetId);
  }
  if (manifestId) {
    const staged = await db
      .select({ assetId: assetManifestItems.assetId })
      .from(assetManifestItems)
      .where(
        and(
          eq(assetManifestItems.workspaceId, workspaceId),
          eq(assetManifestItems.manifestId, manifestId),
        ),
      )
      .execute();
    for (const row of staged) allowedIds.add(row.assetId);
  }
  return matchingAssets.every((asset) => allowedIds.has(asset.id));
}

async function classifyCreateFailure(
  database: SqliteDatabase,
  request: CreateDraftArticleRequest,
  category: CategorySnapshot,
  hashes: readonly string[],
  checkedAt: Date,
  error: unknown,
): Promise<DraftWriteResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.article.workspaceId);
  if (!(await actorIsAuthorized(database, request, checkedAt))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const currentCategory = await readCategory(
    database,
    request.article.workspaceId,
    request.article.categoryId,
  );
  if (!currentCategory) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
  if (currentCategory.slug !== category.slug || currentCategory.name !== category.name) {
    return { status: "rejected", code: "CATEGORY_CHANGED" };
  }
  const [existing] = await executable(database)
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.workspaceId, request.article.workspaceId),
        eq(articles.id, request.article.id),
      ),
    )
    .limit(1)
    .execute();
  if (existing) return { status: "conflict", code: "ARTICLE_EXISTS" };
  if (
    !(await slugIsAvailable(
      database,
      request.article.workspaceId,
      request.article.id,
      request.article.slug,
    ))
  ) {
    return { status: "conflict", code: "SLUG_CONFLICT" };
  }
  if (
    !(await assetsAreAvailable(
      database,
      request.article.workspaceId,
      hashes,
      request.assets.manifestId,
      null,
      checkedAt,
    ))
  ) {
    return { status: "rejected", code: "ASSET_UNAVAILABLE" };
  }
  throw error;
}

async function classifySaveFailure(
  database: SqliteDatabase,
  request: SaveDraftArticleRequest,
  category: CategorySnapshot,
  hashes: readonly string[],
  checkedAt: Date,
  error: unknown,
): Promise<DraftWriteResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.article.workspaceId);
  if (!(await actorIsAuthorized(database, request, checkedAt))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const state = await readCurrentDraft(
    database,
    request.article.workspaceId,
    request.article.id,
  );
  if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
  if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
    return {
      status: "conflict",
      code: "STALE_REVISION",
      currentRevisionNumber: state.revisionNumber,
    };
  }
  if (state.archivedAt) return { status: "rejected", code: "ARTICLE_ARCHIVED" };
  if (!isEditableState(state.reviewState)) {
    return { status: "rejected", code: "INVALID_REVIEW_STATE" };
  }
  const currentCategory = await readCategory(
    database,
    request.article.workspaceId,
    request.article.categoryId,
  );
  if (!currentCategory) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
  if (currentCategory.slug !== category.slug || currentCategory.name !== category.name) {
    return { status: "rejected", code: "CATEGORY_CHANGED" };
  }
  if (
    !(await slugIsAvailable(
      database,
      request.article.workspaceId,
      request.article.id,
      request.article.slug,
    ))
  ) {
    return { status: "conflict", code: "SLUG_CONFLICT" };
  }
  if (
    !(await assetsAreAvailable(
      database,
      request.article.workspaceId,
      hashes,
      request.assets.manifestId,
      state.revisionId,
      checkedAt,
    ))
  ) {
    return { status: "rejected", code: "ASSET_UNAVAILABLE" };
  }
  throw error;
}

export function createSqliteArticleDraftRepository(
  database: SqliteDatabase,
  options?: ArticleDraftRepositoryOptions,
): ArticleDraftRepository {
  return withAuthoringErrorBoundary<ArticleDraftRepository>({
    async createDraftArticle(request) {
      const changedAt = draftRepositoryClock(options);
      const { manifestId, hashes } = prepareAssetSelection(request.assets);
      const [category, authorized] = await Promise.all([
        readCategory(database, request.article.workspaceId, request.article.categoryId),
        actorIsAuthorized(database, request, changedAt),
        authoringIsOpen(database, request.article.workspaceId),
      ]);
      if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
      if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };

      const revisionId = draftRepositoryRevisionId(options);
      const revisionNumber = 1;
      const revisionHash = await articleRevisionHash(snapshot(request, category, hashes));
      const statements = [
        authoringAssertion(request.article.workspaceId, "sqlite"),
        actorAssertion(request, changedAt),
        categoryAssertion(request.article.workspaceId, category),
        slugAssertion(
          request.article.workspaceId,
          request.article.id,
          request.article.slug,
          true,
        ),
        assetAssertion(
          request.article.workspaceId,
          hashes,
          manifestId,
          null,
          changedAt,
        ),
        sql`
          insert into articles (
            id, workspace_id, category_id, slug, title, mdx, content_hash, status,
            is_faq, author_name, position, published_at, created_at, updated_at
          ) values (
            ${request.article.id}, ${request.article.workspaceId}, ${category.id},
            ${request.article.slug}, ${request.article.title}, ${request.article.mdx},
            null, 'draft', ${request.article.isFaq ? 1 : 0},
            ${request.article.authorName}, ${request.article.position}, null,
            ${changedAt.getTime()}, ${changedAt.getTime()}
          )
        `,
        upsertSlugClaim(
          request.article.workspaceId,
          request.article.id,
          request.article.slug,
          true,
        ),
        revisionInsert(
          request,
          category,
          revisionId,
          revisionNumber,
          revisionHash,
          changedAt,
        ),
        revisionAssetInsert(
          request.article.workspaceId,
          request.article.id,
          revisionId,
          revisionNumber,
          hashes,
          manifestId,
          null,
          changedAt,
        ),
        sql`
          insert into article_heads (
            article_id, workspace_id, working_revision_id, working_revision_number,
            working_slug, published_revision_id, published_revision_number,
            review_state, archived_at, archived_by_member_id
          ) values (
            ${request.article.id}, ${request.article.workspaceId}, ${revisionId}, 1,
            ${request.article.slug}, null, null, 'editing', null, null
          )
        `,
        ...consumeManifestAndOrphans(request.article.workspaceId, manifestId),
      ];

      try {
        await executeAtomically(database, statements);
      } catch (error) {
        return classifyCreateFailure(
          database,
          request,
          category,
          hashes,
          changedAt,
          error,
        );
      }
      return { status: "saved", articleId: request.article.id, revisionId, revisionNumber };
    },

    async saveDraftArticle(request) {
      if (
        !Number.isSafeInteger(request.expectedWorkingRevisionNumber) ||
        request.expectedWorkingRevisionNumber < 1
      ) {
        return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
      }
      const changedAt = draftRepositoryClock(options);
      const { manifestId, hashes } = prepareAssetSelection(request.assets);
      const [state, category, authorized] = await Promise.all([
        readCurrentDraft(database, request.article.workspaceId, request.article.id),
        readCategory(database, request.article.workspaceId, request.article.categoryId),
        actorIsAuthorized(database, request, changedAt),
        authoringIsOpen(database, request.article.workspaceId),
      ]);
      if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
      if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
      if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
        return {
          status: "conflict",
          code: "STALE_REVISION",
          currentRevisionNumber: state.revisionNumber,
        };
      }
      if (state.archivedAt) return { status: "rejected", code: "ARTICLE_ARCHIVED" };
      if (!isEditableState(state.reviewState)) {
        return { status: "rejected", code: "INVALID_REVIEW_STATE" };
      }
      if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };

      const revisionHash = await articleRevisionHash(snapshot(request, category, hashes));
      if (revisionHash === state.revisionHash) {
        try {
          await executeAtomically(database, [
            authoringAssertion(request.article.workspaceId, "sqlite"),
            actorAssertion(request, changedAt),
            categoryAssertion(request.article.workspaceId, category),
            currentHeadAssertion(request, state),
            sql`
              update article_heads set working_revision_number = working_revision_number
              where workspace_id = ${request.article.workspaceId}
                and article_id = ${request.article.id}
                and working_revision_id = ${state.revisionId}
                and working_revision_number = ${request.expectedWorkingRevisionNumber}
                and review_state = ${state.reviewState}
                and archived_at is null
            `,
          ]);
        } catch (error) {
          return classifySaveFailure(
            database,
            request,
            category,
            hashes,
            changedAt,
            error,
          );
        }
        return {
          status: "unchanged",
          articleId: request.article.id,
          revisionId: state.revisionId,
          revisionNumber: state.revisionNumber,
        };
      }

      const revisionId = draftRepositoryRevisionId(options);
      const revisionNumber = request.expectedWorkingRevisionNumber + 1;
      const neverPublished = state.publishedRevisionId === null;
      const statements = [
        authoringAssertion(request.article.workspaceId, "sqlite"),
        actorAssertion(request, changedAt),
        categoryAssertion(request.article.workspaceId, category),
        currentHeadAssertion(request, state),
        slugAssertion(
          request.article.workspaceId,
          request.article.id,
          request.article.slug,
          false,
        ),
        assetAssertion(
          request.article.workspaceId,
          hashes,
          manifestId,
          state.revisionId,
          changedAt,
        ),
        upsertSlugClaim(
          request.article.workspaceId,
          request.article.id,
          request.article.slug,
          neverPublished,
        ),
        revisionInsert(
          request,
          category,
          revisionId,
          revisionNumber,
          revisionHash,
          changedAt,
        ),
        revisionAssetInsert(
          request.article.workspaceId,
          request.article.id,
          revisionId,
          revisionNumber,
          hashes,
          manifestId,
          state.revisionId,
          changedAt,
        ),
        sql`
          update article_heads set
            working_revision_id = ${revisionId},
            working_revision_number = ${revisionNumber},
            working_slug = ${request.article.slug},
            review_state = 'editing'
          where workspace_id = ${request.article.workspaceId}
            and article_id = ${request.article.id}
            and working_revision_id = ${state.revisionId}
            and working_revision_number = ${request.expectedWorkingRevisionNumber}
            and review_state = ${state.reviewState}
            and archived_at is null
        `,
        ...(neverPublished
          ? [
              sql`
                update articles set slug = ${request.article.slug}
                where workspace_id = ${request.article.workspaceId}
                  and id = ${request.article.id}
                  and status = 'draft'
                  and exists (
                    select 1 from article_heads
                    where workspace_id = ${request.article.workspaceId}
                      and article_id = ${request.article.id}
                      and working_revision_id = ${revisionId}
                      and published_revision_id is null
                  )
              `,
            ]
          : []),
        sql`
          delete from article_slug_claims
          where workspace_id = ${request.article.workspaceId}
            and article_id = ${request.article.id}
            and normalized_slug = ${state.workingSlug}
            and normalized_slug <> ${request.article.slug}
            and not exists (
              select 1 from articles
              where workspace_id = article_slug_claims.workspace_id
                and id = article_slug_claims.article_id
                and slug = article_slug_claims.normalized_slug
            )
            and not exists (
              select 1 from article_heads
              where workspace_id = article_slug_claims.workspace_id
                and article_id = article_slug_claims.article_id
                and working_slug = article_slug_claims.normalized_slug
            )
        `,
        sql`
          update article_slug_claims set working_claim = 0
          where workspace_id = ${request.article.workspaceId}
            and article_id = ${request.article.id}
            and normalized_slug = ${state.workingSlug}
            and normalized_slug <> ${request.article.slug}
            and article_row_claim = 1
        `,
        ...consumeManifestAndOrphans(request.article.workspaceId, manifestId),
      ];

      try {
        await executeAtomically(database, statements);
      } catch (error) {
        return classifySaveFailure(
          database,
          request,
          category,
          hashes,
          changedAt,
          error,
        );
      }
      return { status: "saved", articleId: request.article.id, revisionId, revisionNumber };
    },
  });
}
