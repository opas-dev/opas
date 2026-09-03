// ABOUTME: Persists private article drafts and immutable revisions on SQLite and D1.
// ABOUTME: Serializes authorization, category, head, slug, and asset checks with each write.
import {
  asc,
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import { prepareArticleEvidence } from "@/content/article-evidence";
import { articleRevisionHash, type ArticleRevisionSnapshot } from "@/content/article-revision";
import type {
  ArticleReviewAction,
  ArticleReviewState,
} from "@/content/article-workflow";
import { validateArticleMdx } from "@/content/mdx-safety";
import { prepareAssetSelection } from "@/db/assets";
import {
  draftChangeSummary,
  draftRepositoryClock,
  draftRepositoryReviewEventId,
  draftRepositoryRevisionId,
  draftReviewNote,
  articleRevisionDetailEventLimit,
  articleRevisionHistoryPageLimit,
  type ArchiveArticleRequest,
  type ArticleDraftRepository,
  type ArticleDraftRepositoryOptions,
  type ArticleLibraryItem,
  type ArticleLibraryRequest,
  type ArticleRevisionDetail,
  type ArticleRevisionDetailRequest,
  type ArticleRevisionHistoryPage,
  type ArticleRevisionHistoryRequest,
  type ArticleWorkingHead,
  type ArticleWorkingHeadRequest,
  type ArticleWorkflowResult,
  type ApproveAndPublishArticleRevisionRequest,
  type ApproveArticleRevisionRequest,
  type CreateDraftArticleRequest,
  type DraftActor,
  type DraftWriteResult,
  type EmergencyPublishArticleRequest,
  type PublishArticleRevisionRequest,
  type RequestArticleChangesRequest,
  type RestoreArchivedArticleRequest,
  type RestoreRevisionAsDraftRequest,
  type SaveDraftArticleRequest,
  type SubmitArticleForReviewRequest,
  type UnpublishArticleRequest,
  type WithdrawArticleReviewRequest,
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
  articleReviewEvents,
  articleSlugClaims,
  articles,
  assetManifestItems,
  assetManifests,
  assets,
  categories,
  workspaceAuthoringControls,
  workspaceMembers,
} from "@/db/schema/sqlite";
import {
  articleEvidenceCommitStatements,
  articleEvidenceInvalidationStatements,
} from "@/db/sqlite/evidence-repository";
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
  authorName: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  createdByMemberId: string | null;
  isFaq: boolean;
  mdx: string;
  position: number;
  articleSlug: string;
  articleStatus: "draft" | "published";
  archivedAt: Date | null;
  publishedAt: Date | null;
  publishedRevisionId: string | null;
  publishedRevisionNumber: number | null;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
  reviewState: "editing" | "in_review" | "changes_requested" | "approved" | "published";
  submittedByMemberId: string | null;
  slug: string;
  title: string;
  workingSlug: string;
};

type HistoricalRevision = {
  authorName: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  changeKind: "manual" | "import" | "rollback" | "migration" | "seed";
  changeSummary: string | null;
  createdAt: Date;
  createdByMemberId: string | null;
  createdBySystemLabel: string | null;
  isFaq: boolean;
  mdx: string;
  position: number;
  restoredFromRevisionId: string | null;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  title: string;
};

type WorkflowRequest =
  | ArchiveArticleRequest
  | ApproveAndPublishArticleRevisionRequest
  | ApproveArticleRevisionRequest
  | EmergencyPublishArticleRequest
  | PublishArticleRevisionRequest
  | RequestArticleChangesRequest
  | RestoreArchivedArticleRequest
  | SubmitArticleForReviewRequest
  | UnpublishArticleRequest
  | WithdrawArticleReviewRequest;

type WorkflowRole = "administrator" | "editor" | "reviewer";

type ContentReadAuthorization = Readonly<{
  actor: DraftActor;
  checkedAt: Date;
}>;

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
  workspaceId: string,
  actor: DraftActor,
  checkedAt: Date,
  roles: readonly WorkflowRole[] = ["administrator", "editor"],
) {
  const serializedRoles = JSON.stringify(roles);
  return sqliteAssertion(sql`exists (
    select 1
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
      and session.member_id = member.id
    where member.workspace_id = ${workspaceId}
      and member.id = ${actor.memberId}
      and member.status = 'active'
      and member.role in (select value from json_each(${serializedRoles}))
      and session.id = ${actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
  )`);
}

function contentReadAuthorizationCondition(
  workspaceId: string,
  authorization: ContentReadAuthorization,
) {
  return sql`exists (
    select 1
    from workspace_members authorized_member
    inner join admin_sessions authorized_session
      on authorized_session.workspace_id = authorized_member.workspace_id
      and authorized_session.member_id = authorized_member.id
    where authorized_member.workspace_id = ${workspaceId}
      and authorized_member.id = ${authorization.actor.memberId}
      and authorized_member.status = 'active'
      and authorized_member.role in ('administrator', 'editor', 'reviewer')
      and authorized_session.id = ${authorization.actor.sessionId}
      and authorized_session.revoked_at is null
      and authorized_session.expires_at > ${authorization.checkedAt.getTime()}
  )`;
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

function rollbackRevisionInsert(
  request: RestoreRevisionAsDraftRequest,
  source: HistoricalRevision,
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
      ${revisionId}, ${request.workspaceId}, ${request.articleId}, ${revisionNumber},
      ${category.id}, ${category.slug}, ${category.name}, ${source.slug}, ${source.title},
      ${source.mdx}, ${source.isFaq ? 1 : 0}, ${source.authorName}, ${source.position},
      ${revisionHash}, 'rollback', ${request.actor.memberId}, null,
      ${draftChangeSummary(request.changeSummary)}, ${changedAt.getTime()}, ${source.revisionId}
    )
  `;
}

function rollbackRevisionAssetInsert(
  request: RestoreRevisionAsDraftRequest,
  revisionId: string,
  revisionNumber: number,
) {
  return sql`
    insert into article_revision_assets (
      workspace_id, article_id, revision_id, revision_number, asset_id
    )
    select ${request.workspaceId}, ${request.articleId}, ${revisionId},
      ${revisionNumber}, source_asset.asset_id
    from article_revision_assets source_asset
    inner join assets asset
      on asset.workspace_id = source_asset.workspace_id
      and asset.id = source_asset.asset_id
    where source_asset.workspace_id = ${request.workspaceId}
      and source_asset.article_id = ${request.articleId}
      and source_asset.revision_id = ${request.sourceRevisionId}
      and source_asset.revision_number = ${request.sourceRevisionNumber}
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
  workspaceId: string,
  actor: DraftActor,
  checkedAt: Date,
  roles: readonly WorkflowRole[] = ["administrator", "editor"],
) {
  const [authorizedActor] = await executable(database)
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
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.id, actor.memberId),
        eq(workspaceMembers.status, "active"),
        inArray(workspaceMembers.role, roles),
        eq(adminSessions.id, actor.sessionId),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, checkedAt),
      ),
    )
    .limit(1)
    .execute();
  return authorizedActor !== undefined;
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
      authorName: articleRevisions.authorName,
      articleSlug: articles.slug,
      articleStatus: articles.status,
      archivedAt: articleHeads.archivedAt,
      categoryId: articleRevisions.categoryId,
      categoryName: articleRevisions.categoryName,
      categorySlug: articleRevisions.categorySlug,
      createdByMemberId: articleRevisions.createdByMemberId,
      isFaq: articleRevisions.isFaq,
      mdx: articleRevisions.mdx,
      position: articleRevisions.position,
      publishedAt: articles.publishedAt,
      publishedRevisionId: articleHeads.publishedRevisionId,
      publishedRevisionNumber: articleHeads.publishedRevisionNumber,
      revisionHash: articleRevisions.revisionHash,
      revisionId: articleHeads.workingRevisionId,
      revisionNumber: articleHeads.workingRevisionNumber,
      reviewState: articleHeads.reviewState,
      submittedByMemberId: articleHeads.submittedByMemberId,
      slug: articleRevisions.slug,
      title: articleRevisions.title,
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

async function readHistoricalRevision(
  database: SqliteDatabase,
  workspaceId: string,
  articleId: string,
  revisionId: string,
  revisionNumber: number,
  authorization?: ContentReadAuthorization,
): Promise<HistoricalRevision | null> {
  const [revision] = await executable(database)
    .select({
      authorName: articleRevisions.authorName,
      categoryId: articleRevisions.categoryId,
      categoryName: articleRevisions.categoryName,
      categorySlug: articleRevisions.categorySlug,
      changeKind: articleRevisions.changeKind,
      changeSummary: articleRevisions.changeSummary,
      createdAt: articleRevisions.createdAt,
      createdByMemberId: articleRevisions.createdByMemberId,
      createdBySystemLabel: articleRevisions.createdBySystemLabel,
      isFaq: articleRevisions.isFaq,
      mdx: articleRevisions.mdx,
      position: articleRevisions.position,
      restoredFromRevisionId: articleRevisions.restoredFromRevisionId,
      revisionHash: articleRevisions.revisionHash,
      revisionId: articleRevisions.id,
      revisionNumber: articleRevisions.revisionNumber,
      slug: articleRevisions.slug,
      title: articleRevisions.title,
    })
    .from(articleRevisions)
    .where(
      and(
        eq(articleRevisions.workspaceId, workspaceId),
        eq(articleRevisions.articleId, articleId),
        eq(articleRevisions.id, revisionId),
        eq(articleRevisions.revisionNumber, revisionNumber),
        authorization
          ? contentReadAuthorizationCondition(workspaceId, authorization)
          : undefined,
      ),
    )
    .limit(1)
    .execute();
  return revision ?? null;
}

function historicalSnapshot(
  workspaceId: string,
  articleId: string,
  revision: HistoricalRevision,
  assetHashes: readonly string[],
): ArticleRevisionSnapshot {
  return {
    workspaceId,
    articleId,
    categoryId: revision.categoryId,
    categorySlug: revision.categorySlug,
    categoryName: revision.categoryName,
    slug: revision.slug,
    title: revision.title,
    mdx: revision.mdx,
    isFaq: revision.isFaq,
    authorName: revision.authorName,
    position: revision.position,
    assetHashes,
  };
}

function historyPageSize(limit: number | undefined) {
  return Number.isSafeInteger(limit) && limit! >= 1
    ? Math.min(limit!, articleRevisionHistoryPageLimit)
    : articleRevisionHistoryPageLimit;
}

function validHistoryCursor(beforeRevisionNumber: number | undefined) {
  return (
    beforeRevisionNumber === undefined ||
    (Number.isSafeInteger(beforeRevisionNumber) && beforeRevisionNumber >= 1)
  );
}

function restorableRevisionStructureIsValid(revision: HistoricalRevision) {
  const mdxSize = new TextEncoder().encode(revision.mdx).byteLength;
  return (
    revision.slug.length >= 1 &&
    revision.slug.length <= 120 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(revision.slug) &&
    revision.title.trim().length >= 1 &&
    revision.title.length <= 160 &&
    mdxSize >= 1 &&
    mdxSize <= 100_000 &&
    revision.authorName.trim().length >= 1 &&
    revision.authorName.length <= 100 &&
    Number.isSafeInteger(revision.position) &&
    revision.position >= 0 &&
    revision.position <= 10_000
  );
}

async function readAuthorizedWorkingHead(
  database: SqliteDatabase,
  request: ArticleWorkingHeadRequest,
  checkedAt: Date,
): Promise<ArticleWorkingHead | null> {
  const rows = await executable(database)
    .select({
      archivedAt: articleHeads.archivedAt,
      assetHash: assets.hash,
      authorName: articleRevisions.authorName,
      categoryId: articleRevisions.categoryId,
      changeKind: articleRevisions.changeKind,
      changeSummary: articleRevisions.changeSummary,
      createdAt: articleRevisions.createdAt,
      createdByMemberId: articleRevisions.createdByMemberId,
      createdBySystemLabel: articleRevisions.createdBySystemLabel,
      isFaq: articleRevisions.isFaq,
      mdx: articleRevisions.mdx,
      position: articleRevisions.position,
      publicStatus: articles.status,
      publishedRevisionId: articleHeads.publishedRevisionId,
      publishedRevisionNumber: articleHeads.publishedRevisionNumber,
      reviewState: articleHeads.reviewState,
      submittedByMemberId: articleHeads.submittedByMemberId,
      revisionHash: articleRevisions.revisionHash,
      revisionId: articleHeads.workingRevisionId,
      revisionNumber: articleHeads.workingRevisionNumber,
      slug: articleRevisions.slug,
      title: articleRevisions.title,
      workspaceId: articleHeads.workspaceId,
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
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, articleHeads.workspaceId),
        eq(workspaceMembers.id, request.actor.memberId),
        eq(workspaceMembers.status, "active"),
        inArray(workspaceMembers.role, ["administrator", "editor", "reviewer"]),
      ),
    )
    .innerJoin(
      adminSessions,
      and(
        eq(adminSessions.workspaceId, workspaceMembers.workspaceId),
        eq(adminSessions.memberId, workspaceMembers.id),
        eq(adminSessions.id, request.actor.sessionId),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, checkedAt),
      ),
    )
    .leftJoin(
      articleRevisionAssets,
      and(
        eq(articleRevisionAssets.workspaceId, articleRevisions.workspaceId),
        eq(articleRevisionAssets.articleId, articleRevisions.articleId),
        eq(articleRevisionAssets.revisionId, articleRevisions.id),
        eq(articleRevisionAssets.revisionNumber, articleRevisions.revisionNumber),
      ),
    )
    .leftJoin(
      assets,
      and(
        eq(assets.workspaceId, articleRevisionAssets.workspaceId),
        eq(assets.id, articleRevisionAssets.assetId),
      ),
    )
    .where(
      and(
        eq(articleHeads.workspaceId, request.workspaceId),
        eq(articleHeads.articleId, request.articleId),
      ),
    )
    .orderBy(asc(assets.hash))
    .execute();
  const first = rows[0];
  if (!first) return null;
  return {
    article: {
      id: request.articleId,
      workspaceId: first.workspaceId,
      categoryId: first.categoryId,
      slug: first.slug,
      title: first.title,
      mdx: first.mdx,
      isFaq: first.isFaq,
      authorName: first.authorName,
      position: first.position,
    },
    archivedAt: first.archivedAt,
    assetHashes: rows.flatMap((row) => (row.assetHash ? [row.assetHash] : [])),
    changeKind: first.changeKind,
    changeSummary: first.changeSummary,
    createdAt: first.createdAt,
    createdByMemberId: first.createdByMemberId,
    createdBySystemLabel: first.createdBySystemLabel,
    publicStatus: first.publicStatus,
    publishedRevisionId: first.publishedRevisionId,
    publishedRevisionNumber: first.publishedRevisionNumber,
    reviewState: first.reviewState,
    revisionHash: first.revisionHash,
    revisionId: first.revisionId,
    revisionNumber: first.revisionNumber,
    submittedByMemberId: first.submittedByMemberId,
  };
}

async function listAuthorizedArticleLibrary(
  database: SqliteDatabase,
  request: ArticleLibraryRequest,
  checkedAt: Date,
): Promise<readonly ArticleLibraryItem[]> {
  return executable(database)
    .select({
      archivedAt: articleHeads.archivedAt,
      articleId: articleHeads.articleId,
      categoryId: articleRevisions.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      createdByMemberId: articleRevisions.createdByMemberId,
      publicStatus: articles.status,
      publishedRevisionId: articleHeads.publishedRevisionId,
      publishedRevisionNumber: articleHeads.publishedRevisionNumber,
      reviewState: articleHeads.reviewState,
      slug: articleRevisions.slug,
      submittedByMemberId: articleHeads.submittedByMemberId,
      title: articleRevisions.title,
      updatedAt: articleRevisions.createdAt,
      workingRevisionId: articleHeads.workingRevisionId,
      workingRevisionNumber: articleHeads.workingRevisionNumber,
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
    .innerJoin(
      categories,
      and(
        eq(categories.workspaceId, articleRevisions.workspaceId),
        eq(categories.id, articleRevisions.categoryId),
      ),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, articleHeads.workspaceId),
        eq(workspaceMembers.id, request.actor.memberId),
        eq(workspaceMembers.status, "active"),
        inArray(workspaceMembers.role, ["administrator", "editor", "reviewer"]),
      ),
    )
    .innerJoin(
      adminSessions,
      and(
        eq(adminSessions.workspaceId, workspaceMembers.workspaceId),
        eq(adminSessions.memberId, workspaceMembers.id),
        eq(adminSessions.id, request.actor.sessionId),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, checkedAt),
      ),
    )
    .where(eq(articleHeads.workspaceId, request.workspaceId))
    .orderBy(
      asc(categories.position),
      asc(categories.id),
      asc(articleRevisions.position),
      asc(articleHeads.articleId),
    )
    .execute();
}

async function listAuthorizedRevisionHistory(
  database: SqliteDatabase,
  request: ArticleRevisionHistoryRequest,
  checkedAt: Date,
): Promise<ArticleRevisionHistoryPage | null> {
  if (!validHistoryCursor(request.beforeRevisionNumber)) return null;

  const pageSize = historyPageSize(request.limit);
  const authorization = { actor: request.actor, checkedAt };
  const rows = await executable(database)
    .select({
      changeKind: articleRevisions.changeKind,
      changeSummary: articleRevisions.changeSummary,
      createdAt: articleRevisions.createdAt,
      createdByDisplayName: sql<string>`coalesce(${workspaceMembers.displayName}, ${articleRevisions.createdBySystemLabel})`,
      createdByMemberId: articleRevisions.createdByMemberId,
      isPublishedRevision: sql<number>`coalesce(${articleHeads.publishedRevisionId} = ${articleRevisions.id}, 0)`,
      isWorkingRevision: sql<number>`${articleHeads.workingRevisionId} = ${articleRevisions.id}`,
      restoredFromRevisionId: articleRevisions.restoredFromRevisionId,
      revisionHash: articleRevisions.revisionHash,
      revisionId: articleRevisions.id,
      revisionNumber: articleRevisions.revisionNumber,
      title: articleRevisions.title,
    })
    .from(articleRevisions)
    .innerJoin(
      articleHeads,
      and(
        eq(articleHeads.workspaceId, articleRevisions.workspaceId),
        eq(articleHeads.articleId, articleRevisions.articleId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, articleRevisions.workspaceId),
        eq(workspaceMembers.id, articleRevisions.createdByMemberId),
      ),
    )
    .where(
      and(
        eq(articleRevisions.workspaceId, request.workspaceId),
        eq(articleRevisions.articleId, request.articleId),
        request.beforeRevisionNumber === undefined
          ? undefined
          : lt(articleRevisions.revisionNumber, request.beforeRevisionNumber),
        contentReadAuthorizationCondition(request.workspaceId, authorization),
      ),
    )
    .orderBy(desc(articleRevisions.revisionNumber))
    .limit(pageSize + 1)
    .execute();

  if (rows.length === 0) {
    const [head] = await executable(database)
      .select({ articleId: articleHeads.articleId })
      .from(articleHeads)
      .where(
        and(
          eq(articleHeads.workspaceId, request.workspaceId),
          eq(articleHeads.articleId, request.articleId),
          contentReadAuthorizationCondition(request.workspaceId, authorization),
        ),
      )
      .limit(1)
      .execute();
    if (!head) return null;
  }

  const items = rows.slice(0, pageSize).map((row) => ({
    ...row,
    isPublishedRevision: Boolean(row.isPublishedRevision),
    isWorkingRevision: Boolean(row.isWorkingRevision),
  }));
  return {
    articleId: request.articleId,
    items,
    nextBeforeRevisionNumber:
      rows.length > pageSize ? items.at(-1)!.revisionNumber : null,
  };
}

async function readAuthorizedRevisionDetail(
  database: SqliteDatabase,
  request: ArticleRevisionDetailRequest,
  checkedAt: Date,
): Promise<ArticleRevisionDetail | null> {
  if (!Number.isSafeInteger(request.revisionNumber) || request.revisionNumber < 1) {
    return null;
  }
  const db = executable(database);
  const [revision, head] = await Promise.all([
    readHistoricalRevision(
      database,
      request.workspaceId,
      request.articleId,
      request.revisionId,
      request.revisionNumber,
      { actor: request.actor, checkedAt },
    ),
    db
      .select({ articleId: articleHeads.articleId })
      .from(articleHeads)
      .where(
        and(
          eq(articleHeads.workspaceId, request.workspaceId),
          eq(articleHeads.articleId, request.articleId),
          contentReadAuthorizationCondition(request.workspaceId, {
            actor: request.actor,
            checkedAt,
          }),
        ),
      )
      .limit(1)
      .execute(),
  ]);
  if (!revision || !head[0]) return null;

  const [assetHashes, creator, eventRows] = await Promise.all([
    readRevisionAssetHashes(database, request.workspaceId, request.revisionId, {
      actor: request.actor,
      checkedAt,
    }),
    revision.createdByMemberId
      ? db
          .select({ displayName: workspaceMembers.displayName })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, request.workspaceId),
              eq(workspaceMembers.id, revision.createdByMemberId),
              contentReadAuthorizationCondition(request.workspaceId, {
                actor: request.actor,
                checkedAt,
              }),
            ),
          )
          .limit(1)
          .execute()
      : Promise.resolve([]),
    db
      .select({
        action: articleReviewEvents.action,
        createdAt: articleReviewEvents.createdAt,
        id: articleReviewEvents.id,
        memberDisplayName: workspaceMembers.displayName,
        memberId: articleReviewEvents.memberId,
        note: articleReviewEvents.note,
      })
      .from(articleReviewEvents)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, articleReviewEvents.workspaceId),
          eq(workspaceMembers.id, articleReviewEvents.memberId),
        ),
      )
      .where(
        and(
          eq(articleReviewEvents.workspaceId, request.workspaceId),
          eq(articleReviewEvents.articleId, request.articleId),
          eq(articleReviewEvents.revisionId, request.revisionId),
          eq(articleReviewEvents.revisionNumber, request.revisionNumber),
          contentReadAuthorizationCondition(request.workspaceId, {
            actor: request.actor,
            checkedAt,
          }),
        ),
      )
      .orderBy(desc(articleReviewEvents.createdAt), desc(articleReviewEvents.id))
      .limit(articleRevisionDetailEventLimit + 1)
      .execute(),
  ]);

  return {
    article: {
      id: request.articleId,
      workspaceId: request.workspaceId,
      categoryId: revision.categoryId,
      slug: revision.slug,
      title: revision.title,
      mdx: revision.mdx,
      isFaq: revision.isFaq,
      authorName: revision.authorName,
      position: revision.position,
    },
    assetHashes,
    categoryName: revision.categoryName,
    categorySlug: revision.categorySlug,
    changeKind: revision.changeKind,
    changeSummary: revision.changeSummary,
    createdAt: revision.createdAt,
    createdByDisplayName:
      creator[0]?.displayName ?? revision.createdBySystemLabel ?? "OPAS migration",
    createdByMemberId: revision.createdByMemberId,
    events: eventRows.slice(0, articleRevisionDetailEventLimit),
    eventsTruncated: eventRows.length > articleRevisionDetailEventLimit,
    restoredFromRevisionId: revision.restoredFromRevisionId,
    revisionHash: revision.revisionHash,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
  };
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
  if (!(await actorIsAuthorized(database, request.article.workspaceId, request.actor, checkedAt))) {
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
  if (!(await actorIsAuthorized(database, request.article.workspaceId, request.actor, checkedAt))) {
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

type WorkflowSpecification = Readonly<{
  action: ArticleReviewAction;
  allowedStates: readonly ArticleReviewState[];
  nextState: ArticleReviewState;
  roles: readonly WorkflowRole[];
  categoryMustMatch?: boolean;
  independentActor?: boolean;
  submittingActor?: boolean;
}>;

function validWorkflowRevisionNumber(request: WorkflowRequest) {
  return (
    Number.isSafeInteger(request.expectedWorkingRevisionNumber) &&
    request.expectedWorkingRevisionNumber >= 1
  );
}

function workflowConflict(
  state: CurrentDraft,
  request: WorkflowRequest,
  allowedStates: readonly ArticleReviewState[],
): ArticleWorkflowResult | null {
  if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
    return {
      status: "conflict",
      code: "STALE_REVISION",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.revisionId !== request.revisionId) {
    return {
      status: "conflict",
      code: "REVISION_MISMATCH",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (
    state.reviewState !== request.expectedReviewState ||
    !allowedStates.includes(state.reviewState)
  ) {
    return {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.archivedAt) return { status: "rejected", code: "ARTICLE_ARCHIVED" };
  return null;
}

function workflowHeadAssertion(
  request: WorkflowRequest,
  state: CurrentDraft,
  allowedStates: readonly ArticleReviewState[],
  requirePublished = false,
) {
  const serializedStates = JSON.stringify(allowedStates);
  return sqliteAssertion(sql`exists (
    select 1
    from article_heads head
    inner join articles article
      on article.workspace_id = head.workspace_id
      and article.id = head.article_id
    where head.workspace_id = ${request.workspaceId}
      and head.article_id = ${request.articleId}
      and head.working_revision_id = ${request.revisionId}
      and head.working_revision_number = ${request.expectedWorkingRevisionNumber}
      and head.review_state = ${request.expectedReviewState}
      and head.review_state in (select value from json_each(${serializedStates}))
      and head.archived_at is null
      and article.status = ${state.articleStatus}
      and (${requirePublished ? 1 : 0} = 0 or article.status = 'published')
  )`);
}

function archiveStateConflict(
  state: CurrentDraft,
  request: ArchiveArticleRequest | RestoreArchivedArticleRequest,
  restoring: boolean,
): ArticleWorkflowResult | null {
  if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
    return {
      status: "conflict",
      code: "STALE_REVISION",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.revisionId !== request.revisionId) {
    return {
      status: "conflict",
      code: "REVISION_MISMATCH",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (
    state.reviewState !== request.expectedReviewState ||
    state.articleStatus !== request.expectedPublicStatus
  ) {
    return {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (restoring ? state.archivedAt === null : state.archivedAt !== null) {
    return {
      status: "rejected",
      code: restoring ? "ARTICLE_NOT_ARCHIVED" : "ARTICLE_ARCHIVED",
    };
  }
  return null;
}

function archiveHeadAssertion(
  request: ArchiveArticleRequest | RestoreArchivedArticleRequest,
  restoring: boolean,
) {
  return sqliteAssertion(sql`exists (
    select 1
    from article_heads head
    inner join articles article
      on article.workspace_id = head.workspace_id
      and article.id = head.article_id
    where head.workspace_id = ${request.workspaceId}
      and head.article_id = ${request.articleId}
      and head.working_revision_id = ${request.revisionId}
      and head.working_revision_number = ${request.expectedWorkingRevisionNumber}
      and head.review_state = ${request.expectedReviewState}
      and article.status = ${request.expectedPublicStatus}
      and ${restoring ? sql`head.archived_at is not null` : sql`head.archived_at is null`}
  )`);
}

function submittingActorAssertion(request: WorkflowRequest) {
  return sqliteAssertion(sql`${request.actor.memberId} = (
    select submitted_by_member_id
    from article_heads
    where workspace_id = ${request.workspaceId}
      and article_id = ${request.articleId}
      and working_revision_id = ${request.revisionId}
      and working_revision_number = ${request.expectedWorkingRevisionNumber}
  )`);
}

function independentActorAssertion(request: WorkflowRequest) {
  return sqliteAssertion(sql`
    (
      (select created_by_member_id
       from article_revisions
       where workspace_id = ${request.workspaceId}
         and article_id = ${request.articleId}
         and id = ${request.revisionId}
         and revision_number = ${request.expectedWorkingRevisionNumber}) is null
      or ${request.actor.memberId} <> (
        select created_by_member_id
        from article_revisions
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and id = ${request.revisionId}
          and revision_number = ${request.expectedWorkingRevisionNumber}
      )
    )
    and ${request.actor.memberId} <> (
      select submitted_by_member_id
      from article_heads
      where workspace_id = ${request.workspaceId}
        and article_id = ${request.articleId}
        and working_revision_id = ${request.revisionId}
        and working_revision_number = ${request.expectedWorkingRevisionNumber}
    )
  `);
}

async function readRevisionAssetHashes(
  database: SqliteDatabase,
  workspaceId: string,
  revisionId: string,
  authorization?: ContentReadAuthorization,
) {
  const rows = await executable(database)
    .select({ hash: assets.hash })
    .from(articleRevisionAssets)
    .innerJoin(
      assets,
      and(
        eq(assets.workspaceId, articleRevisionAssets.workspaceId),
        eq(assets.id, articleRevisionAssets.assetId),
      ),
    )
    .where(
      and(
        eq(articleRevisionAssets.workspaceId, workspaceId),
        eq(articleRevisionAssets.revisionId, revisionId),
        authorization
          ? contentReadAuthorizationCondition(workspaceId, authorization)
          : undefined,
      ),
    )
    .orderBy(asc(assets.hash))
    .execute();
  return rows.map((row) => row.hash);
}

async function readHistoricalAssetState(
  database: SqliteDatabase,
  workspaceId: string,
  articleId: string,
  revisionId: string,
  revisionNumber: number,
) {
  const rows = await executable(database)
    .select({ assetId: articleRevisionAssets.assetId, hash: assets.hash })
    .from(articleRevisionAssets)
    .leftJoin(
      assets,
      and(
        eq(assets.workspaceId, articleRevisionAssets.workspaceId),
        eq(assets.id, articleRevisionAssets.assetId),
      ),
    )
    .where(
      and(
        eq(articleRevisionAssets.workspaceId, workspaceId),
        eq(articleRevisionAssets.articleId, articleId),
        eq(articleRevisionAssets.revisionId, revisionId),
        eq(articleRevisionAssets.revisionNumber, revisionNumber),
      ),
    )
    .orderBy(asc(assets.hash))
    .execute();
  return {
    complete: rows.every((row) => row.hash !== null),
    hashes: rows.flatMap((row) => (row.hash === null ? [] : [row.hash])),
  };
}

function restoreHeadAssertion(
  request: RestoreRevisionAsDraftRequest,
  state: CurrentDraft,
) {
  return sqliteAssertion(sql`exists (
    select 1
    from article_heads head
    inner join articles article
      on article.workspace_id = head.workspace_id
      and article.id = head.article_id
    where head.workspace_id = ${request.workspaceId}
      and head.article_id = ${request.articleId}
      and head.working_revision_id = ${state.revisionId}
      and head.working_revision_number = ${request.expectedWorkingRevisionNumber}
      and head.review_state = ${request.expectedReviewState}
      and head.review_state in ('editing', 'changes_requested', 'approved', 'published')
      and head.archived_at is null
      and article.status = ${state.articleStatus}
  )`);
}

function historicalRevisionAssertion(
  request: RestoreRevisionAsDraftRequest,
  source: HistoricalRevision,
) {
  return sqliteAssertion(sql`exists (
    select 1
    from article_revisions revision
    where revision.workspace_id = ${request.workspaceId}
      and revision.article_id = ${request.articleId}
      and revision.id = ${request.sourceRevisionId}
      and revision.revision_number = ${request.sourceRevisionNumber}
      and revision.revision_hash = ${source.revisionHash}
  )`);
}

function revisionAssetSetAssertion(
  workspaceId: string,
  revisionId: string,
  hashes: readonly string[],
) {
  const serializedHashes = JSON.stringify(hashes);
  return sqliteAssertion(sql`
    (select count(*) from json_each(${serializedHashes})) = (
      select count(*)
      from article_revision_assets revision_asset
      inner join assets asset
        on asset.workspace_id = revision_asset.workspace_id
        and asset.id = revision_asset.asset_id
      where revision_asset.workspace_id = ${workspaceId}
        and revision_asset.revision_id = ${revisionId}
    )
    and not exists (
      select value from json_each(${serializedHashes})
      except
      select asset.hash
      from article_revision_assets revision_asset
      inner join assets asset
        on asset.workspace_id = revision_asset.workspace_id
        and asset.id = revision_asset.asset_id
      where revision_asset.workspace_id = ${workspaceId}
        and revision_asset.revision_id = ${revisionId}
    )
    and not exists (
      select asset.hash
      from article_revision_assets revision_asset
      inner join assets asset
        on asset.workspace_id = revision_asset.workspace_id
        and asset.id = revision_asset.asset_id
      where revision_asset.workspace_id = ${workspaceId}
        and revision_asset.revision_id = ${revisionId}
      except select value from json_each(${serializedHashes})
    )
  `);
}

function reviewEventInsert(
  request: WorkflowRequest,
  eventId: string,
  action: ArticleReviewAction,
  note: string | null,
  changedAt: Date,
  revisionId = request.revisionId,
  revisionNumber = request.expectedWorkingRevisionNumber,
) {
  return sql`
    insert into article_review_events (
      id, workspace_id, article_id, revision_id, revision_number,
      member_id, action, note, created_at
    ) values (
      ${eventId}, ${request.workspaceId}, ${request.articleId}, ${revisionId},
      ${revisionNumber}, ${request.actor.memberId}, ${action},
      ${note}, ${changedAt.getTime()}
    )
  `;
}

function restoredRevisionEventInsert(
  request: RestoreRevisionAsDraftRequest,
  eventId: string,
  revisionId: string,
  revisionNumber: number,
  note: string | null,
  changedAt: Date,
) {
  return sql`
    insert into article_review_events (
      id, workspace_id, article_id, revision_id, revision_number,
      member_id, action, note, created_at
    ) values (
      ${eventId}, ${request.workspaceId}, ${request.articleId}, ${revisionId},
      ${revisionNumber}, ${request.actor.memberId}, 'restored', ${note},
      ${changedAt.getTime()}
    )
  `;
}

function workflowTransitionResult(
  request: WorkflowRequest,
  eventId: string,
  action: ArticleReviewAction,
  reviewState: ArticleReviewState,
  publicStatus: "draft" | "published",
  evidenceJobId?: string,
  approvalEventId?: string,
): ArticleWorkflowResult {
  return {
    status: "transitioned",
    action,
    articleId: request.articleId,
    eventId,
    ...(approvalEventId ? { approvalEventId } : {}),
    ...(evidenceJobId ? { evidenceJobId } : {}),
    publicStatus,
    reviewState,
    revisionId: request.revisionId,
    revisionNumber: request.expectedWorkingRevisionNumber,
  };
}

function revisionSnapshot(
  workspaceId: string,
  articleId: string,
  state: CurrentDraft,
  assetHashes: readonly string[],
): ArticleRevisionSnapshot {
  return {
    workspaceId,
    articleId,
    categoryId: state.categoryId,
    categorySlug: state.categorySlug,
    categoryName: state.categoryName,
    slug: state.slug,
    title: state.title,
    mdx: state.mdx,
    isFaq: state.isFaq,
    authorName: state.authorName,
    position: state.position,
    assetHashes,
  };
}

async function snapshotIsExact(
  workspaceId: string,
  articleId: string,
  state: CurrentDraft,
  assetHashes: readonly string[],
) {
  return (
    (await articleRevisionHash(
      revisionSnapshot(workspaceId, articleId, state, assetHashes),
    )) === state.revisionHash
  );
}

function categoryMatchesRevision(
  category: CategorySnapshot | null,
  state: CurrentDraft,
) {
  return (
    category !== null &&
    category.id === state.categoryId &&
    category.slug === state.categorySlug &&
    category.name === state.categoryName
  );
}

async function classifyWorkflowFailure(
  database: SqliteDatabase,
  request: WorkflowRequest,
  specification: WorkflowSpecification,
  category: CategorySnapshot | null,
  assetHashes: readonly string[],
  checkedAt: Date,
  error: unknown,
  requirePublished = false,
): Promise<ArticleWorkflowResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.workspaceId);
  if (!(await actorIsAuthorized(database, request.workspaceId, request.actor, checkedAt, specification.roles))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const state = await readCurrentDraft(database, request.workspaceId, request.articleId);
  if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
  const conflict = workflowConflict(state, request, specification.allowedStates);
  if (conflict) return conflict;
  if (requirePublished && state.articleStatus !== "published") {
    return {
      status: "conflict",
      code: "INVALID_PUBLICATION_STATE",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (specification.categoryMustMatch) {
    const currentCategory = await readCategory(database, request.workspaceId, state.categoryId);
    if (!currentCategory) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
    if (!categoryMatchesRevision(currentCategory, state) || !categoryMatchesRevision(category, state)) {
      return { status: "rejected", code: "CATEGORY_CHANGED" };
    }
  }
  const submitter = state.submittedByMemberId;
  if (specification.submittingActor && submitter !== request.actor.memberId) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  if (
    specification.independentActor &&
    (submitter === null ||
      state.createdByMemberId === request.actor.memberId ||
      submitter === request.actor.memberId)
  ) {
    return { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" };
  }
  if (
    specification.categoryMustMatch &&
    (!(await snapshotIsExact(request.workspaceId, request.articleId, state, assetHashes)) ||
      !(await assetsAreAvailable(
        database,
        request.workspaceId,
        assetHashes,
        undefined,
        state.revisionId,
        checkedAt,
      )))
  ) {
    return { status: "rejected", code: "ASSET_UNAVAILABLE" };
  }
  throw error;
}

async function classifyArchiveFailure(
  database: SqliteDatabase,
  request: ArchiveArticleRequest | RestoreArchivedArticleRequest,
  checkedAt: Date,
  error: unknown,
  restoring: boolean,
): Promise<ArticleWorkflowResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.workspaceId);
  if (
    !(await actorIsAuthorized(
      database,
      request.workspaceId,
      request.actor,
      checkedAt,
      restoring ? ["administrator", "editor"] : ["administrator", "reviewer"],
    ))
  ) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const state = await readCurrentDraft(database, request.workspaceId, request.articleId);
  if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
  const conflict = archiveStateConflict(state, request, restoring);
  if (conflict) return conflict;
  throw error;
}

async function classifyRestoreRevisionFailure(
  database: SqliteDatabase,
  request: RestoreRevisionAsDraftRequest,
  source: HistoricalRevision,
  category: CategorySnapshot,
  expectedAssetHashes: readonly string[],
  checkedAt: Date,
  error: unknown,
): Promise<ArticleWorkflowResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.workspaceId);
  if (!(await actorIsAuthorized(database, request.workspaceId, request.actor, checkedAt))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const state = await readCurrentDraft(database, request.workspaceId, request.articleId);
  if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
  if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
    return {
      status: "conflict",
      code: "STALE_REVISION",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.reviewState === "in_review") {
    return {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.reviewState !== request.expectedReviewState) {
    return {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: state.revisionNumber,
      currentReviewState: state.reviewState,
    };
  }
  if (state.archivedAt) return { status: "rejected", code: "ARTICLE_ARCHIVED" };
  const selected = await readHistoricalRevision(
    database,
    request.workspaceId,
    request.articleId,
    request.sourceRevisionId,
    request.sourceRevisionNumber,
  );
  if (!selected) return { status: "rejected", code: "REVISION_NOT_FOUND" };
  const currentCategory = await readCategory(database, request.workspaceId, source.categoryId);
  if (!currentCategory) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
  if (
    currentCategory.slug !== category.slug ||
    currentCategory.name !== category.name
  ) {
    return { status: "rejected", code: "CATEGORY_CHANGED" };
  }
  if (!(await slugIsAvailable(database, request.workspaceId, request.articleId, source.slug))) {
    return { status: "conflict", code: "SLUG_CONFLICT" };
  }
  const historicalAssets = await readHistoricalAssetState(
    database,
    request.workspaceId,
    request.articleId,
    source.revisionId,
    source.revisionNumber,
  );
  if (
    !historicalAssets.complete ||
    historicalAssets.hashes.length !== expectedAssetHashes.length ||
    historicalAssets.hashes.some((hash, index) => hash !== expectedAssetHashes[index])
  ) {
    return { status: "rejected", code: "ASSET_UNAVAILABLE" };
  }
  if (
    (await articleRevisionHash(
      historicalSnapshot(
        request.workspaceId,
        request.articleId,
        selected,
        historicalAssets.hashes,
      ),
    )) !== selected.revisionHash
  ) {
    return { status: "rejected", code: "REVISION_INTEGRITY_FAILED" };
  }
  throw error;
}

export function createSqliteArticleDraftRepository(
  database: SqliteDatabase,
  options?: ArticleDraftRepositoryOptions,
): ArticleDraftRepository {
  async function runReviewTransition(
    request: WorkflowRequest,
    specification: WorkflowSpecification,
    note: string | null,
  ): Promise<ArticleWorkflowResult> {
    if (!validWorkflowRevisionNumber(request)) {
      return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
    }
    const changedAt = draftRepositoryClock(options);
    const [state, authorized] = await Promise.all([
      readCurrentDraft(database, request.workspaceId, request.articleId),
      actorIsAuthorized(database, request.workspaceId, request.actor, changedAt, specification.roles),
      authoringIsOpen(database, request.workspaceId),
    ]);
    if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
    const conflict = workflowConflict(state, request, specification.allowedStates);
    if (conflict) return conflict;

    const [category, assetHashes] = await Promise.all([
      specification.categoryMustMatch
        ? readCategory(database, request.workspaceId, state.categoryId)
        : Promise.resolve(null),
      specification.categoryMustMatch
        ? readRevisionAssetHashes(database, request.workspaceId, state.revisionId)
        : Promise.resolve([]),
    ]);
    const submitter = state.submittedByMemberId;
    if (specification.categoryMustMatch) {
      if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
      if (!categoryMatchesRevision(category, state)) {
        return { status: "rejected", code: "CATEGORY_CHANGED" };
      }
      if (!(await snapshotIsExact(request.workspaceId, request.articleId, state, assetHashes))) {
        return { status: "rejected", code: "ASSET_UNAVAILABLE" };
      }
      await validateArticleMdx(state.mdx, state.title);
    }
    if (specification.submittingActor && submitter !== request.actor.memberId) {
      return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    }
    if (
      specification.independentActor &&
      (submitter === null ||
        state.createdByMemberId === request.actor.memberId ||
        submitter === request.actor.memberId)
    ) {
      return { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" };
    }

    const eventId = draftRepositoryReviewEventId(options);
    const statements = [
      authoringAssertion(request.workspaceId, "sqlite"),
      actorAssertion(request.workspaceId, request.actor, changedAt, specification.roles),
      ...(category ? [categoryAssertion(request.workspaceId, category)] : []),
      workflowHeadAssertion(request, state, specification.allowedStates),
      ...(specification.submittingActor ? [submittingActorAssertion(request)] : []),
      ...(specification.independentActor ? [independentActorAssertion(request)] : []),
      ...(specification.categoryMustMatch
        ? [revisionAssetSetAssertion(request.workspaceId, request.revisionId, assetHashes)]
        : []),
      sql`
        update article_heads set
          review_state = ${specification.nextState},
          submitted_by_member_id = ${specification.action === "submitted" ? request.actor.memberId : null}
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = ${request.expectedReviewState}
          and archived_at is null
      `,
      reviewEventInsert(request, eventId, specification.action, note, changedAt),
    ];

    try {
      await executeAtomically(database, statements);
    } catch (error) {
      return classifyWorkflowFailure(
        database,
        request,
        specification,
        category,
        assetHashes,
        changedAt,
        error,
      );
    }
    return workflowTransitionResult(
      request,
      eventId,
      specification.action,
      specification.nextState,
      state.articleStatus,
    );
  }

  async function runPublication(
    request:
      | ApproveAndPublishArticleRevisionRequest
      | PublishArticleRevisionRequest
      | EmergencyPublishArticleRequest,
    mode: "approved" | "approve_and_publish" | "emergency",
    note: string | null,
  ): Promise<ArticleWorkflowResult> {
    if (!validWorkflowRevisionNumber(request)) {
      return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
    }
    const specification: WorkflowSpecification = {
      action: mode === "emergency" ? "emergency_published" : "published",
      allowedStates: mode === "emergency"
        ? ["editing", "in_review", "changes_requested", "approved"]
        : mode === "approve_and_publish" ? ["in_review"] : ["approved"],
      nextState: "published",
      roles: mode === "emergency" ? ["administrator"] : ["administrator", "reviewer"],
      categoryMustMatch: true,
      independentActor: mode === "approve_and_publish",
    };
    const changedAt = draftRepositoryClock(options);
    const [state, authorized] = await Promise.all([
      readCurrentDraft(database, request.workspaceId, request.articleId),
      actorIsAuthorized(database, request.workspaceId, request.actor, changedAt, specification.roles),
      authoringIsOpen(database, request.workspaceId),
    ]);
    if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
    const conflict = workflowConflict(state, request, specification.allowedStates);
    if (conflict) return conflict;

    const [category, assetHashes] = await Promise.all([
      readCategory(database, request.workspaceId, state.categoryId),
      readRevisionAssetHashes(database, request.workspaceId, state.revisionId),
    ]);
    if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
    if (!categoryMatchesRevision(category, state)) {
      return { status: "rejected", code: "CATEGORY_CHANGED" };
    }
    if (!(await snapshotIsExact(request.workspaceId, request.articleId, state, assetHashes))) {
      return { status: "rejected", code: "ASSET_UNAVAILABLE" };
    }
    if (
      specification.independentActor &&
      (state.submittedByMemberId === null ||
        state.createdByMemberId === request.actor.memberId ||
        state.submittedByMemberId === request.actor.memberId)
    ) {
      return { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" };
    }
    const evidence = await prepareArticleEvidence(
      {
        id: request.articleId,
        workspaceId: request.workspaceId,
        categoryId: state.categoryId,
        slug: state.slug,
        title: state.title,
        mdx: state.mdx,
        status: "published",
        isFaq: state.isFaq,
        authorName: state.authorName,
        position: state.position,
        publishedAt: state.publishedAt ?? changedAt,
      },
      state.categorySlug,
      {
        availableAt: changedAt,
        configuredSiteUrl: options?.configuredSiteUrl,
        ...(options?.createEvidenceId ? { createId: options.createEvidenceId } : {}),
      },
    );
    if (!evidence) throw new Error("Published revisions require evidence.");

    const approvalEventId =
      mode === "approve_and_publish" ? draftRepositoryReviewEventId(options) : undefined;
    const eventId = draftRepositoryReviewEventId(options);
    const publishedAt =
      mode === "approve_and_publish"
        ? new Date(changedAt.getTime() + 1)
        : changedAt;
    const changedAtTimestamp = changedAt.getTime();
    const statements = [
      authoringAssertion(request.workspaceId, "sqlite"),
      actorAssertion(request.workspaceId, request.actor, changedAt, specification.roles),
      categoryAssertion(request.workspaceId, category),
      workflowHeadAssertion(request, state, specification.allowedStates),
      ...(specification.independentActor ? [independentActorAssertion(request)] : []),
      ...(approvalEventId
        ? [reviewEventInsert(request, approvalEventId, "approved", note, changedAt)]
        : []),
      slugAssertion(request.workspaceId, request.articleId, state.slug, false),
      revisionAssetSetAssertion(request.workspaceId, request.revisionId, assetHashes),
      upsertSlugClaim(request.workspaceId, request.articleId, state.slug, true),
      sql`
        update articles set status = 'draft'
        where workspace_id = ${request.workspaceId}
          and id = ${request.articleId}
          and status = ${state.articleStatus}
      `,
      sql`
        update article_heads set
          published_revision_id = ${request.revisionId},
          published_revision_number = ${request.expectedWorkingRevisionNumber},
          review_state = 'approved',
          submitted_by_member_id = null
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = ${request.expectedReviewState}
          and archived_at is null
      `,
      sql`
        update articles set
          category_id = ${state.categoryId},
          slug = ${state.slug},
          title = ${state.title},
          mdx = ${state.mdx},
          content_hash = null,
          status = 'published',
          is_faq = ${state.isFaq ? 1 : 0},
          author_name = ${state.authorName},
          position = ${state.position},
          published_at = coalesce(published_at, ${changedAtTimestamp}),
          updated_at = ${changedAtTimestamp}
        where workspace_id = ${request.workspaceId}
          and id = ${request.articleId}
          and status = 'draft'
      `,
      sql`
        delete from article_assets
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
      `,
      sql`
        insert into article_assets (article_id, asset_id, workspace_id, created_at)
        select ${request.articleId}, revision_asset.asset_id, ${request.workspaceId}, ${changedAtTimestamp}
        from article_revision_assets revision_asset
        where revision_asset.workspace_id = ${request.workspaceId}
          and revision_asset.article_id = ${request.articleId}
          and revision_asset.revision_id = ${request.revisionId}
          and revision_asset.revision_number = ${request.expectedWorkingRevisionNumber}
      `,
      ...articleEvidenceCommitStatements(database, [evidence], changedAt),
      sql`
        update article_heads set review_state = 'published'
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and published_revision_id = ${request.revisionId}
          and published_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = 'approved'
          and archived_at is null
      `,
      sql`
        delete from article_slug_claims
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and normalized_slug = ${state.articleSlug}
          and normalized_slug <> ${state.slug}
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
      reviewEventInsert(request, eventId, specification.action, note, publishedAt),
    ];

    try {
      await executeAtomically(database, statements);
    } catch (error) {
      return classifyWorkflowFailure(
        database,
        request,
        specification,
        category,
        assetHashes,
        changedAt,
        error,
      );
    }
    return workflowTransitionResult(
      request,
      eventId,
      specification.action,
      "published",
      "published",
      evidence.job.id,
      approvalEventId,
    );
  }

  async function runUnpublish(
    request: UnpublishArticleRequest,
    note: string | null,
  ): Promise<ArticleWorkflowResult> {
    if (!validWorkflowRevisionNumber(request)) {
      return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
    }
    const specification: WorkflowSpecification = {
      action: "unpublished",
      allowedStates: ["editing", "in_review", "changes_requested", "approved", "published"],
      nextState: request.expectedReviewState,
      roles: ["administrator", "reviewer"],
    };
    const changedAt = draftRepositoryClock(options);
    const [state, authorized] = await Promise.all([
      readCurrentDraft(database, request.workspaceId, request.articleId),
      actorIsAuthorized(database, request.workspaceId, request.actor, changedAt, specification.roles),
      authoringIsOpen(database, request.workspaceId),
    ]);
    if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
    const conflict = workflowConflict(state, request, specification.allowedStates);
    if (conflict) return conflict;
    if (state.articleStatus !== "published") {
      return {
        status: "conflict",
        code: "INVALID_PUBLICATION_STATE",
        currentRevisionNumber: state.revisionNumber,
        currentReviewState: state.reviewState,
      };
    }
    const nextState =
      state.revisionId === state.publishedRevisionId ? "approved" : state.reviewState;
    const eventId = draftRepositoryReviewEventId(options);
    const changedAtTimestamp = changedAt.getTime();
    const statements = [
      authoringAssertion(request.workspaceId, "sqlite"),
      actorAssertion(request.workspaceId, request.actor, changedAt, specification.roles),
      workflowHeadAssertion(request, state, specification.allowedStates, true),
      sql`
        update article_heads set review_state = 'approved', submitted_by_member_id = null
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = ${request.expectedReviewState}
          and archived_at is null
      `,
      ...articleEvidenceInvalidationStatements(
        database,
        request.workspaceId,
        [request.articleId],
        changedAt,
      ),
      sql`
        update articles set status = 'draft', updated_at = ${changedAtTimestamp}
        where workspace_id = ${request.workspaceId}
          and id = ${request.articleId}
          and status = 'published'
      `,
      sql`
        update article_heads set
          review_state = ${nextState},
          submitted_by_member_id = ${nextState === "in_review" ? state.submittedByMemberId : null}
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = 'approved'
          and archived_at is null
      `,
      reviewEventInsert(
        request,
        eventId,
        "unpublished",
        note,
        changedAt,
        state.publishedRevisionId!,
        state.publishedRevisionNumber!,
      ),
    ];
    try {
      await executeAtomically(database, statements);
    } catch (error) {
      return classifyWorkflowFailure(
        database,
        request,
        specification,
        null,
        [],
        changedAt,
        error,
        true,
      );
    }
    return workflowTransitionResult(
      request,
      eventId,
      "unpublished",
      nextState,
      "draft",
    );
  }

  async function runArchiveTransition(
    request: ArchiveArticleRequest | RestoreArchivedArticleRequest,
    restoring: boolean,
    note: string | null,
  ): Promise<ArticleWorkflowResult> {
    if (!validWorkflowRevisionNumber(request)) {
      return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
    }
    const changedAt = draftRepositoryClock(options);
    const changedAtTimestamp = changedAt.getTime();
    const roles: readonly WorkflowRole[] = restoring
      ? ["administrator", "editor"]
      : ["administrator", "reviewer"];
    const [state, authorized] = await Promise.all([
      readCurrentDraft(database, request.workspaceId, request.articleId),
      actorIsAuthorized(database, request.workspaceId, request.actor, changedAt, roles),
      authoringIsOpen(database, request.workspaceId),
    ]);
    if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
    const conflict = archiveStateConflict(state, request, restoring);
    if (conflict) return conflict;

    const nextState = restoring
      ? "editing"
      : state.revisionId === state.publishedRevisionId
        ? "approved"
        : state.reviewState;
    const eventId = draftRepositoryReviewEventId(options);
    const lockedReviewState =
      !restoring && state.articleStatus === "published"
        ? "approved"
        : request.expectedReviewState;
    const statements: SQL[] = [
      authoringAssertion(request.workspaceId, "sqlite"),
      actorAssertion(request.workspaceId, request.actor, changedAt, roles),
      archiveHeadAssertion(request, restoring),
      ...(!restoring && state.articleStatus === "published"
        ? [
            sql`
              update article_heads set
                review_state = 'approved',
                submitted_by_member_id = null
              where workspace_id = ${request.workspaceId}
                and article_id = ${request.articleId}
                and working_revision_id = ${request.revisionId}
                and working_revision_number = ${request.expectedWorkingRevisionNumber}
                and review_state = ${request.expectedReviewState}
                and archived_at is null
            `,
          ]
        : []),
      ...(restoring
        ? []
        : articleEvidenceInvalidationStatements(
            database,
            request.workspaceId,
            [request.articleId],
            changedAt,
          )),
      ...(restoring
        ? []
        : [
            sql`
              update articles set status = 'draft', updated_at = ${changedAtTimestamp}
              where workspace_id = ${request.workspaceId}
                and id = ${request.articleId}
                and status = ${request.expectedPublicStatus}
            `,
          ]),
      sql`
        update article_heads set
          review_state = ${nextState},
          submitted_by_member_id = ${nextState === "in_review" ? state.submittedByMemberId : null},
          archived_at = ${restoring ? null : changedAtTimestamp},
          archived_by_member_id = ${restoring ? null : request.actor.memberId}
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${request.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = ${lockedReviewState}
          and ${restoring ? sql`archived_at is not null` : sql`archived_at is null`}
      `,
      ...(restoring
        ? []
        : [
            sql`
              update article_preview_grants set
                revoked_at = max(created_at, ${changedAtTimestamp}),
                revoked_by_member_id = ${request.actor.memberId}
              where workspace_id = ${request.workspaceId}
                and revoked_at is null
                and exists (
                  select 1 from article_revisions revision
                  where revision.workspace_id = article_preview_grants.workspace_id
                    and revision.id = article_preview_grants.revision_id
                    and revision.article_id = ${request.articleId}
                )
            `,
          ]),
      reviewEventInsert(
        request,
        eventId,
        restoring ? "restored" : "archived",
        note,
        changedAt,
      ),
    ];

    try {
      await executeAtomically(database, statements);
    } catch (error) {
      return classifyArchiveFailure(database, request, changedAt, error, restoring);
    }
    return workflowTransitionResult(
      request,
      eventId,
      restoring ? "restored" : "archived",
      nextState,
      "draft",
    );
  }

  async function runRestoreRevision(
    request: RestoreRevisionAsDraftRequest,
  ): Promise<ArticleWorkflowResult> {
    if (
      !Number.isSafeInteger(request.expectedWorkingRevisionNumber) ||
      request.expectedWorkingRevisionNumber < 1 ||
      !Number.isSafeInteger(request.sourceRevisionNumber) ||
      request.sourceRevisionNumber < 1
    ) {
      return { status: "rejected", code: "INVALID_REVISION_NUMBER" };
    }
    const changedAt = draftRepositoryClock(options);
    const [state, authorized] = await Promise.all([
      readCurrentDraft(database, request.workspaceId, request.articleId),
      actorIsAuthorized(database, request.workspaceId, request.actor, changedAt),
      authoringIsOpen(database, request.workspaceId),
    ]);
    if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
    if (!state) return { status: "rejected", code: "ARTICLE_NOT_FOUND" };
    if (state.revisionNumber !== request.expectedWorkingRevisionNumber) {
      return {
        status: "conflict",
        code: "STALE_REVISION",
        currentRevisionNumber: state.revisionNumber,
        currentReviewState: state.reviewState,
      };
    }
    if (state.reviewState === "in_review") {
      return {
        status: "conflict",
        code: "INVALID_REVIEW_STATE",
        currentRevisionNumber: state.revisionNumber,
        currentReviewState: state.reviewState,
      };
    }
    if (state.reviewState !== request.expectedReviewState) {
      return {
        status: "conflict",
        code: "INVALID_REVIEW_STATE",
        currentRevisionNumber: state.revisionNumber,
        currentReviewState: state.reviewState,
      };
    }
    if (state.archivedAt) return { status: "rejected", code: "ARTICLE_ARCHIVED" };
    const source = await readHistoricalRevision(
      database,
      request.workspaceId,
      request.articleId,
      request.sourceRevisionId,
      request.sourceRevisionNumber,
    );
    if (!source) return { status: "rejected", code: "REVISION_NOT_FOUND" };
    if (!restorableRevisionStructureIsValid(source)) {
      return { status: "rejected", code: "UNSAFE_REVISION" };
    }
    try {
      await validateArticleMdx(source.mdx, source.title);
    } catch {
      return { status: "rejected", code: "UNSAFE_REVISION" };
    }

    const [category, historicalAssets] = await Promise.all([
      readCategory(database, request.workspaceId, source.categoryId),
      readHistoricalAssetState(
        database,
        request.workspaceId,
        request.articleId,
        source.revisionId,
        source.revisionNumber,
      ),
    ]);
    if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };
    if (!historicalAssets.complete) {
      return { status: "rejected", code: "ASSET_UNAVAILABLE" };
    }
    if (
      (await articleRevisionHash(
        historicalSnapshot(
          request.workspaceId,
          request.articleId,
          source,
          historicalAssets.hashes,
        ),
      )) !== source.revisionHash
    ) {
      return { status: "rejected", code: "REVISION_INTEGRITY_FAILED" };
    }
    if (
      !(await slugIsAvailable(
        database,
        request.workspaceId,
        request.articleId,
        source.slug,
      ))
    ) {
      return { status: "conflict", code: "SLUG_CONFLICT" };
    }

    const revisionNumber = request.expectedWorkingRevisionNumber + 1;
    const revisionId = draftRepositoryRevisionId(options);
    const eventId = draftRepositoryReviewEventId(options);
    const note = draftChangeSummary(request.changeSummary);
    const neverPublished = state.publishedRevisionId === null;
    const restoredHash = await articleRevisionHash({
      ...historicalSnapshot(
        request.workspaceId,
        request.articleId,
        source,
        historicalAssets.hashes,
      ),
      categoryId: category.id,
      categorySlug: category.slug,
      categoryName: category.name,
    });
    const statements = [
      authoringAssertion(request.workspaceId, "sqlite"),
      actorAssertion(request.workspaceId, request.actor, changedAt),
      categoryAssertion(request.workspaceId, category),
      restoreHeadAssertion(request, state),
      historicalRevisionAssertion(request, source),
      slugAssertion(request.workspaceId, request.articleId, source.slug, false),
      assetAssertion(
        request.workspaceId,
        historicalAssets.hashes,
        undefined,
        source.revisionId,
        changedAt,
      ),
      revisionAssetSetAssertion(
        request.workspaceId,
        source.revisionId,
        historicalAssets.hashes,
      ),
      upsertSlugClaim(
        request.workspaceId,
        request.articleId,
        source.slug,
        neverPublished,
      ),
      rollbackRevisionInsert(
        request,
        source,
        category,
        revisionId,
        revisionNumber,
        restoredHash,
        changedAt,
      ),
      rollbackRevisionAssetInsert(request, revisionId, revisionNumber),
      sql`
        update article_heads set
          working_revision_id = ${revisionId},
          working_revision_number = ${revisionNumber},
          working_slug = ${source.slug},
          review_state = 'editing',
          submitted_by_member_id = null
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and working_revision_id = ${state.revisionId}
          and working_revision_number = ${request.expectedWorkingRevisionNumber}
          and review_state = ${request.expectedReviewState}
          and archived_at is null
      `,
      ...(neverPublished
        ? [
            sql`
              update articles set slug = ${source.slug}, category_id = ${category.id}
              where workspace_id = ${request.workspaceId}
                and id = ${request.articleId}
                and status = 'draft'
                and exists (
                  select 1 from article_heads
                  where workspace_id = ${request.workspaceId}
                    and article_id = ${request.articleId}
                    and working_revision_id = ${revisionId}
                    and published_revision_id is null
                )
            `,
          ]
        : []),
      sql`
        delete from article_slug_claims
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and normalized_slug = ${state.workingSlug}
          and normalized_slug <> ${source.slug}
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
        where workspace_id = ${request.workspaceId}
          and article_id = ${request.articleId}
          and normalized_slug = ${state.workingSlug}
          and normalized_slug <> ${source.slug}
          and article_row_claim = 1
      `,
      restoredRevisionEventInsert(
        request,
        eventId,
        revisionId,
        revisionNumber,
        note,
        changedAt,
      ),
    ];

    try {
      await executeAtomically(database, statements);
    } catch (error) {
      return classifyRestoreRevisionFailure(
        database,
        request,
        source,
        category,
        historicalAssets.hashes,
        changedAt,
        error,
      );
    }
    return {
      status: "transitioned",
      action: "restored",
      articleId: request.articleId,
      eventId,
      publicStatus: state.articleStatus,
      reviewState: "editing",
      revisionId,
      revisionNumber,
    };
  }

  return withAuthoringErrorBoundary<ArticleDraftRepository>({
    async archiveArticle(request) {
      return runArchiveTransition(request, false, draftReviewNote(request.note));
    },

    async approveAndPublishArticleRevision(request) {
      return runPublication(request, "approve_and_publish", draftReviewNote(request.note));
    },

    async approveArticleRevision(request) {
      return runReviewTransition(
        request,
        {
          action: "approved",
          allowedStates: ["in_review"],
          nextState: "approved",
          roles: ["administrator", "reviewer"],
          categoryMustMatch: true,
          independentActor: true,
        },
        draftReviewNote(request.note),
      );
    },

    async createDraftArticle(request) {
      const changedAt = draftRepositoryClock(options);
      const { manifestId, hashes } = prepareAssetSelection(request.assets);
      const [category, authorized] = await Promise.all([
        readCategory(database, request.article.workspaceId, request.article.categoryId),
        actorIsAuthorized(database, request.article.workspaceId, request.actor, changedAt),
        authoringIsOpen(database, request.article.workspaceId),
      ]);
      if (!authorized) return { status: "rejected", code: "ACTOR_FORBIDDEN" };
      if (!category) return { status: "rejected", code: "CATEGORY_UNAVAILABLE" };

      const revisionId = draftRepositoryRevisionId(options);
      const revisionNumber = 1;
      const revisionHash = await articleRevisionHash(snapshot(request, category, hashes));
      const statements = [
        authoringAssertion(request.article.workspaceId, "sqlite"),
        actorAssertion(request.article.workspaceId, request.actor, changedAt),
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

    async emergencyPublishArticle(request) {
      return runPublication(request, "emergency", draftReviewNote(request.reason, true));
    },

    async getArticleWorkingHead(request) {
      return readAuthorizedWorkingHead(database, request, draftRepositoryClock(options));
    },

    async getArticleRevisionDetail(request) {
      return readAuthorizedRevisionDetail(database, request, draftRepositoryClock(options));
    },

    async listArticleLibrary(request) {
      return listAuthorizedArticleLibrary(database, request, draftRepositoryClock(options));
    },

    async listArticleRevisionHistory(request) {
      return listAuthorizedRevisionHistory(database, request, draftRepositoryClock(options));
    },

    async publishArticleRevision(request) {
      return runPublication(request, "approved", null);
    },

    async requestArticleChanges(request) {
      return runReviewTransition(
        request,
        {
          action: "changes_requested",
          allowedStates: ["in_review"],
          nextState: "changes_requested",
          roles: ["administrator", "reviewer"],
          independentActor: true,
        },
        draftReviewNote(request.note, true),
      );
    },

    async restoreArchivedArticle(request) {
      return runArchiveTransition(request, true, draftReviewNote(request.note));
    },

    async restoreRevisionAsDraft(request) {
      return runRestoreRevision(request);
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
        actorIsAuthorized(database, request.article.workspaceId, request.actor, changedAt),
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
            actorAssertion(request.article.workspaceId, request.actor, changedAt),
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
        actorAssertion(request.article.workspaceId, request.actor, changedAt),
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
            review_state = 'editing',
            submitted_by_member_id = null
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
                update articles set
                  slug = ${request.article.slug},
                  category_id = ${category.id}
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

    async submitArticleForReview(request) {
      return runReviewTransition(
        request,
        {
          action: "submitted",
          allowedStates: ["editing", "changes_requested"],
          nextState: "in_review",
          roles: ["administrator", "editor"],
          categoryMustMatch: true,
        },
        draftReviewNote(request.note),
      );
    },

    async unpublishArticle(request) {
      return runUnpublish(request, draftReviewNote(request.note));
    },

    async withdrawArticleReview(request) {
      return runReviewTransition(
        request,
        {
          action: "withdrawn",
          allowedStates: ["in_review"],
          nextState: "editing",
          roles: ["administrator", "editor"],
          submittingActor: true,
        },
        draftReviewNote(request.note),
      );
    },
  });
}
