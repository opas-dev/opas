// ABOUTME: Verifies fenced category and theme mutations on real Postgres and SQLite.
// ABOUTME: Covers authorization, optimistic versions, review invalidation, and atomic failure.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";

import type { MemberActor } from "@/auth/member-repository";
import { AuthoringPausedError } from "@/db/authoring-controls";
import type { CategoryAuthoringRepository } from "@/db/category-authoring";
import { createPostgresCategoryAuthoringRepository } from "@/db/postgres/category-authoring-repository";
import type { Repository } from "@/db/repository";
import { createPostgresThemeAuthoringRepository } from "@/db/postgres/theme-authoring-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteCategoryAuthoringRepository } from "@/db/sqlite/category-authoring-repository";
import { createSqliteThemeAuthoringRepository } from "@/db/sqlite/theme-authoring-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";
import type { ThemeAuthoringRepository } from "@/db/theme-authoring";

const migrationDirectories = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const now = new Date("2026-09-03T12:00:00.000Z");
const earlier = new Date(now.getTime() - 2 * 60 * 60 * 1000);
const expired = new Date(now.getTime() - 60 * 60 * 1000);
const later = new Date(now.getTime() + 60 * 60 * 1000);
const workspaceId = "workspace_authoring";
const themeId = "theme_authoring";
const categoryId = "category_guides";
const rollbackCategoryId = "category_rollback";
const workingOnlyCategoryId = "category_working_only";
const publishedOnlyCategoryId = "category_published_only";
const staleProjectionCategoryId = "category_stale_projection";

const members = {
  administrator: "member_administrator",
  disabled: "member_disabled",
  editor: "member_editor",
  expired: "member_expired",
  reviewer: "member_reviewer",
  revoked: "member_revoked",
} as const;

const sessions = {
  administrator: "A".repeat(43),
  disabled: "D".repeat(43),
  editor: "E".repeat(43),
  expired: "X".repeat(43),
  reviewer: "W".repeat(43),
  revoked: "V".repeat(43),
} as const;

const actors = Object.fromEntries(
  Object.entries(members).map(([key, memberId]) => [
    key,
    { memberId, sessionId: sessions[key as keyof typeof sessions], workspaceId },
  ]),
) as Record<keyof typeof members, MemberActor>;

type Row = Record<string, unknown>;

type LegacyCategoryThemeMutation = Extract<
  keyof Repository,
  "createCategory" | "deleteCategory" | "updateCategory" | "updateTheme"
>;

const repositoryUsesDedicatedCategoryThemeAuthoring:
  LegacyCategoryThemeMutation extends never ? true : false = true;

type State = Readonly<{
  articles: readonly Row[];
  categories: readonly Row[];
  events: readonly Row[];
  heads: readonly Row[];
  themes: readonly Row[];
}>;

type Harness = Readonly<{
  categories: CategoryAuthoringRepository;
  close(): Promise<void>;
  execute(
    postgres: string,
    sqlite: string,
    parameters?: readonly unknown[],
  ): Promise<void>;
  holdPause?: () => Promise<() => Promise<void>>;
  name: string;
  pause(paused: boolean): Promise<void>;
  query<T extends Row>(
    postgres: string,
    sqlite: string,
    parameters?: readonly unknown[],
  ): Promise<T[]>;
  state(): Promise<State>;
  themes: ThemeAuthoringRepository;
}>;

type ArticleFixture = Readonly<{
  archived?: boolean;
  articleCategoryId: string;
  id: string;
  published?: boolean;
  reviewState: "approved" | "editing" | "in_review" | "published";
  revisionCategoryId: string;
  revisionCategoryName: string;
  revisionCategorySlug: string;
}>;

function migrationFiles(dialect: keyof typeof migrationDirectories) {
  return readdirSync(migrationDirectories[dialect])
    .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
    .sort();
}

function migrationFile(dialect: keyof typeof migrationDirectories, prefix: string) {
  const filename = migrationFiles(dialect).find((candidate) =>
    candidate.startsWith(prefix),
  );
  assert.ok(filename, `${dialect} ${prefix} migration exists`);
  return filename;
}

function categoryUpdate(
  actor: MemberActor,
  expectedCategoryVersion: number,
  values: Partial<{
    description: string | null;
    id: string;
    name: string;
    position: number;
    slug: string;
  }> = {},
) {
  return {
    actor,
    category: {
      description: null,
      id: categoryId,
      name: "Guides",
      position: 0,
      slug: "guides",
      workspaceId,
      ...values,
    },
    expectedCategoryVersion,
  };
}

function themeUpdate(
  actor: MemberActor,
  expectedThemeVersion: number,
  config: unknown = { accent: "blue", nested: { density: "compact", radius: 8 } },
) {
  return {
    actor,
    expectedThemeVersion,
    theme: {
      config,
      id: themeId,
      name: "Editorial",
      workspaceId,
    },
  };
}

async function state(harness: Pick<Harness, "query">): Promise<State> {
  const [articles, categories, events, heads, themes] = await Promise.all([
    harness.query<Row>(
      "select id, category_id, status, content_hash from articles where workspace_id = $1 order by id",
      "select id, category_id, status, content_hash from articles where workspace_id = ? order by id",
      [workspaceId],
    ),
    harness.query<Row>(
      "select id, slug, name, description, position, version from categories where workspace_id = $1 order by id",
      "select id, slug, name, description, position, version from categories where workspace_id = ? order by id",
      [workspaceId],
    ),
    harness.query<Row>(
      "select id, article_id, revision_id, revision_number, member_id, action, note from article_review_events where workspace_id = $1 order by id",
      "select id, article_id, revision_id, revision_number, member_id, action, note from article_review_events where workspace_id = ? order by id",
      [workspaceId],
    ),
    harness.query<Row>(
      "select article_id, working_revision_id, published_revision_id, review_state, submitted_by_member_id, archived_at, archived_by_member_id from article_heads where workspace_id = $1 order by article_id",
      "select article_id, working_revision_id, published_revision_id, review_state, submitted_by_member_id, archived_at, archived_by_member_id from article_heads where workspace_id = ? order by article_id",
      [workspaceId],
    ),
    harness.query<Row>(
      "select id, name, config, version from themes where workspace_id = $1 order by id",
      "select id, name, config, version from themes where workspace_id = ? order by id",
      [workspaceId],
    ),
  ]);
  return { articles, categories, events, heads, themes };
}

async function applyPostgresMigrationWithClient(
  client: PoolClient,
  filename: string,
) {
  const source = readFileSync(
    path.join(migrationDirectories.postgres, filename),
    "utf8",
  );
  try {
    await client.query("begin");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function applyPostgresMigration(pool: Pool, filename: string) {
  const client = await pool.connect();
  try {
    await applyPostgresMigrationWithClient(client, filename);
  } finally {
    client.release();
  }
}

async function waitForPostgresLock(pool: Pool, processId: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [processId],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Postgres migration process ${processId} did not wait on the pause lock`);
}

async function assertMigrationRejectsConcurrentUnpause(
  pool: Pool,
  filename: string,
) {
  const unpauseClient = await pool.connect();
  const migrationClient = await pool.connect();
  let unpauseOpen = false;
  try {
    await unpauseClient.query("begin");
    unpauseOpen = true;
    await unpauseClient.query(
      `update workspace_authoring_controls
       set writes_paused = false, generation = generation + 1, changed_at = $1
       where workspace_id = $2`,
      [now, workspaceId],
    );
    const process = await migrationClient.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const migrationRace = applyPostgresMigrationWithClient(
      migrationClient,
      filename,
    ).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );
    await waitForPostgresLock(pool, process.rows[0].pid);
    await unpauseClient.query("commit");
    unpauseOpen = false;
    const result = await migrationRace;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.match(String(result.reason), /AUTHORING_MIGRATION_REQUIRES_PAUSE/u);
    }
  } finally {
    if (unpauseOpen) await unpauseClient.query("rollback");
    unpauseClient.release();
    migrationClient.release();
  }
}

async function applyPostgresBefore(pool: Pool, prefix: string) {
  for (const filename of migrationFiles("postgres")) {
    if (filename.startsWith(prefix)) break;
    await applyPostgresMigration(pool, filename);
  }
}

function applySqliteMigration(database: Database.Database, filename: string) {
  const source = readFileSync(
    path.join(migrationDirectories.sqlite, filename),
    "utf8",
  );
  database.transaction(() => database.exec(source))();
}

function applySqliteBefore(database: Database.Database, prefix: string) {
  for (const filename of migrationFiles("sqlite")) {
    if (filename.startsWith(prefix)) break;
    applySqliteMigration(database, filename);
  }
}

async function seedPostgresMember(
  pool: Pool,
  key: keyof typeof members,
  role: "administrator" | "editor" | "reviewer",
  status: "active" | "disabled" = "active",
) {
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations,
       created_by_member_id, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 600000, $9, $10, $10)`,
    [
      members[key],
      workspaceId,
      `${key}@example.test`,
      key,
      role,
      status,
      String(key[0]).toUpperCase().repeat(43),
      String(key[0]).toLowerCase().repeat(43),
      key === "administrator" ? null : members.administrator,
      now,
    ],
  );
}

async function seedPostgresSession(pool: Pool, key: keyof typeof members) {
  const isExpired = key === "expired";
  await pool.query(
    `insert into admin_sessions (
       id, workspace_id, member_id, created_at, expires_at, revoked_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      sessions[key],
      workspaceId,
      members[key],
      isExpired ? earlier : now,
      isExpired ? expired : later,
      key === "revoked" ? now : null,
    ],
  );
}

async function seedPostgresArticle(pool: Pool, fixture: ArticleFixture) {
  const revisionId = `revision_${fixture.id}`;
  await pool.query(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, content_hash, status,
       is_faq, author_name, position, published_at, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, false, 'Editor', 0, $9, $10, $10)`,
    [
      fixture.id,
      workspaceId,
      fixture.articleCategoryId,
      fixture.id,
      fixture.id,
      `# ${fixture.id}`,
      fixture.published ? null : null,
      fixture.published ? "published" : "draft",
      fixture.published ? now : null,
      now,
    ],
  );
  await pool.query(
    `insert into article_slug_claims (
       workspace_id, normalized_slug, article_id, working_claim, article_row_claim
     ) values ($1, $2, $3, true, true)`,
    [workspaceId, fixture.id, fixture.id],
  );
  await pool.query(
    `insert into article_revisions (
       id, workspace_id, article_id, revision_number, category_id, category_slug,
       category_name, slug, title, mdx, is_faq, author_name, position,
       revision_hash, change_kind, created_by_member_id, created_at
     ) values (
       $1, $2, $3, 1, $4, $5, $6, $7, $8, $9, false, 'Editor', 0,
       $10, 'manual', $11, $12
     )`,
    [
      revisionId,
      workspaceId,
      fixture.id,
      fixture.revisionCategoryId,
      fixture.revisionCategorySlug,
      fixture.revisionCategoryName,
      fixture.id,
      fixture.id,
      `# ${fixture.id}`,
      "a".repeat(64),
      members.editor,
      now,
    ],
  );
  await pool.query(
    `insert into article_heads (
       article_id, workspace_id, working_revision_id, working_revision_number,
       working_slug, published_revision_id, published_revision_number,
       review_state, submitted_by_member_id, archived_at, archived_by_member_id
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
    [
      fixture.id,
      workspaceId,
      revisionId,
      fixture.id,
      fixture.published ? revisionId : null,
      fixture.published ? 1 : null,
      fixture.reviewState,
      fixture.reviewState === "in_review" ? members.editor : null,
      fixture.archived ? now : null,
      fixture.archived ? members.administrator : null,
    ],
  );
}

async function seedPostgresPublishedPointerArticle(pool: Pool) {
  const id = "article_published_pointer";
  await pool.query(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, status, is_faq,
       author_name, position, created_at, updated_at
     ) values ($1, $2, $3, $1, $1, $4, 'draft', false, 'Editor', 0, $5, $5)`,
    [id, workspaceId, categoryId, `# ${id}`, now],
  );
  await pool.query(
    `insert into article_slug_claims (
       workspace_id, normalized_slug, article_id, working_claim, article_row_claim
     ) values ($1, $2, $2, true, true)`,
    [workspaceId, id],
  );
  await pool.query(
    `insert into article_revisions (
       id, workspace_id, article_id, revision_number, category_id, category_slug,
       category_name, slug, title, mdx, is_faq, author_name, position,
       revision_hash, change_kind, created_by_member_id, created_at
     ) values
       ('revision_published_pointer_1', $1, $2, 1, $3, 'published-only',
        'Published only', $2, $2, $4, false, 'Editor', 0, $5, 'manual', $6, $7),
       ('revision_published_pointer_2', $1, $2, 2, $8, 'guides',
        'Guides', $2, $2, $4, false, 'Editor', 0, $9, 'manual', $6, $7)`,
    [
      workspaceId,
      id,
      publishedOnlyCategoryId,
      `# ${id}`,
      "1".repeat(64),
      members.editor,
      now,
      categoryId,
      "2".repeat(64),
    ],
  );
  await pool.query(
    `insert into article_heads (
       article_id, workspace_id, working_revision_id, working_revision_number,
       working_slug, published_revision_id, published_revision_number,
       review_state, submitted_by_member_id, archived_at, archived_by_member_id
     ) values (
       $1, $2, 'revision_published_pointer_2', 2, $1,
       'revision_published_pointer_1', 1, 'editing', null, $3, $4
     )`,
    [id, workspaceId, now, members.administrator],
  );
}

function seedSqliteMember(
  database: Database.Database,
  key: keyof typeof members,
  role: "administrator" | "editor" | "reviewer",
  status: "active" | "disabled" = "active",
) {
  database
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, 600000, ?, ?, ?)`,
    )
    .run(
      members[key],
      workspaceId,
      `${key}@example.test`,
      key,
      role,
      status,
      String(key[0]).toUpperCase().repeat(43),
      String(key[0]).toLowerCase().repeat(43),
      key === "administrator" ? null : members.administrator,
      now.getTime(),
      now.getTime(),
    );
}

function seedSqliteSession(database: Database.Database, key: keyof typeof members) {
  const isExpired = key === "expired";
  database
    .prepare(
      `insert into admin_sessions (
         id, workspace_id, member_id, created_at, expires_at, revoked_at
       ) values (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessions[key],
      workspaceId,
      members[key],
      isExpired ? earlier.getTime() : now.getTime(),
      isExpired ? expired.getTime() : later.getTime(),
      key === "revoked" ? now.getTime() : null,
    );
}

function seedSqliteArticle(database: Database.Database, fixture: ArticleFixture) {
  const revisionId = `revision_${fixture.id}`;
  database
    .prepare(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, content_hash, status,
         is_faq, author_name, position, published_at, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, null, ?, 0, 'Editor', 0, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      workspaceId,
      fixture.articleCategoryId,
      fixture.id,
      fixture.id,
      `# ${fixture.id}`,
      fixture.published ? "published" : "draft",
      fixture.published ? now.getTime() : null,
      now.getTime(),
      now.getTime(),
    );
  database
    .prepare(
      `insert into article_slug_claims (
         workspace_id, normalized_slug, article_id, working_claim, article_row_claim
       ) values (?, ?, ?, 1, 1)`,
    )
    .run(workspaceId, fixture.id, fixture.id);
  database
    .prepare(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id, category_slug,
         category_name, slug, title, mdx, is_faq, author_name, position,
         revision_hash, change_kind, created_by_member_id, created_at
       ) values (
         ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, 'Editor', 0,
         ?, 'manual', ?, ?
       )`,
    )
    .run(
      revisionId,
      workspaceId,
      fixture.id,
      fixture.revisionCategoryId,
      fixture.revisionCategorySlug,
      fixture.revisionCategoryName,
      fixture.id,
      fixture.id,
      `# ${fixture.id}`,
      "a".repeat(64),
      members.editor,
      now.getTime(),
    );
  database
    .prepare(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, published_revision_id, published_revision_number,
         review_state, submitted_by_member_id, archived_at, archived_by_member_id
       ) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      workspaceId,
      revisionId,
      fixture.id,
      fixture.published ? revisionId : null,
      fixture.published ? 1 : null,
      fixture.reviewState,
      fixture.reviewState === "in_review" ? members.editor : null,
      fixture.archived ? now.getTime() : null,
      fixture.archived ? members.administrator : null,
    );
}

function seedSqlitePublishedPointerArticle(database: Database.Database) {
  const id = "article_published_pointer";
  database
    .prepare(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, status, is_faq,
         author_name, position, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, 'draft', 0, 'Editor', 0, ?, ?)`,
    )
    .run(id, workspaceId, categoryId, id, id, `# ${id}`, now.getTime(), now.getTime());
  database
    .prepare(
      `insert into article_slug_claims (
         workspace_id, normalized_slug, article_id, working_claim, article_row_claim
       ) values (?, ?, ?, 1, 1)`,
    )
    .run(workspaceId, id, id);
  database
    .prepare(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id, category_slug,
         category_name, slug, title, mdx, is_faq, author_name, position,
         revision_hash, change_kind, created_by_member_id, created_at
       ) values
         ('revision_published_pointer_1', ?, ?, 1, ?, 'published-only',
          'Published only', ?, ?, ?, 0, 'Editor', 0, ?, 'manual', ?, ?),
         ('revision_published_pointer_2', ?, ?, 2, ?, 'guides',
          'Guides', ?, ?, ?, 0, 'Editor', 0, ?, 'manual', ?, ?)`,
    )
    .run(
      workspaceId,
      id,
      publishedOnlyCategoryId,
      id,
      id,
      `# ${id}`,
      "1".repeat(64),
      members.editor,
      now.getTime(),
      workspaceId,
      id,
      categoryId,
      id,
      id,
      `# ${id}`,
      "2".repeat(64),
      members.editor,
      now.getTime(),
    );
  database
    .prepare(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, published_revision_id, published_revision_number,
         review_state, submitted_by_member_id, archived_at, archived_by_member_id
       ) values (
         ?, ?, 'revision_published_pointer_2', 2, ?,
         'revision_published_pointer_1', 1, 'editing', null, ?, ?
       )`,
    )
    .run(id, workspaceId, id, now.getTime(), members.administrator);
}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  try {
    await applyPostgresBefore(pool, "0011_");
    await pool.query(
      "insert into workspaces (id, slug, name, created_at, updated_at) values ($1, 'authoring', 'Authoring', $2, $2)",
      [workspaceId, now],
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = true, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );
    await assertMigrationRejectsConcurrentUnpause(
      pool,
      migrationFile("postgres", "0011_"),
    );
    assert.equal(
      Number(
        (
          await pool.query(
            `select count(*) from information_schema.tables
             where table_schema = 'public' and table_name = 'workspace_members'`,
          )
        ).rows[0].count,
      ),
      0,
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = true, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );
    await applyPostgresMigration(pool, migrationFile("postgres", "0011_"));
    await pool.query(
      "update workspace_authoring_controls set writes_paused = false, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );
    await assert.rejects(
      applyPostgresMigration(pool, migrationFile("postgres", "0012_")),
      /AUTHORING_MIGRATION_REQUIRES_PAUSE/u,
    );
    assert.deepEqual(
      (
        await pool.query(
          `select table_name, column_name
           from information_schema.columns
           where table_schema = 'public'
             and ((table_name = 'categories' and column_name = 'version')
               or (table_name = 'themes' and column_name = 'version')
               or (table_name = 'article_heads' and column_name = 'submitted_by_member_id'))
           order by table_name`,
        )
      ).rows,
      [],
    );
    await pool.query(
      "insert into workspaces (id, slug, name, created_at, updated_at) values ('workspace_missing_control', 'missing-control', 'Missing control', $1, $1)",
      [now],
    );
    await pool.query(
      "delete from workspace_authoring_controls where workspace_id = 'workspace_missing_control'",
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = true, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );
    await assert.rejects(
      applyPostgresMigration(pool, migrationFile("postgres", "0012_")),
      /AUTHORING_MIGRATION_REQUIRES_PAUSE/u,
    );
    assert.deepEqual(
      (
        await pool.query(
          `select table_name, column_name
           from information_schema.columns
           where table_schema = 'public'
             and ((table_name = 'categories' and column_name = 'version')
               or (table_name = 'themes' and column_name = 'version')
               or (table_name = 'article_heads' and column_name = 'submitted_by_member_id'))
           order by table_name`,
        )
      ).rows,
      [],
    );
    await pool.query(
      `insert into workspace_authoring_controls (
         workspace_id, writes_paused, generation, changed_at
       ) values ('workspace_missing_control', true, 0, $1)`,
      [now],
    );
    await assertMigrationRejectsConcurrentUnpause(
      pool,
      migrationFile("postgres", "0012_"),
    );
    assert.equal(
      Number(
        (
          await pool.query(
            `select count(*) from information_schema.columns
             where table_schema = 'public'
               and table_name = 'categories' and column_name = 'version'`,
          )
        ).rows[0].count,
      ),
      0,
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = true, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );
    await applyPostgresMigration(pool, migrationFile("postgres", "0012_"));
    assert.equal(
      Number(
        (
          await pool.query(
            `select count(*) from information_schema.columns
             where table_schema = 'public'
               and ((table_name = 'categories' and column_name = 'version')
                 or (table_name = 'themes' and column_name = 'version')
                 or (table_name = 'article_heads' and column_name = 'submitted_by_member_id'))`,
          )
        ).rows[0].count,
      ),
      3,
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = false, generation = generation + 1, changed_at = $1 where workspace_id = $2",
      [now, workspaceId],
    );

    await seedPostgresMember(pool, "administrator", "administrator");
    await seedPostgresMember(pool, "editor", "editor");
    await seedPostgresMember(pool, "reviewer", "reviewer");
    await seedPostgresMember(pool, "disabled", "editor", "disabled");
    await seedPostgresMember(pool, "revoked", "editor");
    await seedPostgresMember(pool, "expired", "editor");
    for (const key of Object.keys(members) as (keyof typeof members)[]) {
      await seedPostgresSession(pool, key);
    }
    await pool.query(
      `insert into categories (
         id, workspace_id, slug, name, description, position, created_at, updated_at
       ) values
         ($1, $6, 'guides', 'Guides', null, 0, $7, $7),
         ($2, $6, 'rollback', 'Rollback', null, 1, $7, $7),
         ($3, $6, 'working-only', 'Working only', null, 2, $7, $7),
         ($4, $6, 'published-only', 'Published only', null, 3, $7, $7),
         ($5, $6, 'stale-projection', 'Stale projection', null, 4, $7, $7)`,
      [
        categoryId,
        rollbackCategoryId,
        workingOnlyCategoryId,
        publishedOnlyCategoryId,
        staleProjectionCategoryId,
        workspaceId,
        now,
      ],
    );
    await pool.query(
      `insert into themes (id, workspace_id, name, config, created_at, updated_at)
       values ($1, $2, 'Editorial', $3::jsonb, $4, $4)`,
      [
        themeId,
        workspaceId,
        JSON.stringify({ nested: { radius: 8, density: "compact" }, accent: "blue" }),
        now,
      ],
    );

    const fixtures: ArticleFixture[] = [
      {
        articleCategoryId: categoryId,
        id: "article_in_review",
        reviewState: "in_review",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        archived: true,
        articleCategoryId: categoryId,
        id: "article_approved_archived",
        reviewState: "approved",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: categoryId,
        id: "article_editing",
        reviewState: "editing",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: categoryId,
        id: "article_live_without_hash",
        published: true,
        reviewState: "published",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        archived: true,
        articleCategoryId: categoryId,
        id: "article_working_pointer",
        reviewState: "editing",
        revisionCategoryId: workingOnlyCategoryId,
        revisionCategoryName: "Working only",
        revisionCategorySlug: "working-only",
      },
      {
        articleCategoryId: staleProjectionCategoryId,
        id: "article_stale_projection",
        reviewState: "editing",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: rollbackCategoryId,
        id: "article_rollback",
        reviewState: "in_review",
        revisionCategoryId: rollbackCategoryId,
        revisionCategoryName: "Rollback",
        revisionCategorySlug: "rollback",
      },
    ];
    for (const fixture of fixtures) await seedPostgresArticle(pool, fixture);
    await seedPostgresPublishedPointerArticle(pool);
    await pool.query(
      `insert into article_review_events (
         id, workspace_id, article_id, revision_id, revision_number,
         member_id, action, note, created_at
       ) values ($1, $2, 'article_rollback', 'revision_article_rollback', 1,
                 $3, 'submitted', null, $4)`,
      [
        "category_changed:2:revision_article_rollback",
        workspaceId,
        members.editor,
        now,
      ],
    );
    for (const statement of postgresTeamAuthoringGuardStatements) {
      await pool.query(statement);
    }
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  const harness: Harness = {
    categories: createPostgresCategoryAuthoringRepository(database, {
      clock: () => now,
    }),
    themes: createPostgresThemeAuthoringRepository(database, { clock: () => now }),
    name: "Postgres",
    async execute(postgres, _sqlite, parameters = []) {
      await pool.query(postgres, [...parameters]);
    },
    async pause(paused) {
      await pool.query(
        `update workspace_authoring_controls
         set writes_paused = $1, generation = generation + 1, changed_at = $2
         where workspace_id = $3`,
        [paused, now, workspaceId],
      );
    },
    async query<T extends Row>(
      postgres: string,
      _sqlite: string,
      parameters: readonly unknown[] = [],
    ) {
      return (await pool.query<T>(postgres, [...parameters])).rows;
    },
    async state() {
      return state(harness);
    },
    async holdPause() {
      const client: PoolClient = await pool.connect();
      await client.query("begin");
      await client.query(
        `update workspace_authoring_controls
         set writes_paused = true, generation = generation + 1, changed_at = $1
         where workspace_id = $2`,
        [now, workspaceId],
      );
      return async () => {
        await client.query("commit");
        client.release();
      };
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
  return harness;
}

async function createSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  try {
    applySqliteBefore(client, "0011_");
    client
      .prepare(
        "insert into workspaces (id, slug, name, created_at, updated_at) values (?, 'authoring', 'Authoring', ?, ?)",
      )
      .run(workspaceId, now.getTime(), now.getTime());
    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1, changed_at = ?
         where workspace_id = ?`,
      )
      .run(now.getTime(), workspaceId);
    applySqliteMigration(client, migrationFile("sqlite", "0011_"));
    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 0, generation = generation + 1, changed_at = ?
         where workspace_id = ?`,
      )
      .run(now.getTime(), workspaceId);
    assert.throws(
      () => applySqliteMigration(client, migrationFile("sqlite", "0012_")),
      /constraint|AUTHORING_MIGRATION_REQUIRES_PAUSE/iu,
    );
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from pragma_table_info('categories') where name = 'version'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from pragma_table_info('article_heads')
             where name = 'submitted_by_member_id'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    client
      .prepare(
        "insert into workspaces (id, slug, name, created_at, updated_at) values ('workspace_missing_control', 'missing-control', 'Missing control', ?, ?)",
      )
      .run(now.getTime(), now.getTime());
    client
      .prepare(
        "delete from workspace_authoring_controls where workspace_id = 'workspace_missing_control'",
      )
      .run();
    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1, changed_at = ?
         where workspace_id = ?`,
      )
      .run(now.getTime(), workspaceId);
    assert.throws(
      () => applySqliteMigration(client, migrationFile("sqlite", "0012_")),
      /constraint|AUTHORING_MIGRATION_REQUIRES_PAUSE/iu,
    );
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from pragma_table_info('categories') where name = 'version'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from pragma_table_info('article_heads')
             where name = 'submitted_by_member_id'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    client
      .prepare(
        `insert into workspace_authoring_controls (
           workspace_id, writes_paused, generation, changed_at
         ) values ('workspace_missing_control', 1, 0, ?)`,
      )
      .run(now.getTime());
    applySqliteMigration(client, migrationFile("sqlite", "0012_"));
    const retainedHeadTriggers = client
      .prepare(
        `select name from sqlite_master
         where type = 'trigger' and name in (
           'article_heads_authoring_control_insert_trigger',
           'article_heads_authoring_control_update_trigger',
           'article_heads_authoring_control_delete_trigger',
           'article_heads_integrity_insert_trigger',
           'article_heads_integrity_update_trigger'
         ) order by name`,
      )
      .all() as { name: string }[];
    assert.equal(retainedHeadTriggers.length, 5);
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from pragma_foreign_key_list('article_heads')
             where "from" = 'submitted_by_member_id'`,
          )
          .get() as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 0, generation = generation + 1, changed_at = ?
         where workspace_id = ?`,
      )
      .run(now.getTime(), workspaceId);

    seedSqliteMember(client, "administrator", "administrator");
    seedSqliteMember(client, "editor", "editor");
    seedSqliteMember(client, "reviewer", "reviewer");
    seedSqliteMember(client, "disabled", "editor", "disabled");
    seedSqliteMember(client, "revoked", "editor");
    seedSqliteMember(client, "expired", "editor");
    for (const key of Object.keys(members) as (keyof typeof members)[]) {
      seedSqliteSession(client, key);
    }
    client
      .prepare(
        `insert into categories (
           id, workspace_id, slug, name, description, position, created_at, updated_at
         ) values
           (?, ?, 'guides', 'Guides', null, 0, ?, ?),
           (?, ?, 'rollback', 'Rollback', null, 1, ?, ?),
           (?, ?, 'working-only', 'Working only', null, 2, ?, ?),
           (?, ?, 'published-only', 'Published only', null, 3, ?, ?),
           (?, ?, 'stale-projection', 'Stale projection', null, 4, ?, ?)`,
      )
      .run(
        categoryId,
        workspaceId,
        now.getTime(),
        now.getTime(),
        rollbackCategoryId,
        workspaceId,
        now.getTime(),
        now.getTime(),
        workingOnlyCategoryId,
        workspaceId,
        now.getTime(),
        now.getTime(),
        publishedOnlyCategoryId,
        workspaceId,
        now.getTime(),
        now.getTime(),
        staleProjectionCategoryId,
        workspaceId,
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into themes (id, workspace_id, name, config, created_at, updated_at)
         values (?, ?, 'Editorial', ?, ?, ?)`,
      )
      .run(
        themeId,
        workspaceId,
        JSON.stringify({ nested: { radius: 8, density: "compact" }, accent: "blue" }),
        now.getTime(),
        now.getTime(),
      );

    const fixtures: ArticleFixture[] = [
      {
        articleCategoryId: categoryId,
        id: "article_in_review",
        reviewState: "in_review",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        archived: true,
        articleCategoryId: categoryId,
        id: "article_approved_archived",
        reviewState: "approved",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: categoryId,
        id: "article_editing",
        reviewState: "editing",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: categoryId,
        id: "article_live_without_hash",
        published: true,
        reviewState: "published",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        archived: true,
        articleCategoryId: categoryId,
        id: "article_working_pointer",
        reviewState: "editing",
        revisionCategoryId: workingOnlyCategoryId,
        revisionCategoryName: "Working only",
        revisionCategorySlug: "working-only",
      },
      {
        articleCategoryId: staleProjectionCategoryId,
        id: "article_stale_projection",
        reviewState: "editing",
        revisionCategoryId: categoryId,
        revisionCategoryName: "Guides",
        revisionCategorySlug: "guides",
      },
      {
        articleCategoryId: rollbackCategoryId,
        id: "article_rollback",
        reviewState: "in_review",
        revisionCategoryId: rollbackCategoryId,
        revisionCategoryName: "Rollback",
        revisionCategorySlug: "rollback",
      },
    ];
    for (const fixture of fixtures) seedSqliteArticle(client, fixture);
    seedSqlitePublishedPointerArticle(client);
    client
      .prepare(
        `insert into article_review_events (
           id, workspace_id, article_id, revision_id, revision_number,
           member_id, action, note, created_at
         ) values (?, ?, 'article_rollback', 'revision_article_rollback', 1,
                   ?, 'submitted', null, ?)`,
      )
      .run(
        "category_changed:2:revision_article_rollback",
        workspaceId,
        members.editor,
        now.getTime(),
      );
    for (const statement of sqliteTeamAuthoringGuardStatements) client.exec(statement);
  } catch (error) {
    client.close();
    throw error;
  }

  const harness: Harness = {
    categories: createSqliteCategoryAuthoringRepository(database, {
      clock: () => now,
    }),
    themes: createSqliteThemeAuthoringRepository(database, { clock: () => now }),
    name: "SQLite",
    async execute(_postgres, sqlite, parameters = []) {
      client.prepare(sqlite).run(...parameters);
    },
    async pause(paused) {
      client
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1, changed_at = ?
           where workspace_id = ?`,
        )
        .run(paused ? 1 : 0, now.getTime(), workspaceId);
    },
    async query<T extends Row>(
      _postgres: string,
      sqlite: string,
      parameters: readonly unknown[] = [],
    ) {
      return client.prepare(sqlite).all(...parameters) as T[];
    },
    async state() {
      return state(harness);
    },
    async close() {
      client.close();
    },
  };
  return harness;
}

async function exerciseAuthoring(harness: Harness) {
  const listed = await harness.categories.listCategories(workspaceId);
  assert.equal(listed.find((entry) => entry.id === categoryId)?.version, 1);
  assert.equal((await harness.themes.getTheme(workspaceId))?.version, 1);

  const beforeRejectedActors = await harness.state();
  for (const actor of [actors.disabled, actors.revoked, actors.expired, actors.reviewer]) {
    assert.deepEqual(await harness.categories.updateCategory(categoryUpdate(actor, 1)), {
      status: "rejected",
      code: "ACTOR_FORBIDDEN",
    });
  }
  assert.deepEqual(
    await harness.categories.updateCategory(
      categoryUpdate(
        { ...actors.administrator, workspaceId: "workspace_other" },
        1,
      ),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  for (const actor of [
    actors.disabled,
    actors.revoked,
    actors.expired,
    actors.editor,
    actors.reviewer,
  ]) {
    assert.deepEqual(await harness.themes.updateTheme(themeUpdate(actor, 1)), {
      status: "rejected",
      code: "ACTOR_FORBIDDEN",
    });
  }
  assert.deepEqual(await harness.state(), beforeRejectedActors);

  const beforePause = await harness.state();
  await harness.pause(true);
  await assert.rejects(
    harness.categories.updateCategory(categoryUpdate(actors.editor, 1)),
    AuthoringPausedError,
  );
  await assert.rejects(
    harness.themes.updateTheme(themeUpdate(actors.administrator, 1)),
    AuthoringPausedError,
  );
  await assert.rejects(
    harness.execute(
      "update article_heads set review_state = 'editing', submitted_by_member_id = null where workspace_id = $1 and article_id = 'article_in_review'",
      "update article_heads set review_state = 'editing', submitted_by_member_id = null where workspace_id = ? and article_id = 'article_in_review'",
      [workspaceId],
    ),
    /AUTHORING_PAUSED/u,
  );
  assert.deepEqual(await harness.state(), beforePause);
  await harness.pause(false);

  if (harness.holdPause) {
    const beforeRace = await harness.state();
    const releasePause = await harness.holdPause();
    const pendingCategory = harness.categories.updateCategory(
      categoryUpdate(actors.editor, 1, { description: "must not commit" }),
    );
    const pendingTheme = harness.themes.updateTheme(
      themeUpdate(actors.administrator, 1, { accent: "must-not-commit" }),
    );
    const pendingResults = Promise.allSettled([pendingCategory, pendingTheme]);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await releasePause();
    const raceResults = await pendingResults;
    assert.ok(
      raceResults.every(
        (result) =>
          result.status === "rejected" && result.reason instanceof AuthoringPausedError,
      ),
    );
    assert.deepEqual(await harness.state(), beforeRace);
    await harness.pause(false);
  }

  const categoryNoop = await harness.categories.updateCategory(
    categoryUpdate(actors.editor, 1),
  );
  assert.equal(categoryNoop.status, "unchanged");
  if (categoryNoop.status === "unchanged") {
    assert.equal(categoryNoop.category.version, 1);
  }

  const themeNoop = await harness.themes.updateTheme(
    themeUpdate(actors.administrator, 1),
  );
  assert.equal(themeNoop.status, "unchanged");
  if (themeNoop.status === "unchanged") {
    assert.equal(themeNoop.theme.version, 1);
  }

  const beforeRenameArticles = (
    await harness.query<Row>(
      "select * from articles where workspace_id = $1 order by id",
      "select * from articles where workspace_id = ? order by id",
      [workspaceId],
    )
  );
  const renamed = await harness.categories.updateCategory(
    categoryUpdate(actors.editor, 1, { name: "Support" }),
  );
  assert.equal(renamed.status, "updated");
  if (renamed.status === "updated") {
    assert.equal(renamed.category.name, "Support");
    assert.equal(renamed.category.version, 2);
  }
  assert.deepEqual(
    await harness.query<Row>(
      "select * from articles where workspace_id = $1 order by id",
      "select * from articles where workspace_id = ? order by id",
      [workspaceId],
    ),
    beforeRenameArticles,
  );
  const reviewHeads = await harness.query<{
    article_id: string;
    review_state: string;
    submitted_by_member_id: string | null;
  }>(
    `select article_id, review_state, submitted_by_member_id
     from article_heads
     where workspace_id = $1
       and article_id in ('article_in_review', 'article_approved_archived', 'article_editing')
     order by article_id`,
    `select article_id, review_state, submitted_by_member_id
     from article_heads
     where workspace_id = ?
       and article_id in ('article_in_review', 'article_approved_archived', 'article_editing')
     order by article_id`,
    [workspaceId],
  );
  assert.deepEqual(reviewHeads, [
    {
      article_id: "article_approved_archived",
      review_state: "changes_requested",
      submitted_by_member_id: null,
    },
    {
      article_id: "article_editing",
      review_state: "editing",
      submitted_by_member_id: null,
    },
    {
      article_id: "article_in_review",
      review_state: "changes_requested",
      submitted_by_member_id: null,
    },
  ]);
  assert.deepEqual(
    await harness.query<Row>(
      `select id, article_id, revision_id, revision_number, member_id, action, note
       from article_review_events
       where workspace_id = $1 and action = 'category_changed'
       order by id`,
      `select id, article_id, revision_id, revision_number, member_id, action, note
       from article_review_events
       where workspace_id = ? and action = 'category_changed'
       order by id`,
      [workspaceId],
    ),
    [
      {
        id: "category_changed:2:revision_article_approved_archived",
        article_id: "article_approved_archived",
        revision_id: "revision_article_approved_archived",
        revision_number: 1,
        member_id: members.editor,
        action: "category_changed",
        note: null,
      },
      {
        id: "category_changed:2:revision_article_in_review",
        article_id: "article_in_review",
        revision_id: "revision_article_in_review",
        revision_number: 1,
        member_id: members.editor,
        action: "category_changed",
        note: null,
      },
    ],
  );

  const beforeStaleCategory = await harness.state();
  assert.deepEqual(
    await harness.categories.updateCategory(
      categoryUpdate(actors.editor, 1, { name: "Stale overwrite" }),
    ),
    { status: "conflict", code: "STALE_CATEGORY", currentVersion: 2 },
  );
  assert.deepEqual(await harness.state(), beforeStaleCategory);

  const competingCategoryUpdates = await Promise.all([
    harness.categories.updateCategory(
      categoryUpdate(actors.editor, 2, { name: "Support One" }),
    ),
    harness.categories.updateCategory(
      categoryUpdate(actors.administrator, 2, { name: "Support Two" }),
    ),
  ]);
  const categoryWinner = competingCategoryUpdates.find(
    (result) => result.status === "updated",
  );
  const categoryLoser = competingCategoryUpdates.find(
    (result) => result.status === "conflict",
  );
  assert.ok(categoryWinner && categoryWinner.status === "updated");
  assert.equal(categoryWinner.category.version, 3);
  assert.ok(["Support One", "Support Two"].includes(categoryWinner.category.name));
  assert.deepEqual(categoryLoser, {
    status: "conflict",
    code: "STALE_CATEGORY",
    currentVersion: 3,
  });

  const beforeLiveSlug = await harness.state();
  assert.deepEqual(
    await harness.categories.updateCategory(
      categoryUpdate(actors.editor, 3, {
        name: categoryWinner.category.name,
        slug: "moved-guides",
      }),
    ),
    { status: "rejected", code: "LIVE_CATEGORY_SLUG" },
  );
  assert.deepEqual(await harness.state(), beforeLiveSlug);

  const beforeBlockedDeletes = await harness.state();
  for (const target of [
    { id: categoryId, version: 3 },
    { id: workingOnlyCategoryId, version: 1 },
    { id: publishedOnlyCategoryId, version: 1 },
  ]) {
    assert.deepEqual(
      await harness.categories.deleteCategory({
        actor: actors.editor,
        category: { id: target.id, workspaceId },
        expectedCategoryVersion: target.version,
      }),
      { status: "rejected", code: "CATEGORY_REFERENCED" },
    );
  }
  assert.deepEqual(await harness.state(), beforeBlockedDeletes);

  const beforeAtomicFailure = await harness.state();
  await assert.rejects(
    harness.categories.updateCategory({
      actor: actors.editor,
      category: {
        description: null,
        id: rollbackCategoryId,
        name: "Rollback changed",
        position: 1,
        slug: "rollback",
        workspaceId,
      },
      expectedCategoryVersion: 1,
    }),
  );
  assert.deepEqual(await harness.state(), beforeAtomicFailure);

  assert.deepEqual(
    await harness.categories.deleteCategory({
      actor: actors.editor,
      category: { id: staleProjectionCategoryId, workspaceId },
      expectedCategoryVersion: 1,
    }),
    { status: "deleted", categoryId: staleProjectionCategoryId },
  );
  assert.deepEqual(
    await harness.query<Row>(
      "select category_id from articles where workspace_id = $1 and id = 'article_stale_projection'",
      "select category_id from articles where workspace_id = ? and id = 'article_stale_projection'",
      [workspaceId],
    ),
    [{ category_id: categoryId }],
  );
  assert.equal(
    (
      await harness.query<Row>(
        "select count(*) as count from article_heads where workspace_id = $1 and article_id = 'article_stale_projection'",
        "select count(*) as count from article_heads where workspace_id = ? and article_id = 'article_stale_projection'",
        [workspaceId],
      )
    )[0].count,
    harness.name === "Postgres" ? "1" : 1,
  );

  const created = await harness.categories.createCategory({
    actor: actors.editor,
    category: {
      description: "Temporary",
      id: "category_temporary",
      name: "Temporary",
      position: 10,
      slug: "temporary",
      workspaceId,
    },
    expectedCategoryVersion: 0,
  });
  assert.equal(created.status, "created");
  if (created.status === "created") assert.equal(created.category.version, 1);
  assert.deepEqual(
    await harness.categories.deleteCategory({
      actor: actors.administrator,
      category: { id: "category_temporary", workspaceId },
      expectedCategoryVersion: 1,
    }),
    { status: "deleted", categoryId: "category_temporary" },
  );

  const updatedTheme = await harness.themes.updateTheme(
    themeUpdate(actors.administrator, 1, {
      accent: "orange",
      nested: { density: "compact", radius: 8 },
    }),
  );
  assert.equal(updatedTheme.status, "updated");
  if (updatedTheme.status === "updated") {
    assert.equal(updatedTheme.theme.version, 2);
    assert.deepEqual(updatedTheme.theme.config, {
      accent: "orange",
      nested: { density: "compact", radius: 8 },
    });
  }
  assert.deepEqual(
    await harness.themes.updateTheme(
      themeUpdate(actors.administrator, 1, { accent: "stale" }),
    ),
    { status: "conflict", code: "STALE_THEME", currentVersion: 2 },
  );

  const competingThemeUpdates = await Promise.all([
    harness.themes.updateTheme(
      themeUpdate(actors.administrator, 2, { accent: "green" }),
    ),
    harness.themes.updateTheme(
      themeUpdate(actors.administrator, 2, { accent: "purple" }),
    ),
  ]);
  const themeWinner = competingThemeUpdates.find(
    (result) => result.status === "updated",
  );
  const themeLoser = competingThemeUpdates.find(
    (result) => result.status === "conflict",
  );
  assert.ok(themeWinner && themeWinner.status === "updated");
  assert.equal(themeWinner.theme.version, 3);
  assert.ok(
    themeWinner.theme.config !== null &&
      typeof themeWinner.theme.config === "object" &&
      "accent" in themeWinner.theme.config &&
      ["green", "purple"].includes(String(themeWinner.theme.config.accent)),
  );
  assert.deepEqual(themeLoser, {
    status: "conflict",
    code: "STALE_THEME",
    currentVersion: 3,
  });
}

test("SQLite category and theme authoring obeys the fenced contract", async () => {
  const harness = await createSqliteHarness();
  try {
    await exerciseAuthoring(harness);
  } finally {
    await harness.close();
  }
});

test("general repositories expose no category or theme mutation bypass", () => {
  assert.equal(repositoryUsesDedicatedCategoryThemeAuthoring, true);
});

test(
  "Postgres category and theme authoring obeys the fenced contract",
  { timeout: 120_000 },
  async () => {
    const harness = await createPostgresHarness();
    try {
      await exerciseAuthoring(harness);
    } finally {
      await harness.close();
    }
  },
);
