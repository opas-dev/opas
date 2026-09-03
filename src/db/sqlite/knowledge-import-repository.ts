// ABOUTME: Activates named-member knowledge imports as one private SQLite or D1 batch.
// ABOUTME: Rechecks actors, slug claims, manifests, and exact revision assets at commit time.
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import { prepareAssetSelection } from "@/db/assets";
import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
  withAuthoringErrorBoundary,
} from "@/db/authoring-controls";
import {
  assertKnowledgeImportIntegrity,
  KnowledgeImportAuthorizationError,
  knowledgeImportTimestamp,
  type KnowledgeImport,
  type KnowledgeImportArticle,
  type KnowledgeImportConflictCode,
  type KnowledgeImportRepository,
} from "@/db/knowledge-import";
import {
  adminSessions,
  articleRevisions,
  articleSlugClaims,
  articles,
  assetManifestItems,
  assetManifests,
  assets,
  categories,
  workspaceMembers,
} from "@/db/schema/sqlite";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

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

function actorAssertion(knowledgeImport: KnowledgeImport, checkedAt: Date) {
  return sql`
    select json_extract('[]', case when exists (
      select 1
      from workspace_members member
      inner join admin_sessions session
        on session.workspace_id = member.workspace_id
        and session.member_id = member.id
      where member.workspace_id = ${knowledgeImport.actor.workspaceId}
        and member.id = ${knowledgeImport.actor.memberId}
        and member.status = 'active'
        and member.role in ('administrator', 'editor')
        and session.id = ${knowledgeImport.actor.sessionId}
        and session.revoked_at is null
        and session.expires_at > ${checkedAt.getTime()}
    ) then '$[0]' else '$[' end)
  `;
}

function importClaimsAssertion(knowledgeImport: KnowledgeImport) {
  const requestedCategories = JSON.stringify(
    knowledgeImport.categories.map(({ id, slug }) => ({ id, slug })),
  );
  const requestedArticles = JSON.stringify(
    knowledgeImport.articles.map(({ id, revisionId, slug }) => ({
      id,
      revisionId,
      slug,
    })),
  );
  return sql`
    with requested_categories as (
      select
        json_extract(value, '$.id') as id,
        json_extract(value, '$.slug') as slug
      from json_each(${requestedCategories})
    ), requested_articles as (
      select
        json_extract(value, '$.id') as id,
        json_extract(value, '$.revisionId') as revision_id,
        json_extract(value, '$.slug') as slug
      from json_each(${requestedArticles})
    )
    select json_extract('[]', case when
      not exists (
        select 1 from categories category
        inner join requested_categories requested
          on category.id = requested.id
          or (
            category.workspace_id = ${knowledgeImport.actor.workspaceId}
            and category.slug = requested.slug
          )
      )
      and not exists (
        select 1 from articles article
        inner join requested_articles requested
          on article.id = requested.id
          or (
            article.workspace_id = ${knowledgeImport.actor.workspaceId}
            and article.slug = requested.slug
          )
      )
      and not exists (
        select 1 from article_slug_claims claim
        inner join requested_articles requested
          on claim.workspace_id = ${knowledgeImport.actor.workspaceId}
          and claim.normalized_slug = requested.slug
      )
      and not exists (
        select 1 from article_revisions revision
        inner join requested_articles requested on revision.id = requested.revision_id
      )
      then '$[0]' else '$[' end)
  `;
}

function manifestAssertion(knowledgeImport: KnowledgeImport, checkedAt: Date) {
  return sql`
    select json_extract('[]', case when exists (
      select 1 from asset_manifests manifest
      where manifest.workspace_id = ${knowledgeImport.actor.workspaceId}
        and manifest.id = ${knowledgeImport.manifestId}
        and manifest.expires_at > ${checkedAt.getTime()}
    ) then '$[0]' else '$[' end)
  `;
}

function revisionAssetInsert(
  knowledgeImport: KnowledgeImport,
  article: KnowledgeImportArticle,
  checkedAt: Date,
) {
  const { hashes } = prepareAssetSelection({ hashes: article.assetHashes });
  return sql`
    with requested(hash) as (
      select distinct value from json_each(${JSON.stringify(hashes)})
    ), allowed(asset_id, hash) as (
      select asset.id, asset.hash
      from assets asset
      inner join requested on requested.hash = asset.hash
      inner join asset_manifest_items item
        on item.asset_id = asset.id
        and item.workspace_id = asset.workspace_id
      inner join asset_manifests manifest
        on manifest.id = item.manifest_id
        and manifest.workspace_id = item.workspace_id
      where asset.workspace_id = ${knowledgeImport.actor.workspaceId}
        and manifest.id = ${knowledgeImport.manifestId}
        and manifest.expires_at > ${checkedAt.getTime()}
    ), rows_to_insert(workspace_id, article_id, revision_id, revision_number, asset_id) as (
      select ${knowledgeImport.actor.workspaceId}, ${article.id}, ${article.revisionId}, 1,
        allowed.asset_id
      from allowed
      union all
      select ${knowledgeImport.actor.workspaceId}, ${article.id}, ${article.revisionId}, 1,
        null
      where (select count(*) from requested) <> (select count(*) from allowed)
    )
    insert into article_revision_assets (
      workspace_id, article_id, revision_id, revision_number, asset_id
    )
    select workspace_id, article_id, revision_id, revision_number, asset_id
    from rows_to_insert where true
  `;
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

function activationStatements(knowledgeImport: KnowledgeImport, checkedAt: Date) {
  const workspaceId = knowledgeImport.actor.workspaceId;
  const statements: SQL[] = [
    authoringAssertion(workspaceId, "sqlite"),
    actorAssertion(knowledgeImport, checkedAt),
    importClaimsAssertion(knowledgeImport),
    manifestAssertion(knowledgeImport, checkedAt),
  ];
  for (const category of knowledgeImport.categories) {
    statements.push(sql`
      insert into categories (
        id, workspace_id, slug, name, description, position, version,
        created_at, updated_at
      ) values (
        ${category.id}, ${workspaceId}, ${category.slug}, ${category.name},
        ${category.description}, ${category.position}, 1,
        ${checkedAt.getTime()}, ${checkedAt.getTime()}
      )
    `);
  }
  for (const article of knowledgeImport.articles) {
    statements.push(
      sql`
        insert into articles (
          id, workspace_id, category_id, slug, title, mdx, content_hash, status,
          is_faq, author_name, position, published_at, created_at, updated_at
        ) values (
          ${article.id}, ${workspaceId}, ${article.categoryId}, ${article.slug},
          ${article.title}, ${article.mdx}, null, 'draft', ${article.isFaq ? 1 : 0},
          ${article.authorName}, ${article.position}, null,
          ${checkedAt.getTime()}, ${checkedAt.getTime()}
        )
      `,
      sql`
        insert into article_slug_claims (
          workspace_id, normalized_slug, article_id, working_claim, article_row_claim
        ) values (${workspaceId}, ${article.slug}, ${article.id}, 1, 1)
      `,
      sql`
        insert into article_revisions (
          id, workspace_id, article_id, revision_number, category_id,
          category_slug, category_name, slug, title, mdx, is_faq, author_name,
          position, revision_hash, change_kind, created_by_member_id,
          created_by_system_label, change_summary, created_at,
          restored_from_revision_id
        ) values (
          ${article.revisionId}, ${workspaceId}, ${article.id}, 1,
          ${article.categoryId}, ${article.categorySlug}, ${article.categoryName},
          ${article.slug}, ${article.title}, ${article.mdx}, ${article.isFaq ? 1 : 0},
          ${article.authorName}, ${article.position}, ${article.revisionHash},
          'import', ${knowledgeImport.actor.memberId}, null,
          ${article.changeSummary}, ${checkedAt.getTime()}, null
        )
      `,
      revisionAssetInsert(knowledgeImport, article, checkedAt),
      sql`
        insert into article_heads (
          article_id, workspace_id, working_revision_id, working_revision_number,
          working_slug, published_revision_id, published_revision_number,
          review_state, submitted_by_member_id, archived_at, archived_by_member_id
        ) values (
          ${article.id}, ${workspaceId}, ${article.revisionId}, 1,
          ${article.slug}, null, null, 'editing', null, null, null
        )
      `,
    );
  }
  statements.push(
    sql`delete from asset_manifests where id = ${knowledgeImport.manifestId} and workspace_id = ${workspaceId}`,
    orphanAssetCleanup(workspaceId),
  );
  return statements;
}

async function actorIsAuthorized(
  database: SqliteDatabase,
  knowledgeImport: KnowledgeImport,
  checkedAt: Date,
) {
  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  const [row] = await executableDatabase
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
        eq(workspaceMembers.workspaceId, knowledgeImport.actor.workspaceId),
        eq(workspaceMembers.id, knowledgeImport.actor.memberId),
        eq(workspaceMembers.status, "active"),
        inArray(workspaceMembers.role, ["administrator", "editor"]),
        eq(adminSessions.id, knowledgeImport.actor.sessionId),
        sql`${adminSessions.revokedAt} is null`,
        gt(adminSessions.expiresAt, checkedAt),
      ),
    )
    .limit(1)
    .execute();
  return Boolean(row);
}

async function categoryHasConflict(database: SqliteDatabase, knowledgeImport: KnowledgeImport) {
  if (knowledgeImport.categories.length === 0) return false;
  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  const ids = knowledgeImport.categories.map(({ id }) => id);
  const slugs = knowledgeImport.categories.map(({ slug }) => slug);
  const [row] = await executableDatabase
    .select({ id: categories.id })
    .from(categories)
    .where(
      or(
        inArray(categories.id, ids),
        and(
          eq(categories.workspaceId, knowledgeImport.actor.workspaceId),
          inArray(categories.slug, slugs),
        ),
      ),
    )
    .limit(1)
    .execute();
  return Boolean(row);
}

async function articleHasConflict(database: SqliteDatabase, knowledgeImport: KnowledgeImport) {
  if (knowledgeImport.articles.length === 0) return false;
  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  const ids = knowledgeImport.articles.map(({ id }) => id);
  const revisionIds = knowledgeImport.articles.map(({ revisionId }) => revisionId);
  const slugs = knowledgeImport.articles.map(({ slug }) => slug);
  const [article, claim, revision] = await Promise.all([
    executableDatabase
      .select({ id: articles.id })
      .from(articles)
      .where(
        or(
          inArray(articles.id, ids),
          and(
            eq(articles.workspaceId, knowledgeImport.actor.workspaceId),
            inArray(articles.slug, slugs),
          ),
        ),
      )
      .limit(1)
      .execute(),
    executableDatabase
      .select({ id: articleSlugClaims.articleId })
      .from(articleSlugClaims)
      .where(
        and(
          eq(articleSlugClaims.workspaceId, knowledgeImport.actor.workspaceId),
          inArray(articleSlugClaims.normalizedSlug, slugs),
        ),
      )
      .limit(1)
      .execute(),
    executableDatabase
      .select({ id: articleRevisions.id })
      .from(articleRevisions)
      .where(inArray(articleRevisions.id, revisionIds))
      .limit(1)
      .execute(),
  ]);
  return article.length > 0 || claim.length > 0 || revision.length > 0;
}

async function assetsAreAvailable(
  database: SqliteDatabase,
  knowledgeImport: KnowledgeImport,
  checkedAt: Date,
) {
  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  const requested = [
    ...new Set(knowledgeImport.articles.flatMap(({ assetHashes }) => assetHashes)),
  ];
  const [manifest] = await executableDatabase
    .select({ id: assetManifests.id })
    .from(assetManifests)
    .where(
      and(
        eq(assetManifests.id, knowledgeImport.manifestId),
        eq(assetManifests.workspaceId, knowledgeImport.actor.workspaceId),
        gt(assetManifests.expiresAt, checkedAt),
      ),
    )
    .limit(1)
    .execute();
  if (!manifest) return false;
  if (requested.length === 0) return true;
  const rows = await executableDatabase
    .select({ hash: assets.hash })
    .from(assets)
    .innerJoin(
      assetManifestItems,
      and(
        eq(assetManifestItems.assetId, assets.id),
        eq(assetManifestItems.workspaceId, assets.workspaceId),
      ),
    )
    .where(
      and(
        eq(assets.workspaceId, knowledgeImport.actor.workspaceId),
        eq(assetManifestItems.manifestId, knowledgeImport.manifestId),
        inArray(assets.hash, requested),
      ),
    )
    .execute();
  return new Set(rows.map(({ hash }) => hash)).size === requested.length;
}

async function classifyFailure(
  database: SqliteDatabase,
  knowledgeImport: KnowledgeImport,
  checkedAt: Date,
  error: unknown,
): Promise<KnowledgeImportConflictCode> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  if (!(await actorIsAuthorized(database, knowledgeImport, checkedAt))) return "ACTOR_FORBIDDEN";
  if (await categoryHasConflict(database, knowledgeImport)) return "CATEGORY_CONFLICT";
  if (await articleHasConflict(database, knowledgeImport)) return "ARTICLE_CONFLICT";
  if (!(await assetsAreAvailable(database, knowledgeImport, checkedAt))) return "ASSET_UNAVAILABLE";
  throw error;
}

export function createSqliteKnowledgeImportRepository(
  database: SqliteDatabase,
  clock: () => Date = () => new Date(),
): KnowledgeImportRepository {
  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  return withAuthoringErrorBoundary<KnowledgeImportRepository>({
    async listKnowledgeImportSlugClaims(actor) {
      const checkedAt = knowledgeImportTimestamp(clock);
      const rows = await executableDatabase.all<{ kind: string; slug: string }>(sql`
        with authorized_actor as (
          select member.id
          from workspace_members member
          inner join admin_sessions session
            on session.workspace_id = member.workspace_id
            and session.member_id = member.id
          where member.workspace_id = ${actor.workspaceId}
            and member.id = ${actor.memberId}
            and member.status = 'active'
            and member.role in ('administrator', 'editor')
            and session.id = ${actor.sessionId}
            and session.revoked_at is null
            and session.expires_at > ${checkedAt.getTime()}
        ), claims(kind, slug) as (
          select 'category', slug from categories where workspace_id = ${actor.workspaceId}
          union all
          select 'article', slug from articles where workspace_id = ${actor.workspaceId}
          union all
          select 'article', normalized_slug from article_slug_claims
            where workspace_id = ${actor.workspaceId}
        )
        select 'authorized' as kind, '' as slug from authorized_actor
        union all
        select claims.kind, claims.slug from authorized_actor cross join claims
      `);
      if (!rows.some(({ kind }) => kind === "authorized")) {
        throw new KnowledgeImportAuthorizationError();
      }
      const categoryRows = rows.filter(({ kind }) => kind === "category");
      const articleRows = rows.filter(({ kind }) => kind === "article");
      return {
        categorySlugs: [...new Set(categoryRows.map(({ slug }) => slug))].sort(),
        articleSlugs: [...new Set(articleRows.map(({ slug }) => slug))].sort(),
      };
    },

    async activateKnowledgeImport(knowledgeImport) {
      const checkedAt = knowledgeImportTimestamp(clock);
      await assertKnowledgeImportIntegrity(knowledgeImport);
      try {
        await executeAtomically(database, activationStatements(knowledgeImport, checkedAt));
      } catch (error) {
        return {
          status: "conflict",
          code: await classifyFailure(database, knowledgeImport, checkedAt, error),
        };
      }
      return { status: "activated" };
    },
  });
}
