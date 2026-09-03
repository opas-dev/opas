// ABOUTME: Applies the team-authoring baseline backfill to Postgres and Neon-compatible SQL.
// ABOUTME: Holds the workspace fence through each chunk and installs audited final guards.

import type { Pool, PoolClient } from "pg";

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

type SourceRow = {
  article_id: string;
  asset_hash: string | null;
  asset_id: string | null;
  author_name: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  is_faq: boolean;
  mdx: string;
  position: number;
  slug: string;
  status: "draft" | "published";
  title: string;
  workspace_id: string;
};

type Queryable = Pick<Pool | PoolClient, "query">;

type StoredSourceRow = SourceRow & {
  revision_hash: string;
  revision_id: string;
};

const readArticleChunkSql = `
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
  where $1::text is null
    or articles.workspace_id > $1
    or (articles.workspace_id = $1 and articles.id > $2)
  order by articles.workspace_id, articles.id
  limit $3
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

const readMigrationRevisionChunkSql = `
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
    and revisions.created_by_system_label = $4
    and revisions.change_summary is null
    and revisions.restored_from_revision_id is null
    and (
      $1::text is null
      or revisions.workspace_id > $1
      or (revisions.workspace_id = $1 and revisions.article_id > $2)
    )
  order by revisions.workspace_id, revisions.article_id
  limit $3
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

const revisionAwareArticleCondition = `
exists (
  select 1
  from article_heads head
  inner join article_revisions working
    on working.workspace_id = head.workspace_id
    and working.article_id = head.article_id
    and working.id = head.working_revision_id
    and working.revision_number = head.working_revision_number
  where head.workspace_id = articles.workspace_id
    and head.article_id = articles.id
    and exists (
      select 1 from article_slug_claims working_claim
      where working_claim.workspace_id = head.workspace_id
        and working_claim.article_id = head.article_id
        and working_claim.normalized_slug = head.working_slug
        and working_claim.working_claim
    )
    and exists (
      select 1 from article_slug_claims article_claim
      where article_claim.workspace_id = articles.workspace_id
        and article_claim.article_id = articles.id
        and article_claim.normalized_slug = articles.slug
        and article_claim.article_row_claim
    )
    and (
      (
        head.published_revision_id is null
        and head.published_revision_number is null
      )
      or exists (
        select 1 from article_revisions published
        where published.workspace_id = head.workspace_id
          and published.article_id = head.article_id
          and published.id = head.published_revision_id
          and published.revision_number = head.published_revision_number
      )
    )
)
`;

const insertRevisionSql = `
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
select $1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
  'migration', null, $14, null, articles.updated_at, null
from articles
where articles.workspace_id = $15 and articles.id = $16
on conflict (id) do nothing
`;

function sourceArticles(rows: readonly SourceRow[]) {
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
        isFaq: row.is_faq,
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

function storedBaselines(rows: readonly StoredSourceRow[]) {
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
  return sourceArticles(rows).map((article) => ({
    article,
    ...references.get(`${article.workspaceId}\u0000${article.articleId}`)!,
  }));
}

async function inspect(
  database: Queryable,
  lock: boolean,
): Promise<TeamAuthoringBackfillInspection> {
  if (lock) {
    await database.query("lock table workspaces in share mode");
    await database.query(
      `select controls.workspace_id
       from workspace_authoring_controls controls
       order by controls.workspace_id
       for share`,
    );
  }
  const result = await database.query<{
    completed_version: number | null;
    pending_article_count: string;
    workspace_id: string;
    writes_paused: boolean | null;
  }>(
    `select
       workspaces.id as workspace_id,
       controls.writes_paused,
       migrations.version as completed_version,
       case when migrations.version is null then (
         select count(*) from articles where articles.workspace_id = workspaces.id
       ) else (
         select count(*) from articles
         where articles.workspace_id = workspaces.id
           and not (${revisionAwareArticleCondition})
       ) end as pending_article_count
     from workspaces
     left join workspace_authoring_controls controls
       on controls.workspace_id = workspaces.id
     left join workspace_authoring_migrations migrations
       on migrations.workspace_id = workspaces.id and migrations.version = $1
     order by workspaces.id`,
    [teamAuthoringBackfillVersion],
  );
  if (result.rows.some((row) => row.writes_paused !== true)) {
    throw new Error("AUTHORING_MIGRATION_REQUIRES_PAUSE");
  }
  const guards = await database.query<{ installed: boolean }>(
    `select exists (
       select 1
       from pg_trigger
       where tgname = 'article_heads_authoring_control_trigger'
         and not tgisinternal
     ) as installed`,
  );
  return {
    completedWorkspaceIds: result.rows
      .filter((row) => row.completed_version === teamAuthoringBackfillVersion)
      .map((row) => row.workspace_id),
    guardsInstalled: guards.rows[0].installed,
    pendingArticleCount: result.rows.reduce(
      (count, row) => count + Number(row.pending_article_count),
      0,
    ),
    workspaceIds: result.rows.map((row) => row.workspace_id),
  };
}

async function assertBaseline(database: Queryable, baseline: TeamAuthoringBaseline) {
  await database.query("select opas_assert_team_authoring_baseline($1, $2, $3, $4)", [
    baseline.article.workspaceId,
    baseline.article.articleId,
    baseline.revisionId,
    baseline.revisionHash,
  ]);
}

async function insertBaseline(database: Queryable, baseline: TeamAuthoringBaseline) {
  const article = baseline.article;
  await database.query(insertRevisionSql, [
    baseline.revisionId,
    article.workspaceId,
    article.articleId,
    article.categoryId,
    article.categorySlug,
    article.categoryName,
    article.slug,
    article.title,
    article.mdx,
    article.isFaq,
    article.authorName,
    article.position,
    baseline.revisionHash,
    migrationRevisionActorLabel,
    article.workspaceId,
    article.articleId,
  ]);
  for (const { id } of article.assetIdsAndHashes) {
    await database.query(
      `insert into article_revision_assets
         (workspace_id, article_id, revision_id, revision_number, asset_id)
       values ($1, $2, $3, 1, $4)
       on conflict (revision_id, asset_id) do nothing`,
      [article.workspaceId, article.articleId, baseline.revisionId, id],
    );
  }
  await database.query(
    `insert into article_slug_claims
       (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
     values ($1, $2, $3, true, true)
     on conflict (workspace_id, normalized_slug) do nothing`,
    [article.workspaceId, article.slug, article.articleId],
  );
  const published = article.status === "published";
  await database.query(
    `insert into article_heads
       (article_id, workspace_id, working_revision_id, working_revision_number,
        working_slug, published_revision_id, published_revision_number, review_state,
        submitted_by_member_id, archived_at, archived_by_member_id)
     values ($1, $2, $3, 1, $4, $5, $6, $7, null, null, null)
     on conflict (article_id, workspace_id) do nothing`,
    [
      article.articleId,
      article.workspaceId,
      baseline.revisionId,
      article.slug,
      published ? baseline.revisionId : null,
      published ? 1 : null,
      published ? "published" : "editing",
    ],
  );
  await assertBaseline(database, baseline);
}

async function verifyAudit(
  database: Queryable,
  rows: readonly TeamAuthoringBackfillCompletion[],
  requireBaselineProjection = true,
) {
  for (const row of rows) {
    if (requireBaselineProjection) {
      const result = await database.query<{
        articles: string;
        claims: string;
        heads: string;
        revisions: string;
      }>(
        `select
           (select count(*) from articles where workspace_id = $1) as articles,
           (select count(*) from article_heads where workspace_id = $1) as heads,
           (select count(*) from article_revisions
             where workspace_id = $1 and revision_number = 1) as revisions,
           (select count(*) from article_slug_claims
             where workspace_id = $1 and working_claim and article_row_claim) as claims`,
        [row.workspaceId],
      );
      const counts = result.rows[0];
      if (
        Number(counts.articles) !== row.articleCount ||
        Number(counts.heads) !== row.articleCount ||
        Number(counts.revisions) !== row.articleCount ||
        Number(counts.claims) !== row.articleCount
      ) {
        throw new Error("AUTHORING_BACKFILL_AUDIT_FAILED");
      }
    }
    const ledger = await database.query<{
      article_count: number;
      projection_hash: string;
    }>(
      `select article_count, projection_hash
       from workspace_authoring_migrations
       where workspace_id = $1 and version = $2`,
      [row.workspaceId, teamAuthoringBackfillVersion],
    );
    if (
      ledger.rows[0] &&
      (ledger.rows[0].article_count !== row.articleCount ||
        ledger.rows[0].projection_hash !== row.projectionHash)
    ) {
      throw new Error("AUTHORING_BACKFILL_LEDGER_MISMATCH");
    }
  }
  const incomplete = await database.query<{ count: string }>(
    `select count(*) as count
     from articles
     where not (${revisionAwareArticleCondition})`,
  );
  if (Number(incomplete.rows[0].count) !== 0) {
    throw new Error("AUTHORING_BACKFILL_ARTICLE_INCOMPLETE");
  }
}

export const postgresTeamAuthoringGuardStatements: readonly string[] = [
  `create trigger "article_heads_authoring_control_trigger"
before insert or update or delete on "article_heads"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_slug_claims_authoring_control_trigger"
before insert or update or delete on "article_slug_claims"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_revisions_authoring_control_trigger"
before insert on "article_revisions"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_revision_assets_authoring_control_trigger"
before insert on "article_revision_assets"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_review_events_authoring_control_trigger"
before insert on "article_review_events"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_preview_grants_authoring_control_insert_trigger"
before insert on "article_preview_grants"
for each row execute function "opas_require_authoring_open"()`,
  `create trigger "article_preview_grants_authoring_control_delete_trigger"
before delete on "article_preview_grants"
for each row execute function "opas_require_authoring_open"()`,
  `create function "opas_reject_article_revision_mutation"()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' or (
    exists (select 1 from "workspaces" where "id" = old."workspace_id")
    and exists (
      select 1 from "articles"
      where "id" = old."article_id" and "workspace_id" = old."workspace_id"
    )
  ) then
    raise exception using message = 'ARTICLE_REVISION_IMMUTABLE', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "article_revisions_immutable_trigger"
before update or delete on "article_revisions"
for each row execute function "opas_reject_article_revision_mutation"()`,
  `create function "opas_reject_article_revision_asset_mutation"()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' or (
    exists (select 1 from "workspaces" where "id" = old."workspace_id")
    and exists (select 1 from "article_revisions" where "id" = old."revision_id")
  ) then
    raise exception using message = 'ARTICLE_REVISION_ASSET_IMMUTABLE', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "article_revision_assets_immutable_trigger"
before update or delete on "article_revision_assets"
for each row execute function "opas_reject_article_revision_asset_mutation"()`,
  `create function "opas_reject_revision_asset_delete"()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from "workspaces" where "id" = old."workspace_id") and exists (
    select 1 from "article_revision_assets"
    where "workspace_id" = old."workspace_id" and "asset_id" = old."id"
  ) then
    raise exception using message = 'ASSET_IN_REVISION', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "assets_revision_history_delete_trigger"
before delete on "assets"
for each row execute function "opas_reject_revision_asset_delete"()`,
  `create function "opas_reject_article_review_event_mutation"()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' or (
    exists (select 1 from "workspaces" where "id" = old."workspace_id")
    and exists (
      select 1 from "articles"
      where "id" = old."article_id" and "workspace_id" = old."workspace_id"
    )
  ) then
    raise exception using message = 'ARTICLE_REVIEW_EVENT_IMMUTABLE', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "article_review_events_immutable_trigger"
before update or delete on "article_review_events"
for each row execute function "opas_reject_article_review_event_mutation"()`,
  `create function "opas_require_preview_grant_revocation"()
returns trigger
language plpgsql
as $$
begin
  if not (
    old."revoked_at" is null
    and old."revoked_by_member_id" is null
    and new."revoked_at" is not null
    and new."revoked_by_member_id" is not null
    and new."id" is not distinct from old."id"
    and new."workspace_id" is not distinct from old."workspace_id"
    and new."revision_id" is not distinct from old."revision_id"
    and new."created_by_member_id" is not distinct from old."created_by_member_id"
    and new."expires_at" is not distinct from old."expires_at"
    and new."created_at" is not distinct from old."created_at"
  ) then
    raise exception using message = 'PREVIEW_GRANT_IMMUTABLE', errcode = 'P0001';
  end if;
  return new;
end;
$$`,
  `create trigger "article_preview_grants_revocation_update_trigger"
before update on "article_preview_grants"
for each row execute function "opas_require_preview_grant_revocation"()`,
  `create function "opas_require_article_head_integrity"()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from "articles" article
    inner join "article_revisions" working
      on working."workspace_id" = new."workspace_id"
      and working."article_id" = new."article_id"
      and working."id" = new."working_revision_id"
      and working."revision_number" = new."working_revision_number"
    inner join "article_slug_claims" working_claim
      on working_claim."workspace_id" = new."workspace_id"
      and working_claim."normalized_slug" = new."working_slug"
      and working_claim."article_id" = new."article_id"
      and working_claim."working_claim"
    inner join "article_slug_claims" row_claim
      on row_claim."workspace_id" = article."workspace_id"
      and row_claim."normalized_slug" = article."slug"
      and row_claim."article_id" = article."id"
      and row_claim."article_row_claim"
    where article."workspace_id" = new."workspace_id"
      and article."id" = new."article_id"
      and working."slug" = new."working_slug"
      and (new."review_state" <> 'published' or article."status" = 'published')
      and (
        article."status" <> 'published'
        or (new."archived_at" is null and exists (
          select 1
          from "article_revisions" published
          where published."workspace_id" = new."workspace_id"
            and published."article_id" = new."article_id"
            and published."id" = new."published_revision_id"
            and published."revision_number" = new."published_revision_number"
            and published."category_id" = article."category_id"
            and published."slug" = article."slug"
            and published."title" = article."title"
            and published."mdx" = article."mdx"
            and published."is_faq" = article."is_faq"
            and published."author_name" = article."author_name"
            and published."position" = article."position"
        ))
      )
  ) then
    raise exception using message = 'ARTICLE_HEAD_INVALID', errcode = 'P0001';
  end if;
  return new;
end;
$$`,
  `create trigger "article_heads_integrity_trigger"
before insert or update on "article_heads"
for each row execute function "opas_require_article_head_integrity"()`,
  `create function "opas_require_article_materialization_integrity"()
returns trigger
language plpgsql
as $$
begin
  if new."status" = 'published' and not exists (
    select 1
    from "article_heads" head
    inner join "article_revisions" published
      on published."workspace_id" = head."workspace_id"
      and published."article_id" = head."article_id"
      and published."id" = head."published_revision_id"
      and published."revision_number" = head."published_revision_number"
    inner join "article_slug_claims" claim
      on claim."workspace_id" = new."workspace_id"
      and claim."normalized_slug" = new."slug"
      and claim."article_id" = new."id"
      and claim."article_row_claim"
    where head."workspace_id" = new."workspace_id"
      and head."article_id" = new."id"
      and head."archived_at" is null
      and head."review_state" in ('approved', 'published')
      and published."category_id" = new."category_id"
      and published."slug" = new."slug"
      and published."title" = new."title"
      and published."mdx" = new."mdx"
      and published."is_faq" = new."is_faq"
      and published."author_name" = new."author_name"
      and published."position" = new."position"
  ) then
    raise exception using message = 'ARTICLE_MATERIALIZATION_INVALID', errcode = 'P0001';
  end if;

  if TG_OP = 'UPDATE' and new."status" = 'draft' and (
    new."id" is distinct from old."id"
    or new."workspace_id" is distinct from old."workspace_id"
    or (
      new."category_id" is distinct from old."category_id"
      and not exists (
        select 1
        from "article_heads" head
        inner join "article_revisions" working
          on working."workspace_id" = head."workspace_id"
          and working."article_id" = head."article_id"
          and working."id" = head."working_revision_id"
          and working."revision_number" = head."working_revision_number"
        left join "article_revisions" published
          on published."workspace_id" = head."workspace_id"
          and published."article_id" = head."article_id"
          and published."id" = head."published_revision_id"
          and published."revision_number" = head."published_revision_number"
        where head."workspace_id" = new."workspace_id"
          and head."article_id" = new."id"
          and new."category_id" = coalesce(published."category_id", working."category_id")
          and old."category_id" is distinct from working."category_id"
          and (
            published."id" is null
            or old."category_id" is distinct from published."category_id"
          )
      )
    )
    or new."title" is distinct from old."title"
    or new."mdx" is distinct from old."mdx"
    or new."content_hash" is distinct from old."content_hash"
    or new."is_faq" is distinct from old."is_faq"
    or new."author_name" is distinct from old."author_name"
    or new."position" is distinct from old."position"
    or new."published_at" is distinct from old."published_at"
    or new."created_at" is distinct from old."created_at"
    or (old."status" = 'published' and new."slug" is distinct from old."slug")
  ) then
    raise exception using message = 'ARTICLE_MATERIALIZATION_INVALID', errcode = 'P0001';
  end if;
  return new;
end;
$$`,
  `create trigger "articles_materialization_integrity_trigger"
before insert or update on "articles"
for each row execute function "opas_require_article_materialization_integrity"()`,
  `create function "opas_reject_article_delete"()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from "workspaces" where "id" = old."workspace_id") and exists (
    select 1 from "article_heads"
    where "workspace_id" = old."workspace_id" and "article_id" = old."id"
  ) then
    raise exception using message = 'ARTICLE_DELETE_FORBIDDEN', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "articles_history_delete_trigger"
before delete on "articles"
for each row execute function "opas_reject_article_delete"()`,
  `create function "opas_require_slug_claim_retained"()
returns trigger
language plpgsql
as $$
declare
  "row_claim_referenced" boolean;
  "working_claim_referenced" boolean;
begin
  select exists (
    select 1 from "articles"
    where "workspace_id" = old."workspace_id"
      and "id" = old."article_id"
      and "slug" = old."normalized_slug"
  ) into "row_claim_referenced";
  select exists (
    select 1 from "article_heads"
    where "workspace_id" = old."workspace_id"
      and "article_id" = old."article_id"
      and "working_slug" = old."normalized_slug"
  ) into "working_claim_referenced";

  if TG_OP = 'DELETE'
    and exists (select 1 from "workspaces" where "id" = old."workspace_id")
    and ("row_claim_referenced" or "working_claim_referenced")
  then
    raise exception using message = 'ARTICLE_SLUG_CLAIM_INVALID', errcode = 'P0001';
  end if;
  if TG_OP = 'UPDATE' and (
    ("row_claim_referenced" and (
      new."workspace_id" is distinct from old."workspace_id"
      or new."article_id" is distinct from old."article_id"
      or new."normalized_slug" is distinct from old."normalized_slug"
      or not new."article_row_claim"
    ))
    or ("working_claim_referenced" and (
      new."workspace_id" is distinct from old."workspace_id"
      or new."article_id" is distinct from old."article_id"
      or new."normalized_slug" is distinct from old."normalized_slug"
      or not new."working_claim"
    ))
  ) then
    raise exception using message = 'ARTICLE_SLUG_CLAIM_INVALID', errcode = 'P0001';
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$`,
  `create trigger "article_slug_claims_integrity_trigger"
before update or delete on "article_slug_claims"
for each row execute function "opas_require_slug_claim_retained"()`,
  `create function "opas_reject_current_category_delete"()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from "workspaces" where "id" = old."workspace_id") and (
    exists (
      select 1 from "articles"
      where "workspace_id" = old."workspace_id" and "category_id" = old."id"
    ) or exists (
      select 1
      from "article_heads" head
      inner join "article_revisions" working
        on working."workspace_id" = head."workspace_id"
        and working."article_id" = head."article_id"
        and working."id" = head."working_revision_id"
        and working."revision_number" = head."working_revision_number"
      left join "article_revisions" published
        on published."workspace_id" = head."workspace_id"
        and published."article_id" = head."article_id"
        and published."id" = head."published_revision_id"
        and published."revision_number" = head."published_revision_number"
      where head."workspace_id" = old."workspace_id"
        and (working."category_id" = old."id" or published."category_id" = old."id")
    )
  ) then
    raise exception using message = 'CATEGORY_IN_USE', errcode = 'P0001';
  end if;
  return old;
end;
$$`,
  `create trigger "categories_current_revision_delete_trigger"
before delete on "categories"
for each row execute function "opas_reject_current_category_delete"()`,
];

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresTeamAuthoringBackfillStore(
  pool: Pool,
): TeamAuthoringBackfillStore {
  return {
    async applyChunk(rows) {
      await inTransaction(pool, async (client) => {
        await inspect(client, true);
        for (const row of rows) await insertBaseline(client, row);
      });
    },
    async assertAllWorkspacesPaused() {
      return inspect(pool, false);
    },
    async audit(rows) {
      await inTransaction(pool, async (client) => {
        await inspect(client, true);
        await verifyAudit(client, rows);
      });
    },
    async auditCompleted(rows) {
      await inTransaction(pool, async (client) => {
        await inspect(client, true);
        await verifyAudit(client, rows, false);
      });
    },
    async finalize(rows, installGuards, requireBaselineProjection) {
      await inTransaction(pool, async (client) => {
        await inspect(client, true);
        for (const row of rows) {
          await client.query(
            `insert into workspace_authoring_migrations
               (workspace_id, version, article_count, projection_hash, completed_at)
             values ($1, $2, $3, $4, $5)
             on conflict (workspace_id, version) do nothing`,
            [
              row.workspaceId,
              row.version,
              row.articleCount,
              row.projectionHash,
              row.completedAt,
            ],
          );
        }
        if (installGuards) {
          for (const statement of postgresTeamAuthoringGuardStatements) {
            await client.query(statement);
          }
        }
        await verifyAudit(client, rows, requireBaselineProjection);
      });
    },
    async readArticleChunk(cursor, limit) {
      const result = await pool.query<SourceRow>(readArticleChunkSql, [
        cursor?.workspaceId ?? null,
        cursor?.articleId ?? "",
        limit,
      ]);
      return sourceArticles(result.rows);
    },
    async readMigrationRevisionChunk(cursor, limit) {
      const result = await pool.query<StoredSourceRow>(readMigrationRevisionChunkSql, [
        cursor?.workspaceId ?? null,
        cursor?.articleId ?? "",
        limit,
        migrationRevisionActorLabel,
      ]);
      return storedBaselines(result.rows);
    },
    async verifyChunk(rows) {
      await inTransaction(pool, async (client) => {
        await inspect(client, true);
        for (const row of rows) await assertBaseline(client, row);
      });
    },
  };
}
