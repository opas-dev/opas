// ABOUTME: Applies exact category mutations atomically on Postgres and Neon.
// ABOUTME: Locks the authoring fence, named actor, category version, and affected review heads.
import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
} from "@/db/authoring-controls";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

type DatabaseRow = Readonly<Record<string, unknown>>;

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

function resultRows<T extends DatabaseRow>(value: unknown): T[] {
  return value !== null &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows)
    ? (value.rows as T[])
    : [];
}

async function transaction(
  database: PostgresDatabase,
  statements: readonly SQL[],
) {
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    return database.batch(queries as [Query, ...Query[]]);
  }
  return database.transaction(async (connection) => {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await connection.execute(statement));
    }
    return results;
  });
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

function actorAssertion(
  workspaceId: string,
  actor: CreateCategoryRequest["actor"],
  checkedAt: Date,
) {
  return sql`
    select 1 / count(*)::integer
    from (
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
        and session.expires_at > ${checkedAt}
        and ${actor.workspaceId} = ${workspaceId}
      for share of member, session
    ) authorized_actor
  `;
}

function categoryVersionAssertion(
  workspaceId: string,
  categoryId: string,
  expectedVersion: number,
) {
  return sql`
    select 1 / count(*)::integer
    from (
      select category.id
      from categories category
      where category.workspace_id = ${workspaceId}
        and category.id = ${categoryId}
        and category.version = ${expectedVersion}
      for update of category
    ) current_category
  `;
}

function categoryCreationAssertion(
  workspaceId: string,
  categoryId: string,
  slug: string,
) {
  return sql`
    select 1 / case when
      not exists (
        select 1 from categories
        where workspace_id = ${workspaceId} and id = ${categoryId}
      )
      and not exists (
        select 1 from categories
        where workspace_id = ${workspaceId} and slug = ${slug}
      )
      then 1 else 0 end
  `;
}

function categorySlugAssertion(request: UpdateCategoryRequest) {
  return sql`
    select 1 / case when
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
      then 1 else 0 end
  `;
}

function affectedHeadLock(request: UpdateCategoryRequest) {
  return sql`
    select head.article_id
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
      and head.review_state in ('in_review', 'approved')
      and (
        category.slug is distinct from ${request.category.slug}
        or category.name is distinct from ${request.category.name}
      )
    order by head.article_id
    for update of head
  `;
}

function categoryUpdate(request: UpdateCategoryRequest, changedAt: Date) {
  return sql`
    update categories
    set slug = ${request.category.slug},
        name = ${request.category.name},
        description = ${request.category.description},
        position = ${request.category.position},
        version = version + 1,
        updated_at = ${changedAt}
    where workspace_id = ${request.category.workspaceId}
      and id = ${request.category.id}
      and version = ${request.expectedCategoryVersion}
      and (
        slug is distinct from ${request.category.slug}
        or name is distinct from ${request.category.name}
        or description is distinct from ${request.category.description}
        or position is distinct from ${request.category.position}
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
      'category_changed:' || ${changedVersion}::text || ':' || head.working_revision_id,
      head.workspace_id,
      head.article_id,
      head.working_revision_id,
      head.working_revision_number,
      ${request.actor.memberId},
      'category_changed',
      null,
      ${changedAt}
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
        revision.category_slug is distinct from category.slug
        or revision.category_name is distinct from category.name
      )
  `;
}

function invalidateCategoryReviews(request: UpdateCategoryRequest) {
  const changedVersion = request.expectedCategoryVersion + 1;
  return sql`
    update article_heads head
    set review_state = 'changes_requested',
        submitted_by_member_id = null
    from article_revisions revision, categories category
    where revision.workspace_id = head.workspace_id
      and revision.article_id = head.article_id
      and revision.id = head.working_revision_id
      and revision.revision_number = head.working_revision_number
      and category.workspace_id = head.workspace_id
      and category.id = revision.category_id
      and head.workspace_id = ${request.category.workspaceId}
      and revision.category_id = ${request.category.id}
      and category.version = ${changedVersion}
      and head.review_state in ('in_review', 'approved')
      and (
        revision.category_slug is distinct from category.slug
        or revision.category_name is distinct from category.name
      )
  `;
}

function categoryReferenceAssertion(request: DeleteCategoryRequest) {
  return sql`
    select 1 / case when not exists (
      select 1
      from article_heads head
      inner join article_revisions working_revision
        on working_revision.workspace_id = head.workspace_id
       and working_revision.article_id = head.article_id
       and working_revision.id = head.working_revision_id
       and working_revision.revision_number = head.working_revision_number
      where head.workspace_id = ${request.category.workspaceId}
        and working_revision.category_id = ${request.category.id}
      union all
      select 1
      from article_heads head
      inner join article_revisions published_revision
        on published_revision.workspace_id = head.workspace_id
       and published_revision.article_id = head.article_id
       and published_revision.id = head.published_revision_id
       and published_revision.revision_number = head.published_revision_number
      where head.workspace_id = ${request.category.workspaceId}
        and published_revision.category_id = ${request.category.id}
    ) and not exists (
      select 1
      from articles article
      left join article_heads head
        on head.workspace_id = article.workspace_id
       and head.article_id = article.id
      where article.workspace_id = ${request.category.workspaceId}
        and article.category_id = ${request.category.id}
        and head.article_id is null
    ) then 1 else 0 end
  `;
}

function rehomeStaleCategoryProjection(request: DeleteCategoryRequest) {
  return sql`
    update articles article
    set category_id = coalesce(published_revision.category_id, working_revision.category_id)
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
    where article.workspace_id = ${request.category.workspaceId}
      and article.category_id = ${request.category.id}
      and head.workspace_id = article.workspace_id
      and head.article_id = article.id
      and working_revision.category_id <> ${request.category.id}
      and (
        published_revision.id is null
        or published_revision.category_id <> ${request.category.id}
      )
  `;
}

function categorySelection(workspaceId: string, categoryId: string) {
  return sql`
    select id, workspace_id as "workspaceId", slug, name, description,
           position, version
    from categories
    where workspace_id = ${workspaceId} and id = ${categoryId}
    limit 1
  `;
}

async function listCategories(
  database: PostgresDatabase,
  workspaceId: string,
) {
  const rows = resultRows<DatabaseRow>(await database.execute(sql`
    select id, workspace_id as "workspaceId", slug, name, description,
           position, version
    from categories
    where workspace_id = ${workspaceId}
    order by position, id
  `));
  return rows.map(category);
}

async function readCategory(
  database: PostgresDatabase,
  workspaceId: string,
  categoryId: string,
) {
  const row = resultRows<DatabaseRow>(
    await database.execute(categorySelection(workspaceId, categoryId)),
  )[0];
  return row ? category(row) : null;
}

async function actorIsAuthorized(
  database: PostgresDatabase,
  workspaceId: string,
  actor: CreateCategoryRequest["actor"],
  checkedAt: Date,
) {
  if (actor.workspaceId !== workspaceId) return false;
  return resultRows<DatabaseRow>(await database.execute(sql`
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
      and session.expires_at > ${checkedAt}
    limit 1
  `)).length === 1;
}

async function authoringIsOpen(
  database: PostgresDatabase,
  workspaceId: string,
) {
  const row = resultRows<DatabaseRow>(await database.execute(sql`
    select writes_paused as "writesPaused"
    from workspace_authoring_controls
    where workspace_id = ${workspaceId}
    limit 1
  `))[0];
  if (!row || row.writesPaused === true) throw new AuthoringPausedError();
}

async function slugOwner(
  database: PostgresDatabase,
  workspaceId: string,
  slug: string,
  excludedId?: string,
) {
  return resultRows<DatabaseRow>(await database.execute(sql`
    select id from categories
    where workspace_id = ${workspaceId}
      and slug = ${slug}
      and (${excludedId ?? null}::text is null or id <> ${excludedId ?? null})
    limit 1
  `))[0];
}

async function hasLiveCategoryArticle(
  database: PostgresDatabase,
  workspaceId: string,
  categoryId: string,
) {
  return resultRows<DatabaseRow>(await database.execute(sql`
    select id from articles
    where workspace_id = ${workspaceId}
      and category_id = ${categoryId}
      and status = 'published'
    limit 1
  `)).length === 1;
}

async function hasCategoryReference(
  database: PostgresDatabase,
  workspaceId: string,
  categoryId: string,
) {
  return resultRows<DatabaseRow>(await database.execute(sql`
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
  database: PostgresDatabase,
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

export function createPostgresCategoryAuthoringRepository(
  database: PostgresDatabase,
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
          authoringAssertion(request.category.workspaceId, "postgres"),
          actorAssertion(request.category.workspaceId, request.actor, changedAt),
          categoryCreationAssertion(
            request.category.workspaceId,
            request.category.id,
            request.category.slug,
          ),
          sql`
            insert into categories (
              id, workspace_id, slug, name, description, position,
              version, created_at, updated_at
            ) values (
              ${request.category.id}, ${request.category.workspaceId},
              ${request.category.slug}, ${request.category.name},
              ${request.category.description}, ${request.category.position},
              1, ${changedAt}, ${changedAt}
            )
          `,
          categorySelection(request.category.workspaceId, request.category.id),
        ]);
        const storedRow = resultRows<DatabaseRow>(results[results.length - 1])[0];
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
          authoringAssertion(request.category.workspaceId, "postgres"),
          actorAssertion(request.category.workspaceId, request.actor, changedAt),
          categoryVersionAssertion(
            request.category.workspaceId,
            request.category.id,
            request.expectedCategoryVersion,
          ),
          categorySlugAssertion(request),
          affectedHeadLock(request),
          categoryUpdate(request, changedAt),
          categoryChangedEvents(request, changedAt),
          invalidateCategoryReviews(request),
          categorySelection(request.category.workspaceId, request.category.id),
        ]);
        const storedRow = resultRows<DatabaseRow>(results[results.length - 1])[0];
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
          authoringAssertion(request.category.workspaceId, "postgres"),
          actorAssertion(request.category.workspaceId, request.actor, changedAt),
          categoryVersionAssertion(
            request.category.workspaceId,
            request.category.id,
            request.expectedCategoryVersion,
          ),
          categoryReferenceAssertion(request),
          rehomeStaleCategoryProjection(request),
          sql`
            delete from categories
            where workspace_id = ${request.category.workspaceId}
              and id = ${request.category.id}
              and version = ${request.expectedCategoryVersion}
          `,
        ]);
      } catch (error) {
        return classifyFailure(database, request, changedAt, error, "delete");
      }
      return { status: "deleted", categoryId: request.category.id };
    },
  };
}
