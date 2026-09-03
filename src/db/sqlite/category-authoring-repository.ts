// ABOUTME: Applies exact category mutations atomically on SQLite and Cloudflare D1.
// ABOUTME: Batches the fence, actor, category version, review events, and state transitions.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
} from "@/db/authoring-controls";
import {
  categoryAuthoringTime,
  type AuthoringCategory,
  type CategoryAuthoringRepository,
  type CategoryAuthoringRepositoryOptions,
  type CategoryMutationFailure,
  type CreateCategoryRequest,
  type DeleteCategoryRequest,
  type UpdateCategoryRequest,
  validExpectedCategoryVersion,
} from "@/db/category-authoring";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

type DatabaseRow = Readonly<Record<string, unknown>>;

type TransactionStatement = Readonly<{
  returnsRows?: boolean;
  statement: SQL;
}>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function d1Statement(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
}

async function transaction(
  database: SqliteDatabase,
  statements: readonly TransactionStatement[],
) {
  if (isD1Database(database)) {
    return database.$client.batch(
      statements.map(({ statement }) => d1Statement(database, statement)),
    );
  }
  return database.transaction((connection) => {
    return statements.map(({ returnsRows, statement }) =>
      returnsRows ? connection.all(statement) : connection.run(statement),
    );
  });
}

function execute(statement: SQL): TransactionStatement {
  return { statement };
}

function read(statement: SQL): TransactionStatement {
  return { returnsRows: true, statement };
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

async function rows(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    return resultRows<DatabaseRow>(await d1Statement(database, statement).all());
  }
  return database.all<DatabaseRow>(statement);
}

function integer(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Category repository returned an invalid ${field}.`);
  }
  return parsed;
}

function nullableText(value: unknown, field: string) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Category repository returned an invalid ${field}.`);
  }
  return value;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Category repository returned an invalid ${field}.`);
  }
  return value;
}

function category(row: DatabaseRow): AuthoringCategory {
  return Object.freeze({
    description: nullableText(row.description, "description"),
    id: text(row.id, "ID"),
    name: text(row.name, "name"),
    position: Number(row.position),
    slug: text(row.slug, "slug"),
    version: integer(row.version, "version"),
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

function sqliteAssertion(condition: SQL) {
  return sql`
    select json_extract('[]', case when ${condition} then '$[0]' else '$[' end)
  `;
}

function actorCondition(
  workspaceId: string,
  actor: CreateCategoryRequest["actor"],
  checkedAt: Date,
) {
  return sql`exists (
    select 1
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${workspaceId}
      and member.id = ${actor.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'editor')
      and session.id = ${actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
      and ${actor.workspaceId} = ${workspaceId}
  )`;
}

function actorAssertion(
  workspaceId: string,
  actor: CreateCategoryRequest["actor"],
  checkedAt: Date,
) {
  return sqliteAssertion(actorCondition(workspaceId, actor, checkedAt));
}

function categoryVersionAssertion(
  workspaceId: string,
  categoryId: string,
  expectedVersion: number,
) {
  return sqliteAssertion(sql`exists (
    select 1 from categories
    where workspace_id = ${workspaceId}
      and id = ${categoryId}
      and version = ${expectedVersion}
  )`);
}

function categoryCreationAssertion(
  workspaceId: string,
  categoryId: string,
  slug: string,
) {
  return sqliteAssertion(sql`
    not exists (
      select 1 from categories
      where workspace_id = ${workspaceId} and id = ${categoryId}
    )
    and not exists (
      select 1 from categories
      where workspace_id = ${workspaceId} and slug = ${slug}
    )
  `);
}

function categorySlugAssertion(request: UpdateCategoryRequest) {
  return sqliteAssertion(sql`
    exists (
      select 1 from categories
      where workspace_id = ${request.category.workspaceId}
        and id = ${request.category.id}
        and slug = ${request.category.slug}
    )
    or not exists (
      select 1 from articles
      where workspace_id = ${request.category.workspaceId}
        and category_id = ${request.category.id}
        and status = 'published'
    )
  `);
}

function categoryUpdate(request: UpdateCategoryRequest, changedAt: Date) {
  return sql`
    update categories
    set slug = ${request.category.slug},
        name = ${request.category.name},
        description = ${request.category.description},
        position = ${request.category.position},
        version = version + 1,
        updated_at = ${changedAt.getTime()}
    where workspace_id = ${request.category.workspaceId}
      and id = ${request.category.id}
      and version = ${request.expectedCategoryVersion}
      and (
        slug is not ${request.category.slug}
        or name is not ${request.category.name}
        or description is not ${request.category.description}
        or position is not ${request.category.position}
      )
  `;
}

function categoryChangedEvents(
  request: UpdateCategoryRequest,
  changedAt: Date,
) {
  const changedVersion = request.expectedCategoryVersion + 1;
  return sql`
    insert into article_review_events (
      id, workspace_id, article_id, revision_id, revision_number,
      member_id, action, note, created_at
    )
    select
      'category_changed:' || cast(cast(${changedVersion} as integer) as text) || ':' || head.working_revision_id,
      head.workspace_id,
      head.article_id,
      head.working_revision_id,
      head.working_revision_number,
      ${request.actor.memberId},
      'category_changed',
      null,
      ${changedAt.getTime()}
    from article_heads head
    inner join article_revisions revision
      on revision.workspace_id = head.workspace_id
     and revision.article_id = head.article_id
     and revision.id = head.working_revision_id
     and revision.revision_number = head.working_revision_number
    inner join categories category
      on category.workspace_id = head.workspace_id
     and category.id = revision.category_id
    where head.workspace_id = ${request.category.workspaceId}
      and revision.category_id = ${request.category.id}
      and category.version = ${changedVersion}
      and head.review_state in ('in_review', 'approved')
      and (
        revision.category_slug is not category.slug
        or revision.category_name is not category.name
      )
  `;
}

function invalidateCategoryReviews(request: UpdateCategoryRequest) {
  const changedVersion = request.expectedCategoryVersion + 1;
  return sql`
    update article_heads
    set review_state = 'changes_requested',
        submitted_by_member_id = null
    where workspace_id = ${request.category.workspaceId}
      and review_state in ('in_review', 'approved')
      and exists (
        select 1
        from article_revisions revision
        inner join categories category
          on category.workspace_id = revision.workspace_id
         and category.id = revision.category_id
        where revision.workspace_id = article_heads.workspace_id
          and revision.article_id = article_heads.article_id
          and revision.id = article_heads.working_revision_id
          and revision.revision_number = article_heads.working_revision_number
          and revision.category_id = ${request.category.id}
          and category.version = ${changedVersion}
          and (
            revision.category_slug is not category.slug
            or revision.category_name is not category.name
          )
      )
  `;
}

function categoryReferenceCondition(request: DeleteCategoryRequest) {
  return sql`not exists (
    select 1
    from article_heads head
    inner join article_revisions revision
      on revision.workspace_id = head.workspace_id
     and revision.article_id = head.article_id
     and (
       (revision.id = head.working_revision_id
        and revision.revision_number = head.working_revision_number)
       or (revision.id = head.published_revision_id
        and revision.revision_number = head.published_revision_number)
     )
    where head.workspace_id = ${request.category.workspaceId}
      and revision.category_id = ${request.category.id}
  ) and not exists (
    select 1
    from articles article
    left join article_heads head
      on head.workspace_id = article.workspace_id
     and head.article_id = article.id
    where article.workspace_id = ${request.category.workspaceId}
      and article.category_id = ${request.category.id}
      and head.article_id is null
  )`;
}

function rehomeStaleCategoryProjection(request: DeleteCategoryRequest) {
  return sql`
    update articles
    set category_id = coalesce(
      (
        select published_revision.category_id
        from article_heads head
        inner join article_revisions published_revision
          on published_revision.workspace_id = head.workspace_id
         and published_revision.article_id = head.article_id
         and published_revision.id = head.published_revision_id
         and published_revision.revision_number = head.published_revision_number
        where head.workspace_id = articles.workspace_id
          and head.article_id = articles.id
      ),
      (
        select working_revision.category_id
        from article_heads head
        inner join article_revisions working_revision
          on working_revision.workspace_id = head.workspace_id
         and working_revision.article_id = head.article_id
         and working_revision.id = head.working_revision_id
         and working_revision.revision_number = head.working_revision_number
        where head.workspace_id = articles.workspace_id
          and head.article_id = articles.id
      )
    )
    where workspace_id = ${request.category.workspaceId}
      and category_id = ${request.category.id}
      and exists (
        select 1
        from article_heads head
        inner join article_revisions working_revision
          on working_revision.workspace_id = head.workspace_id
         and working_revision.article_id = head.article_id
         and working_revision.id = head.working_revision_id
         and working_revision.revision_number = head.working_revision_number
        left join article_revisions published_revision
          on published_revision.workspace_id = head.workspace_id
         and published_revision.article_id = head.article_id
         and published_revision.id = head.published_revision_id
         and published_revision.revision_number = head.published_revision_number
        where head.workspace_id = articles.workspace_id
          and head.article_id = articles.id
          and working_revision.category_id <> ${request.category.id}
          and (
            published_revision.id is null
            or published_revision.category_id <> ${request.category.id}
          )
      )
  `;
}

function categorySelection(workspaceId: string, categoryId: string) {
  return sql`
    select id, workspace_id as workspaceId, slug, name, description,
           position, version
    from categories
    where workspace_id = ${workspaceId} and id = ${categoryId}
    limit 1
  `;
}

async function listCategories(database: SqliteDatabase, workspaceId: string) {
  return (await rows(database, sql`
    select id, workspace_id as workspaceId, slug, name, description,
           position, version
    from categories
    where workspace_id = ${workspaceId}
    order by position, id
  `)).map(category);
}

async function readCategory(
  database: SqliteDatabase,
  workspaceId: string,
  categoryId: string,
) {
  const row = (await rows(database, categorySelection(workspaceId, categoryId)))[0];
  return row ? category(row) : null;
}

async function actorIsAuthorized(
  database: SqliteDatabase,
  workspaceId: string,
  actor: CreateCategoryRequest["actor"],
  checkedAt: Date,
) {
  if (actor.workspaceId !== workspaceId) return false;
  return (await rows(database, sql`
    select member.id
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${workspaceId}
      and member.id = ${actor.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'editor')
      and session.id = ${actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt.getTime()}
    limit 1
  `)).length === 1;
}

async function authoringIsOpen(database: SqliteDatabase, workspaceId: string) {
  const row = (await rows(database, sql`
    select writes_paused as writesPaused
    from workspace_authoring_controls
    where workspace_id = ${workspaceId}
    limit 1
  `))[0];
  if (!row || row.writesPaused === true || row.writesPaused === 1) {
    throw new AuthoringPausedError();
  }
}

async function slugOwner(
  database: SqliteDatabase,
  workspaceId: string,
  slug: string,
  excludedId?: string,
) {
  return (await rows(database, sql`
    select id from categories
    where workspace_id = ${workspaceId}
      and slug = ${slug}
      and (${excludedId ?? null} is null or id <> ${excludedId ?? null})
    limit 1
  `))[0];
}

async function hasLiveCategoryArticle(
  database: SqliteDatabase,
  workspaceId: string,
  categoryId: string,
) {
  return (await rows(database, sql`
    select id from articles
    where workspace_id = ${workspaceId}
      and category_id = ${categoryId}
      and status = 'published'
    limit 1
  `)).length === 1;
}

async function hasCategoryReference(
  database: SqliteDatabase,
  workspaceId: string,
  categoryId: string,
) {
  return (await rows(database, sql`
    select 1
    from article_heads head
    inner join article_revisions revision
      on revision.workspace_id = head.workspace_id
     and revision.article_id = head.article_id
     and (
       (revision.id = head.working_revision_id
        and revision.revision_number = head.working_revision_number)
       or (revision.id = head.published_revision_id
        and revision.revision_number = head.published_revision_number)
     )
    where head.workspace_id = ${workspaceId}
      and revision.category_id = ${categoryId}
    union all
    select 1
    from articles article
    left join article_heads head
      on head.workspace_id = article.workspace_id
     and head.article_id = article.id
    where article.workspace_id = ${workspaceId}
      and article.category_id = ${categoryId}
      and head.article_id is null
    limit 1
  `)).length === 1;
}

async function classifyFailure(
  database: SqliteDatabase,
  request: CreateCategoryRequest | UpdateCategoryRequest | DeleteCategoryRequest,
  checkedAt: Date,
  error: unknown,
  kind: "create" | "delete" | "update",
): Promise<CategoryMutationFailure> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  const workspaceId = request.category.workspaceId;
  await authoringIsOpen(database, workspaceId);
  if (!(await actorIsAuthorized(database, workspaceId, request.actor, checkedAt))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const current = await readCategory(database, workspaceId, request.category.id);
  if (kind === "create") {
    const creation = request as CreateCategoryRequest;
    if (current) return { status: "conflict", code: "CATEGORY_EXISTS" };
    if (await slugOwner(database, workspaceId, creation.category.slug)) {
      return { status: "conflict", code: "CATEGORY_SLUG_CONFLICT" };
    }
    throw error;
  }
  if (!current) return { status: "rejected", code: "CATEGORY_NOT_FOUND" };
  if (current.version !== request.expectedCategoryVersion) {
    return {
      status: "conflict",
      code: "STALE_CATEGORY",
      currentVersion: current.version,
    };
  }
  if (kind === "delete") {
    if (await hasCategoryReference(database, workspaceId, current.id)) {
      return { status: "rejected", code: "CATEGORY_REFERENCED" };
    }
    throw error;
  }
  const update = request as UpdateCategoryRequest;
  if (
    current.slug !== update.category.slug &&
    (await hasLiveCategoryArticle(database, workspaceId, current.id))
  ) {
    return { status: "rejected", code: "LIVE_CATEGORY_SLUG" };
  }
  if (await slugOwner(database, workspaceId, update.category.slug, current.id)) {
    return { status: "conflict", code: "CATEGORY_SLUG_CONFLICT" };
  }
  throw error;
}

export function createSqliteCategoryAuthoringRepository(
  database: SqliteDatabase,
  options?: CategoryAuthoringRepositoryOptions,
): CategoryAuthoringRepository {
  return {
    async listCategories(workspaceId) {
      return listCategories(database, workspaceId);
    },

    async createCategory(request) {
      if (!validExpectedCategoryVersion(request.expectedCategoryVersion, true)) {
        return { status: "rejected", code: "INVALID_CATEGORY_VERSION" };
      }
      const changedAt = categoryAuthoringTime(options);
      try {
        const results = await transaction(database, [
          execute(authoringAssertion(request.category.workspaceId, "sqlite")),
          read(actorAssertion(request.category.workspaceId, request.actor, changedAt)),
          read(categoryCreationAssertion(
            request.category.workspaceId,
            request.category.id,
            request.category.slug,
          )),
          execute(sql`
            insert into categories (
              id, workspace_id, slug, name, description, position,
              version, created_at, updated_at
            ) values (
              ${request.category.id}, ${request.category.workspaceId},
              ${request.category.slug}, ${request.category.name},
              ${request.category.description}, ${request.category.position},
              1, ${changedAt.getTime()}, ${changedAt.getTime()}
            )
          `),
          read(categorySelection(request.category.workspaceId, request.category.id)),
        ]);
        const storedRows = resultRows<DatabaseRow>(results[results.length - 1]);
        const storedRow = storedRows[0];
        if (!storedRow) throw new Error("CATEGORY_MUTATION_RESULT_INVALID");
        const stored = category(storedRow);
        if (stored.version !== 1) {
          throw new Error("CATEGORY_MUTATION_RESULT_INVALID");
        }
        return { status: "created", category: stored };
      } catch (error) {
        return classifyFailure(database, request, changedAt, error, "create");
      }
    },

    async updateCategory(request) {
      if (!validExpectedCategoryVersion(request.expectedCategoryVersion)) {
        return { status: "rejected", code: "INVALID_CATEGORY_VERSION" };
      }
      const changedAt = categoryAuthoringTime(options);
      try {
        const results = await transaction(database, [
          execute(authoringAssertion(request.category.workspaceId, "sqlite")),
          read(actorAssertion(request.category.workspaceId, request.actor, changedAt)),
          read(categoryVersionAssertion(
            request.category.workspaceId,
            request.category.id,
            request.expectedCategoryVersion,
          )),
          read(categorySlugAssertion(request)),
          execute(categoryUpdate(request, changedAt)),
          execute(categoryChangedEvents(request, changedAt)),
          execute(invalidateCategoryReviews(request)),
          read(categorySelection(request.category.workspaceId, request.category.id)),
        ]);
        const storedRows = resultRows<DatabaseRow>(results[results.length - 1]);
        const storedRow = storedRows[0];
        if (!storedRow) throw new Error("CATEGORY_MUTATION_RESULT_INVALID");
        const stored = category(storedRow);
        if (
          stored.version !== request.expectedCategoryVersion &&
          stored.version !== request.expectedCategoryVersion + 1
        ) {
          throw new Error("CATEGORY_MUTATION_RESULT_INVALID");
        }
        return {
          status:
            stored.version === request.expectedCategoryVersion
              ? "unchanged"
              : "updated",
          category: stored,
        };
      } catch (error) {
        return classifyFailure(database, request, changedAt, error, "update");
      }
    },

    async deleteCategory(request) {
      if (!validExpectedCategoryVersion(request.expectedCategoryVersion)) {
        return { status: "rejected", code: "INVALID_CATEGORY_VERSION" };
      }
      const changedAt = categoryAuthoringTime(options);
      try {
        await transaction(database, [
          execute(authoringAssertion(request.category.workspaceId, "sqlite")),
          read(actorAssertion(request.category.workspaceId, request.actor, changedAt)),
          read(categoryVersionAssertion(
            request.category.workspaceId,
            request.category.id,
            request.expectedCategoryVersion,
          )),
          read(sqliteAssertion(categoryReferenceCondition(request))),
          execute(rehomeStaleCategoryProjection(request)),
          execute(sql`
            delete from categories
            where workspace_id = ${request.category.workspaceId}
              and id = ${request.category.id}
              and version = ${request.expectedCategoryVersion}
          `),
        ]);
      } catch (error) {
        return classifyFailure(database, request, changedAt, error, "delete");
      }
      return { status: "deleted", categoryId: request.category.id };
    },
  };
}
