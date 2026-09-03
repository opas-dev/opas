// ABOUTME: Proves committed archive and member-disable races cannot return later previews.
// ABOUTME: Holds real preview repository reads behind barriers while production mutations commit.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import {
  issueArticlePreview,
  type ArticlePreviewRepository,
} from "@/auth/article-preview";
import {
  handleArticlePreviewAsset,
  handleArticlePreviewSession,
} from "@/auth/article-preview-http";
import { articlePreviewCookieName } from "@/auth/preview-claims";
import type { MemberRepository } from "@/auth/member-repository";
import type { ArticleDraftRepository } from "@/db/article-drafts";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { createPostgresArticlePreviewRepository } from "@/db/postgres/article-preview-repository";
import { createPostgresMemberRepository } from "@/db/postgres/member-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { createSqliteArticlePreviewRepository } from "@/db/sqlite/article-preview-repository";
import { createSqliteMemberRepository } from "@/db/sqlite/member-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const origin = "https://preview-race.example.test";
const issuedAt = new Date("2026-09-03T12:00:00.000Z");
const checkedAt = new Date("2026-09-03T12:05:00.000Z");
const changedAt = new Date("2026-09-03T12:06:00.000Z");
const assetHash = "a".repeat(64);
const configuration = Object.freeze({
  deploymentId: "preview-race.example.test",
  signingSecret: "preview-race-signing-secret-at-least-32-bytes",
});

type RaceScenario = Readonly<{
  archive(): Promise<unknown>;
  creator: Readonly<{ memberId: string; sessionId: string; workspaceId: string }>;
  disableCreator(): Promise<unknown>;
  previewRepository: ArticlePreviewRepository;
  revisionId: string;
}>;

type RaceHarness = Readonly<{
  close(): Promise<void>;
  scenario(index: number): Promise<RaceScenario>;
}>;

type PreviewRead = "asset" | "page";
type PreviewInvalidation = "archive" | "disable";

function fixedBytes(offset: number) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

function id43(character: string) {
  return character.repeat(43);
}

function blockedRepository(
  repository: ArticlePreviewRepository,
  read: PreviewRead,
) {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let blocked = false;
  async function hold() {
    if (blocked) throw new Error("PREVIEW_RACE_BARRIER_REUSED");
    blocked = true;
    enter();
    await resumed;
  }
  const wrapped: ArticlePreviewRepository = {
    findActiveGrant(request) {
      return repository.findActiveGrant(request);
    },
    findManagedGrant(request) {
      return repository.findManagedGrant(request);
    },
    async readActiveAsset(request) {
      if (read === "asset") await hold();
      return repository.readActiveAsset(request);
    },
    async readActiveRevision(request) {
      if (read === "page") await hold();
      return repository.readActiveRevision(request);
    },
    revokeGrant(request) {
      return repository.revokeGrant(request);
    },
    rotateGrant(request) {
      return repository.rotateGrant(request);
    },
  };
  return { entered, repository: wrapped, resume };
}

function previewRequest(pathname: string, token: string) {
  return new Request(`${origin}${pathname}`, {
    headers: {
      cookie: `${articlePreviewCookieName(configuration.deploymentId)}=${token}`,
      referer: `${origin}/preview`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
  });
}

async function runRace(
  scenario: RaceScenario,
  invalidation: PreviewInvalidation,
  read: PreviewRead,
  randomOffset: number,
) {
  const issued = await issueArticlePreview(
    scenario.creator,
    scenario.revisionId,
    configuration,
    {
      clock: () => issuedAt,
      randomBytes: fixedBytes(randomOffset),
      repository: scenario.previewRepository,
    },
  );
  assert.equal(issued.outcome, "issued");
  if (issued.outcome !== "issued") return;

  const barrier = blockedRepository(scenario.previewRepository, read);
  const runtime = {
    clock: () => checkedAt,
    configuration,
    repository: barrier.repository,
    siteOrigin: origin,
  };
  const pendingResponse =
    read === "page"
      ? handleArticlePreviewSession(
          previewRequest("/preview/session", issued.token),
          runtime,
        )
      : handleArticlePreviewAsset(
          previewRequest(`/preview/assets/${assetHash}`, issued.token),
          assetHash,
          runtime,
        );

  await barrier.entered;
  let mutation: unknown;
  try {
    mutation =
      invalidation === "archive"
        ? await scenario.archive()
        : await scenario.disableCreator();
  } finally {
    barrier.resume();
  }
  if (invalidation === "archive") {
    assert.equal(
      (mutation as { status?: string }).status,
      "transitioned",
      "the archive must commit before the preview read resumes",
    );
  } else {
    assert.equal(
      mutation,
      "changed",
      "the member disable must commit before the preview read resumes",
    );
  }

  const response = await pendingResponse;
  assert.equal(response.status, read === "page" ? 401 : 404);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

type ScenarioValues = Readonly<{
  adminId: string;
  adminSessionId: string;
  articleId: string;
  assetId: string;
  categoryId: string;
  creatorId: string;
  creatorSessionId: string;
  eventId: string;
  revisionId: string;
  slug: string;
  workspaceId: string;
}>;

function scenarioValues(index: number): ScenarioValues {
  const suffix = String(index).padStart(2, "0");
  return {
    adminId: `member_race_admin_${suffix}`,
    adminSessionId: id43(String.fromCharCode(65 + index)),
    articleId: `article_race_${suffix}`,
    assetId: `asset_race_${suffix}`,
    categoryId: `category_race_${suffix}`,
    creatorId: `member_race_creator_${suffix}`,
    creatorSessionId: id43(String.fromCharCode(75 + index)),
    eventId: `review_event_race_${suffix}`,
    revisionId: `revision_race_${suffix}`,
    slug: `preview-race-${suffix}`,
    workspaceId: `workspace_race_${suffix}`,
  };
}

function raceScenario(
  values: ScenarioValues,
  drafts: ArticleDraftRepository,
  members: MemberRepository,
  previewRepository: ArticlePreviewRepository,
): RaceScenario {
  const admin = Object.freeze({
    memberId: values.adminId,
    sessionId: values.adminSessionId,
    workspaceId: values.workspaceId,
  });
  const creator = Object.freeze({
    memberId: values.creatorId,
    sessionId: values.creatorSessionId,
    workspaceId: values.workspaceId,
  });
  return {
    archive: () =>
      drafts.archiveArticle({
        actor: admin,
        articleId: values.articleId,
        expectedPublicStatus: "draft",
        expectedReviewState: "editing",
        expectedWorkingRevisionNumber: 1,
        revisionId: values.revisionId,
        workspaceId: values.workspaceId,
      }),
    creator,
    disableCreator: () =>
      members.changeMemberStatus({
        actor: admin,
        changedAt,
        memberId: values.creatorId,
        status: "disabled",
      }),
    previewRepository,
    revisionId: values.revisionId,
  };
}

function seedSqlite(client: Database.Database, values: ScenarioValues) {
  client.transaction(() => {
    client
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, ?, 'Preview race', ?, ?)`,
      )
      .run(values.workspaceId, values.workspaceId, issuedAt.getTime(), issuedAt.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, ?, 'Race Admin', 'administrator', 'active', ?, ?, 600000, ?, ?)`,
      )
      .run(
        values.adminId,
        values.workspaceId,
        `${values.adminId}@example.invalid`,
        id43("S"),
        id43("D"),
        issuedAt.getTime(),
        issuedAt.getTime(),
      );
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, ?, 'Race Creator', 'editor', 'active', ?, ?, 600000, ?, ?, ?)`,
      )
      .run(
        values.creatorId,
        values.workspaceId,
        `${values.creatorId}@example.invalid`,
        id43("T"),
        id43("E"),
        values.adminId,
        issuedAt.getTime(),
        issuedAt.getTime(),
      );
    client
      .prepare(
        `insert into admin_sessions (
           id, workspace_id, member_id, created_at, expires_at
         ) values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        values.adminSessionId,
        values.workspaceId,
        values.adminId,
        issuedAt.getTime(),
        issuedAt.getTime() + 8 * 60 * 60 * 1_000,
        values.creatorSessionId,
        values.workspaceId,
        values.creatorId,
        issuedAt.getTime(),
        issuedAt.getTime() + 8 * 60 * 60 * 1_000,
      );
    client
      .prepare(
        `insert into categories (
           id, workspace_id, slug, name, position, created_at, updated_at
         ) values (?, ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .run(values.categoryId, values.workspaceId, issuedAt.getTime(), issuedAt.getTime());
    client
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values (?, ?, ?, ?, 'Preview race', '# Preview race', 'draft', 0,
                   'Race Creator', 0, ?, ?)`,
      )
      .run(
        values.articleId,
        values.workspaceId,
        values.categoryId,
        values.slug,
        issuedAt.getTime(),
        issuedAt.getTime(),
      );
    client
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id,
           category_slug, category_name, slug, title, mdx, is_faq, author_name,
           position, revision_hash, change_kind, created_by_member_id, created_at
         ) values (?, ?, ?, 1, ?, 'guides', 'Guides', ?, 'Preview race', ?, 0,
                   'Race Creator', 0, ?, 'manual', ?, ?)`,
      )
      .run(
        values.revisionId,
        values.workspaceId,
        values.articleId,
        values.categoryId,
        values.slug,
        `# Preview race\n\n![Stored](/api/assets/${assetHash})`,
        "e".repeat(64),
        values.creatorId,
        issuedAt.getTime(),
      );
    client
      .prepare(
        `insert into article_slug_claims (
           workspace_id, normalized_slug, article_id, working_claim, article_row_claim
         ) values (?, ?, ?, 1, 1)`,
      )
      .run(values.workspaceId, values.slug, values.articleId);
    client
      .prepare(
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, review_state
         ) values (?, ?, ?, 1, ?, 'editing')`,
      )
      .run(values.articleId, values.workspaceId, values.revisionId, values.slug);
    client
      .prepare(
        `insert into assets (
           id, workspace_id, hash, media_type, byte_size, content, created_at
         ) values (?, ?, ?, 'image/png', 8, ?, ?)`,
      )
      .run(
        values.assetId,
        values.workspaceId,
        assetHash,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        issuedAt.getTime(),
      );
    client
      .prepare(
        `insert into article_revision_assets (
           workspace_id, article_id, revision_id, revision_number, asset_id
         ) values (?, ?, ?, 1, ?)`,
      )
      .run(values.workspaceId, values.articleId, values.revisionId, values.assetId);
  })();
}

async function createSqliteHarness(): Promise<RaceHarness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, { migrationsFolder: migrations.sqlite });
  for (const statement of sqliteTeamAuthoringGuardStatements) {
    client.exec(statement);
  }
  return {
    async close() {
      client.close();
    },
    async scenario(index) {
      const values = scenarioValues(index);
      seedSqlite(client, values);
      return raceScenario(
        values,
        createSqliteArticleDraftRepository(database, {
          clock: () => changedAt,
          createReviewEventId: () => values.eventId,
        }),
        createSqliteMemberRepository(database),
        createSqliteArticlePreviewRepository(database),
      );
    },
  };
}

async function seedPostgres(pool: Pool, values: ScenarioValues) {
  const connection = await pool.connect();
  try {
    await connection.query("begin");
    await connection.query(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values ($1, $2, 'Preview race', $3, $3)`,
      [values.workspaceId, values.workspaceId, issuedAt],
    );
    await connection.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values
         ($1, $2, $3, 'Race Admin', 'administrator', 'active', $4, $5, 600000, null, $6, $6),
         ($7, $2, $8, 'Race Creator', 'editor', 'active', $9, $10, 600000, $1, $6, $6)`,
      [
        values.adminId,
        values.workspaceId,
        `${values.adminId}@example.invalid`,
        id43("S"),
        id43("D"),
        issuedAt,
        values.creatorId,
        `${values.creatorId}@example.invalid`,
        id43("T"),
        id43("E"),
      ],
    );
    await connection.query(
      `insert into admin_sessions (
         id, workspace_id, member_id, created_at, expires_at
       ) values ($1, $2, $3, $4, $5), ($6, $2, $7, $4, $5)`,
      [
        values.adminSessionId,
        values.workspaceId,
        values.adminId,
        issuedAt,
        new Date(issuedAt.getTime() + 8 * 60 * 60 * 1_000),
        values.creatorSessionId,
        values.creatorId,
      ],
    );
    await connection.query(
      `insert into categories (
         id, workspace_id, slug, name, position, created_at, updated_at
       ) values ($1, $2, 'guides', 'Guides', 0, $3, $3)`,
      [values.categoryId, values.workspaceId, issuedAt],
    );
    await connection.query(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, status, is_faq,
         author_name, position, created_at, updated_at
       ) values ($1, $2, $3, $4, 'Preview race', '# Preview race', 'draft', false,
                 'Race Creator', 0, $5, $5)`,
      [values.articleId, values.workspaceId, values.categoryId, values.slug, issuedAt],
    );
    await connection.query(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id,
         category_slug, category_name, slug, title, mdx, is_faq, author_name,
         position, revision_hash, change_kind, created_by_member_id, created_at
       ) values ($1, $2, $3, 1, $4, 'guides', 'Guides', $5, 'Preview race', $6,
                 false, 'Race Creator', 0, $7, 'manual', $8, $9)`,
      [
        values.revisionId,
        values.workspaceId,
        values.articleId,
        values.categoryId,
        values.slug,
        `# Preview race\n\n![Stored](/api/assets/${assetHash})`,
        "e".repeat(64),
        values.creatorId,
        issuedAt,
      ],
    );
    await connection.query(
      `insert into article_slug_claims (
         workspace_id, normalized_slug, article_id, working_claim, article_row_claim
       ) values ($1, $2, $3, true, true)`,
      [values.workspaceId, values.slug, values.articleId],
    );
    await connection.query(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, review_state
       ) values ($1, $2, $3, 1, $4, 'editing')`,
      [values.articleId, values.workspaceId, values.revisionId, values.slug],
    );
    await connection.query(
      `insert into assets (
         id, workspace_id, hash, media_type, byte_size, content, created_at
       ) values ($1, $2, $3, 'image/png', 8, $4, $5)`,
      [
        values.assetId,
        values.workspaceId,
        assetHash,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        issuedAt,
      ],
    );
    await connection.query(
      `insert into article_revision_assets (
         workspace_id, article_id, revision_id, revision_number, asset_id
       ) values ($1, $2, $3, 1, $4)`,
      [values.workspaceId, values.articleId, values.revisionId, values.assetId],
    );
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

async function createPostgresHarness(): Promise<RaceHarness> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, { migrationsFolder: migrations.postgres });
  for (const statement of postgresTeamAuthoringGuardStatements) {
    await pool.query(statement);
  }
  return {
    async close() {
      await pool.end();
      await container.stop();
    },
    async scenario(index) {
      const values = scenarioValues(index);
      await seedPostgres(pool, values);
      return raceScenario(
        values,
        createPostgresArticleDraftRepository(database, {
          clock: () => changedAt,
          createReviewEventId: () => values.eventId,
        }),
        createPostgresMemberRepository(database),
        createPostgresArticlePreviewRepository(database),
      );
    },
  };
}

async function exerciseRaces(name: string, harness: RaceHarness) {
  const cases = [
    ["archive", "page"],
    ["archive", "asset"],
    ["disable", "page"],
    ["disable", "asset"],
  ] as const;
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const [invalidation, read] = cases[index] as (typeof cases)[number];
      await runRace(
        await harness.scenario(index),
        invalidation,
        read,
        index * 32,
      );
    }
  } catch (error) {
    throw new Error(
      `${name} preview race failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    await harness.close();
  }
}

test(
  "SQLite commits archive and disable before any later page or asset response",
  async () => exerciseRaces("SQLite", await createSqliteHarness()),
);

test(
  "Postgres commits archive and disable before any later page or asset response",
  { timeout: 120_000 },
  async () => exerciseRaces("Postgres", await createPostgresHarness()),
);
