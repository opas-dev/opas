// ABOUTME: Applies the team-authoring baseline backfill to SQLite databases.
// ABOUTME: Uses one serialized transaction per 25-article chunk and installs final guards.

import type Database from "better-sqlite3";

import {
  migrationRevisionActorLabel,
  teamAuthoringBackfillVersion,
  type TeamAuthoringBackfillArticle,
  type TeamAuthoringBackfillCompletion,
  type TeamAuthoringBackfillInspection,
  type TeamAuthoringBackfillStore,
  type TeamAuthoringBaseline,
  type TeamAuthoringStoredBaseline,
} from "@/db/team-authoring-backfill";

export type SqliteTeamAuthoringSourceRow = {
  article_id: string;
  asset_hash: string | null;
  asset_id: string | null;
  author_name: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  is_faq: number;
  mdx: string;
  position: number;
  slug: string;
  status: "draft" | "published";
  title: string;
  workspace_id: string;
};

export type SqliteTeamAuthoringStoredSourceRow = SqliteTeamAuthoringSourceRow & {
  revision_hash: string;
  revision_id: string;
};

export const sqliteReadTeamAuthoringArticleChunkSql = `
with page as (
  select
    articles.id as article_id,
    articles.workspace_id,
    articles.category_id,
    categories.slug as category_slug,
    categories.name as category_name,
    articles.slug,
    articles.title,
    articles.mdx,
    articles.is_faq,
    articles.author_name,
    articles.position,
    articles.status
  from articles
  inner join categories
    on categories.id = articles.category_id
    and categories.workspace_id = articles.workspace_id
  where ? is null
    or articles.workspace_id > ?
    or (articles.workspace_id = ? and articles.id > ?)
  order by articles.workspace_id, articles.id
  limit ?
)
select
  page.*,
  article_assets.asset_id,
  assets.hash as asset_hash
from page
left join article_assets
  on article_assets.workspace_id = page.workspace_id
  and article_assets.article_id = page.article_id
left join assets
  on assets.workspace_id = article_assets.workspace_id
  and assets.id = article_assets.asset_id
order by page.workspace_id, page.article_id, assets.hash, article_assets.asset_id
`;

export const sqliteReadTeamAuthoringMigrationRevisionChunkSql = `
with page as (
  select
    revisions.id as revision_id,
    revisions.revision_hash,
    revisions.article_id,
    revisions.workspace_id,
    revisions.category_id,
    revisions.category_slug,
    revisions.category_name,
    revisions.slug,
    revisions.title,
    revisions.mdx,
    revisions.is_faq,
    revisions.author_name,
    revisions.position,
    articles.status
  from article_revisions revisions
  inner join articles
    on articles.id = revisions.article_id
    and articles.workspace_id = revisions.workspace_id
  where revisions.revision_number = 1
    and revisions.change_kind = 'migration'
    and revisions.created_by_member_id is null
    and revisions.created_by_system_label = ?
    and revisions.change_summary is null
    and revisions.restored_from_revision_id is null
    and (
      ? is null
      or revisions.workspace_id > ?
      or (revisions.workspace_id = ? and revisions.article_id > ?)
    )
  order by revisions.workspace_id, revisions.article_id
  limit ?
)
select
  page.*,
  revision_assets.asset_id,
  assets.hash as asset_hash
from page
left join article_revision_assets revision_assets
  on revision_assets.workspace_id = page.workspace_id
  and revision_assets.article_id = page.article_id
  and revision_assets.revision_id = page.revision_id
  and revision_assets.revision_number = 1
left join assets
  on assets.workspace_id = revision_assets.workspace_id
  and assets.id = revision_assets.asset_id
order by page.workspace_id, page.article_id, assets.hash, revision_assets.asset_id
`;

export const sqliteInsertTeamAuthoringRevisionSql = `
insert into article_revisions (
  id,
  workspace_id,
  article_id,
  revision_number,
  category_id,
  category_slug,
  category_name,
  slug,
  title,
  mdx,
  is_faq,
  author_name,
  position,
  revision_hash,
  change_kind,
  created_by_member_id,
  created_by_system_label,
  change_summary,
  created_at,
  restored_from_revision_id
)
select ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration', null, ?, null,
  articles.updated_at, null
from articles
where articles.workspace_id = ? and articles.id = ?
on conflict (id) do nothing
`;

export const sqliteInsertTeamAuthoringRevisionAssetSql = `
insert into article_revision_assets (
  workspace_id,
  article_id,
  revision_id,
  revision_number,
  asset_id
) values (?, ?, ?, 1, ?)
on conflict (revision_id, asset_id) do nothing
`;

export const sqliteInsertTeamAuthoringSlugClaimSql = `
insert into article_slug_claims (
  workspace_id,
  normalized_slug,
  article_id,
  working_claim,
  article_row_claim
) values (?, ?, ?, 1, 1)
on conflict (workspace_id, normalized_slug) do nothing
`;

export const sqliteInsertTeamAuthoringHeadSql = `
insert into article_heads (
  article_id,
  workspace_id,
  working_revision_id,
  working_revision_number,
  working_slug,
  published_revision_id,
  published_revision_number,
  review_state,
  archived_at,
  archived_by_member_id
) values (?, ?, ?, 1, ?, ?, ?, ?, null, null)
on conflict (article_id, workspace_id) do nothing
`;

export function sqliteTeamAuthoringSourceArticles(
  rows: readonly SqliteTeamAuthoringSourceRow[],
) {
  const articles = new Map<string, TeamAuthoringBackfillArticle>();
  for (const row of rows) {
    const key = `${row.workspace_id}\u0000${row.article_id}`;
    let article = articles.get(key);
    if (!article) {
      article = {
        articleId: row.article_id,
        assetIdsAndHashes: [],
        authorName: row.author_name,
        categoryId: row.category_id,
        categoryName: row.category_name,
        categorySlug: row.category_slug,
        isFaq: row.is_faq === 1,
        mdx: row.mdx,
        position: row.position,
        slug: row.slug,
        status: row.status,
        title: row.title,
        workspaceId: row.workspace_id,
      };
      articles.set(key, article);
    }
    if (row.asset_id !== null || row.asset_hash !== null) {
      if (row.asset_id === null || row.asset_hash === null) {
        throw new Error("AUTHORING_BACKFILL_ASSET_INVALID");
      }
      (article.assetIdsAndHashes as Array<{ hash: string; id: string }>).push({
        hash: row.asset_hash,
        id: row.asset_id,
      });
    }
  }
  return [...articles.values()];
}

export function sqliteTeamAuthoringStoredBaselines(
  rows: readonly SqliteTeamAuthoringStoredSourceRow[],
) {
  const references = new Map<
    string,
    Pick<TeamAuthoringStoredBaseline, "revisionHash" | "revisionId">
  >();
  for (const row of rows) {
    references.set(`${row.workspace_id}\u0000${row.article_id}`, {
      revisionHash: row.revision_hash,
      revisionId: row.revision_id,
    });
  }
  return sqliteTeamAuthoringSourceArticles(rows).map((article) => ({
    article,
    ...references.get(`${article.workspaceId}\u0000${article.articleId}`)!,
  }));
}

function inspect(database: Database.Database): TeamAuthoringBackfillInspection {
  const rows = database
    .prepare(
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
    )
    .all(teamAuthoringBackfillVersion) as Array<{
    completed_version: number | null;
    pending_article_count: number;
    workspace_id: string;
    writes_paused: number | null;
  }>;
  if (rows.some((row) => row.writes_paused !== 1)) {
    throw new Error("AUTHORING_MIGRATION_REQUIRES_PAUSE");
  }
  return {
    completedWorkspaceIds: rows
      .filter((row) => row.completed_version === teamAuthoringBackfillVersion)
      .map((row) => row.workspace_id),
    guardsInstalled:
      (
        database
          .prepare(
            `select count(*) as count
             from sqlite_master
             where type = 'trigger'
               and name = 'article_heads_authoring_control_insert_trigger'`,
          )
          .get() as { count: number }
      ).count === 1,
    pendingArticleCount: rows.reduce(
      (count, row) => count + row.pending_article_count,
      0,
    ),
    workspaceIds: rows.map((row) => row.workspace_id),
  };
}

function assertBaseline(database: Database.Database, baseline: TeamAuthoringBaseline) {
  database
    .prepare(
      `insert into team_authoring_backfill_assertions
         (workspace_id, article_id, revision_id, revision_hash)
       values (?, ?, ?, ?)`,
    )
    .run(
      baseline.article.workspaceId,
      baseline.article.articleId,
      baseline.revisionId,
      baseline.revisionHash,
    );
}

function insertBaseline(database: Database.Database, baseline: TeamAuthoringBaseline) {
  const article = baseline.article;
  database.prepare(sqliteInsertTeamAuthoringRevisionSql).run(
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
  );
  const insertAsset = database.prepare(sqliteInsertTeamAuthoringRevisionAssetSql);
  for (const { id } of article.assetIdsAndHashes) {
    insertAsset.run(article.workspaceId, article.articleId, baseline.revisionId, id);
  }
  database
    .prepare(sqliteInsertTeamAuthoringSlugClaimSql)
    .run(article.workspaceId, article.slug, article.articleId);
  const published = article.status === "published";
  database.prepare(sqliteInsertTeamAuthoringHeadSql).run(
    article.articleId,
    article.workspaceId,
    baseline.revisionId,
    article.slug,
    published ? baseline.revisionId : null,
    published ? 1 : null,
    published ? "published" : "editing",
  );
  assertBaseline(database, baseline);
}

function verifyAudit(
  database: Database.Database,
  rows: readonly TeamAuthoringBackfillCompletion[],
  requireBaselineProjection = true,
) {
  for (const row of rows) {
    if (requireBaselineProjection) {
      const counts = database
        .prepare(
          `select
             (select count(*) from articles where workspace_id = ?) as articles,
             (select count(*) from article_heads where workspace_id = ?) as heads,
             (select count(*) from article_revisions
               where workspace_id = ? and revision_number = 1) as revisions,
             (select count(*) from article_slug_claims
               where workspace_id = ? and working_claim = 1 and article_row_claim = 1) as claims`,
        )
        .get(
          row.workspaceId,
          row.workspaceId,
          row.workspaceId,
          row.workspaceId,
        ) as { articles: number; claims: number; heads: number; revisions: number };
      if (
        counts.articles !== row.articleCount ||
        counts.heads !== row.articleCount ||
        counts.revisions !== row.articleCount ||
        counts.claims !== row.articleCount
      ) {
        throw new Error("AUTHORING_BACKFILL_AUDIT_FAILED");
      }
    }
    const ledger = database
      .prepare(
        `select article_count, projection_hash
         from workspace_authoring_migrations
         where workspace_id = ? and version = ?`,
      )
      .get(row.workspaceId, teamAuthoringBackfillVersion) as
      | { article_count: number; projection_hash: string }
      | undefined;
    if (
      ledger &&
      (ledger.article_count !== row.articleCount ||
        ledger.projection_hash !== row.projectionHash)
    ) {
      throw new Error("AUTHORING_BACKFILL_LEDGER_MISMATCH");
    }
  }
  if ((database.prepare("select count(*) as count from article_heads").get() as {
    count: number;
  }).count !== (database.prepare("select count(*) as count from articles").get() as {
    count: number;
  }).count) {
    throw new Error("AUTHORING_BACKFILL_MISSING_HEAD");
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("AUTHORING_BACKFILL_FOREIGN_KEY_FAILED");
  }
}

function authoringControlTriggers(table: string) {
  return [
    `create trigger \`${table}_authoring_control_insert_trigger\`
before insert on \`${table}\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
    `create trigger \`${table}_authoring_control_update_trigger\`
before update on \`${table}\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = old.\`workspace_id\` and \`writes_paused\` = 0
) or not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
    `create trigger \`${table}_authoring_control_delete_trigger\`
before delete on \`${table}\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and not exists (
    select 1 from \`workspace_authoring_controls\`
    where \`workspace_id\` = old.\`workspace_id\` and \`writes_paused\` = 0
  )
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  ];
}

const headIntegrityCondition = `not exists (
  select 1
  from articles article
  inner join article_revisions working
    on working.workspace_id = new.workspace_id
    and working.article_id = new.article_id
    and working.id = new.working_revision_id
    and working.revision_number = new.working_revision_number
  inner join article_slug_claims working_claim
    on working_claim.workspace_id = new.workspace_id
    and working_claim.normalized_slug = new.working_slug
    and working_claim.article_id = new.article_id
    and working_claim.working_claim = 1
  inner join article_slug_claims row_claim
    on row_claim.workspace_id = article.workspace_id
    and row_claim.normalized_slug = article.slug
    and row_claim.article_id = article.id
    and row_claim.article_row_claim = 1
  where article.workspace_id = new.workspace_id
    and article.id = new.article_id
    and working.slug = new.working_slug
    and (new.review_state <> 'published' or article.status = 'published')
    and (
      article.status <> 'published'
      or (new.archived_at is null and exists (
        select 1
        from article_revisions published
        where published.workspace_id = new.workspace_id
          and published.article_id = new.article_id
          and published.id = new.published_revision_id
          and published.revision_number = new.published_revision_number
          and published.category_id = article.category_id
          and published.slug = article.slug
          and published.title = article.title
          and published.mdx = article.mdx
          and published.is_faq = article.is_faq
          and published.author_name = article.author_name
          and published.position = article.position
      ))
    )
)`;

const publishedMaterializationCondition = `new.status = 'published'
  and not exists (
    select 1
    from article_heads head
    inner join article_revisions published
      on published.workspace_id = head.workspace_id
      and published.article_id = head.article_id
      and published.id = head.published_revision_id
      and published.revision_number = head.published_revision_number
    inner join article_slug_claims claim
      on claim.workspace_id = new.workspace_id
      and claim.normalized_slug = new.slug
      and claim.article_id = new.id
      and claim.article_row_claim = 1
    where head.workspace_id = new.workspace_id
      and head.article_id = new.id
      and head.archived_at is null
      and head.review_state in ('approved', 'published')
      and published.category_id = new.category_id
      and published.slug = new.slug
      and published.title = new.title
      and published.mdx = new.mdx
      and published.is_faq = new.is_faq
      and published.author_name = new.author_name
      and published.position = new.position
  )`;

const draftMaterializationUpdateCondition = `new.status = 'draft'
  and (
    new.id is not old.id
    or new.workspace_id is not old.workspace_id
    or new.category_id is not old.category_id
    or new.title is not old.title
    or new.mdx is not old.mdx
    or new.content_hash is not old.content_hash
    or new.is_faq is not old.is_faq
    or new.author_name is not old.author_name
    or new.position is not old.position
    or new.published_at is not old.published_at
    or new.created_at is not old.created_at
    or (old.status = 'published' and new.slug is not old.slug)
  )`;

export const sqliteTeamAuthoringGuardStatements: readonly string[] = [
  ...authoringControlTriggers("article_heads"),
  ...authoringControlTriggers("article_slug_claims"),
  `create trigger \`article_revisions_authoring_control_insert_trigger\`
before insert on \`article_revisions\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  `create trigger \`article_revisions_immutable_update_trigger\`
before update on \`article_revisions\`
for each row
begin
  select raise(abort, 'ARTICLE_REVISION_IMMUTABLE');
end`,
  `create trigger \`article_revisions_immutable_delete_trigger\`
before delete on \`article_revisions\`
for each row
when exists (
  select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`
)
  and exists (
    select 1 from \`articles\`
    where \`id\` = old.\`article_id\` and \`workspace_id\` = old.\`workspace_id\`
)
begin
  select raise(abort, 'ARTICLE_REVISION_IMMUTABLE');
end`,
  `create trigger \`article_revision_assets_authoring_control_insert_trigger\`
before insert on \`article_revision_assets\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  `create trigger \`article_revision_assets_immutable_update_trigger\`
before update on \`article_revision_assets\`
for each row
begin
  select raise(abort, 'ARTICLE_REVISION_ASSET_IMMUTABLE');
end`,
  `create trigger \`article_revision_assets_immutable_delete_trigger\`
before delete on \`article_revision_assets\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and exists (select 1 from \`article_revisions\` where \`id\` = old.\`revision_id\`)
begin
  select raise(abort, 'ARTICLE_REVISION_ASSET_IMMUTABLE');
end`,
  `create trigger \`assets_revision_history_delete_trigger\`
before delete on \`assets\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and exists (
    select 1 from \`article_revision_assets\`
    where \`workspace_id\` = old.\`workspace_id\` and \`asset_id\` = old.\`id\`
  )
begin
  select raise(abort, 'ASSET_IN_REVISION');
end`,
  `create trigger \`article_review_events_authoring_control_insert_trigger\`
before insert on \`article_review_events\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  `create trigger \`article_review_events_immutable_update_trigger\`
before update on \`article_review_events\`
for each row
begin
  select raise(abort, 'ARTICLE_REVIEW_EVENT_IMMUTABLE');
end`,
  `create trigger \`article_review_events_immutable_delete_trigger\`
before delete on \`article_review_events\`
for each row
when exists (
  select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`
)
  and exists (
    select 1 from \`articles\`
    where \`id\` = old.\`article_id\` and \`workspace_id\` = old.\`workspace_id\`
)
begin
  select raise(abort, 'ARTICLE_REVIEW_EVENT_IMMUTABLE');
end`,
  `create trigger \`article_preview_grants_authoring_control_insert_trigger\`
before insert on \`article_preview_grants\`
for each row
when not exists (
  select 1 from \`workspace_authoring_controls\`
  where \`workspace_id\` = new.\`workspace_id\` and \`writes_paused\` = 0
)
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  `create trigger \`article_preview_grants_revocation_update_trigger\`
before update on \`article_preview_grants\`
for each row
when not (
  old.\`revoked_at\` is null
  and old.\`revoked_by_member_id\` is null
  and new.\`revoked_at\` is not null
  and new.\`revoked_by_member_id\` is not null
  and new.\`id\` = old.\`id\`
  and new.\`workspace_id\` = old.\`workspace_id\`
  and new.\`revision_id\` = old.\`revision_id\`
  and new.\`created_by_member_id\` = old.\`created_by_member_id\`
  and new.\`expires_at\` = old.\`expires_at\`
  and new.\`created_at\` = old.\`created_at\`
)
begin
  select raise(abort, 'PREVIEW_GRANT_IMMUTABLE');
end`,
  `create trigger \`article_preview_grants_authoring_control_delete_trigger\`
before delete on \`article_preview_grants\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and not exists (
    select 1 from \`workspace_authoring_controls\`
    where \`workspace_id\` = old.\`workspace_id\` and \`writes_paused\` = 0
  )
begin
  select raise(abort, 'AUTHORING_PAUSED');
end`,
  `create trigger \`article_heads_integrity_insert_trigger\`
before insert on \`article_heads\`
for each row
when ${headIntegrityCondition}
begin
  select raise(abort, 'ARTICLE_HEAD_INVALID');
end`,
  `create trigger \`article_heads_integrity_update_trigger\`
before update on \`article_heads\`
for each row
when ${headIntegrityCondition}
begin
  select raise(abort, 'ARTICLE_HEAD_INVALID');
end`,
  `create trigger \`articles_materialization_insert_trigger\`
before insert on \`articles\`
for each row
when ${publishedMaterializationCondition}
begin
  select raise(abort, 'ARTICLE_MATERIALIZATION_INVALID');
end`,
  `create trigger \`articles_materialization_update_trigger\`
before update on \`articles\`
for each row
when ${publishedMaterializationCondition}
  or ${draftMaterializationUpdateCondition}
begin
  select raise(abort, 'ARTICLE_MATERIALIZATION_INVALID');
end`,
  `create trigger \`articles_history_delete_trigger\`
before delete on \`articles\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and exists (
    select 1 from \`article_heads\`
    where \`workspace_id\` = old.\`workspace_id\` and \`article_id\` = old.\`id\`
  )
begin
  select raise(abort, 'ARTICLE_DELETE_FORBIDDEN');
end`,
  `create trigger \`article_slug_claims_integrity_update_trigger\`
before update on \`article_slug_claims\`
for each row
when (exists (
  select 1 from \`articles\`
  where \`workspace_id\` = old.\`workspace_id\`
    and \`id\` = old.\`article_id\`
    and \`slug\` = old.\`normalized_slug\`
) and not (
  new.\`workspace_id\` = old.\`workspace_id\`
  and new.\`article_id\` = old.\`article_id\`
  and new.\`normalized_slug\` = old.\`normalized_slug\`
  and new.\`article_row_claim\` = 1
)) or (exists (
  select 1 from \`article_heads\`
  where \`workspace_id\` = old.\`workspace_id\`
    and \`article_id\` = old.\`article_id\`
    and \`working_slug\` = old.\`normalized_slug\`
) and not (
  new.\`workspace_id\` = old.\`workspace_id\`
  and new.\`article_id\` = old.\`article_id\`
  and new.\`normalized_slug\` = old.\`normalized_slug\`
  and new.\`working_claim\` = 1
))
begin
  select raise(abort, 'ARTICLE_SLUG_CLAIM_INVALID');
end`,
  `create trigger \`article_slug_claims_integrity_delete_trigger\`
before delete on \`article_slug_claims\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and (exists (
  select 1 from \`articles\`
  where \`workspace_id\` = old.\`workspace_id\`
    and \`id\` = old.\`article_id\`
    and \`slug\` = old.\`normalized_slug\`
) or exists (
  select 1 from \`article_heads\`
  where \`workspace_id\` = old.\`workspace_id\`
    and \`article_id\` = old.\`article_id\`
    and \`working_slug\` = old.\`normalized_slug\`
))
begin
  select raise(abort, 'ARTICLE_SLUG_CLAIM_INVALID');
end`,
  `create trigger \`categories_current_revision_delete_trigger\`
before delete on \`categories\`
for each row
when exists (select 1 from \`workspaces\` where \`id\` = old.\`workspace_id\`)
  and (exists (
  select 1 from \`articles\`
  where \`workspace_id\` = old.\`workspace_id\`
    and \`category_id\` = old.\`id\`
) or exists (
  select 1
  from \`article_heads\` head
  inner join \`article_revisions\` working
    on working.\`workspace_id\` = head.\`workspace_id\`
    and working.\`article_id\` = head.\`article_id\`
    and working.\`id\` = head.\`working_revision_id\`
    and working.\`revision_number\` = head.\`working_revision_number\`
  left join \`article_revisions\` published
    on published.\`workspace_id\` = head.\`workspace_id\`
    and published.\`article_id\` = head.\`article_id\`
    and published.\`id\` = head.\`published_revision_id\`
    and published.\`revision_number\` = head.\`published_revision_number\`
  where head.\`workspace_id\` = old.\`workspace_id\`
    and (working.\`category_id\` = old.\`id\` or published.\`category_id\` = old.\`id\`)
))
begin
  select raise(abort, 'CATEGORY_IN_USE');
end`,
];

export function createSqliteTeamAuthoringBackfillStore(
  database: Database.Database,
): TeamAuthoringBackfillStore {
  return {
    async applyChunk(rows) {
      database.transaction(() => {
        database
          .prepare("insert into team_authoring_pause_assertions (assertion) values (1)")
          .run();
        for (const row of rows) insertBaseline(database, row);
      })();
    },
    async assertAllWorkspacesPaused() {
      return inspect(database);
    },
    async audit(rows) {
      database.transaction(() => {
        database
          .prepare("insert into team_authoring_pause_assertions (assertion) values (1)")
          .run();
        verifyAudit(database, rows);
      })();
    },
    async auditCompleted(rows) {
      database.transaction(() => {
        database
          .prepare("insert into team_authoring_pause_assertions (assertion) values (1)")
          .run();
        verifyAudit(database, rows, false);
      })();
    },
    async finalize(rows, installGuards) {
      database.transaction(() => {
        database
          .prepare("insert into team_authoring_pause_assertions (assertion) values (1)")
          .run();
        const insert = database.prepare(
          `insert into workspace_authoring_migrations
             (workspace_id, version, article_count, projection_hash, completed_at)
           values (?, ?, ?, ?, ?)
           on conflict (workspace_id, version) do nothing`,
        );
        for (const row of rows) {
          insert.run(
            row.workspaceId,
            row.version,
            row.articleCount,
            row.projectionHash,
            row.completedAt.getTime(),
          );
        }
        if (installGuards) {
          for (const statement of sqliteTeamAuthoringGuardStatements) {
            database.exec(statement);
          }
        }
        verifyAudit(database, rows, installGuards);
      })();
    },
    async readArticleChunk(cursor, limit) {
      const workspaceId = cursor?.workspaceId ?? null;
      const articleId = cursor?.articleId ?? "";
      return sqliteTeamAuthoringSourceArticles(
        database
          .prepare(sqliteReadTeamAuthoringArticleChunkSql)
          .all(
            workspaceId,
            workspaceId,
            workspaceId,
            articleId,
            limit,
          ) as SqliteTeamAuthoringSourceRow[],
      );
    },
    async readMigrationRevisionChunk(cursor, limit) {
      const workspaceId = cursor?.workspaceId ?? null;
      const articleId = cursor?.articleId ?? "";
      return sqliteTeamAuthoringStoredBaselines(
        database
          .prepare(sqliteReadTeamAuthoringMigrationRevisionChunkSql)
          .all(
            migrationRevisionActorLabel,
            workspaceId,
            workspaceId,
            workspaceId,
            articleId,
            limit,
          ) as SqliteTeamAuthoringStoredSourceRow[],
      );
    },
    async verifyChunk(rows) {
      database.transaction(() => {
        database
          .prepare("insert into team_authoring_pause_assertions (assertion) values (1)")
          .run();
        for (const row of rows) assertBaseline(database, row);
      })();
    },
  };
}
