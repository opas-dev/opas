// ABOUTME: Verifies preview-expiry command refusal and its guarded Postgres fixture mutation.
// ABOUTME: Proves only a run-scoped database can shift one active grant and retain immutability.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import {
  cloudflarePreviewExpiryChildEnvironment,
  parsePreviewAcceptanceExpiryCommand,
  previewExpiryChildFailure,
  runPreviewAcceptanceExpiryCommand,
  validatePreviewAcceptanceExpiryDatabaseTarget,
} from "../scripts/expire-preview-acceptance-grant";

import { createPostgresArticlePreviewRepository } from "@/db/postgres/article-preview-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";

const runId = "expiry-postgres-001";
const databaseName = "opas_acceptance_expiry_postgres_001";
const workspaceId = teamAuthoringStandard.workspaceId;
const administratorId = "member_team_admin";
const memberId = "member_team_editor";
const articleId = "article_expiry_postgres";
const revisionId = "revision_expiry_postgres";
const grantId = "A".repeat(43);
const issuedAt = new Date("2026-09-03T12:00:00.000Z");
const expiresAt = new Date("2026-09-10T12:00:00.000Z");
const checkedAt = new Date("2026-09-03T12:05:00.000Z");
const cloudflareAccountId = "f8801c7e8853a113a25f8b52fd9ceec1";

function commandArgs(target: "cloudflare" | "docker" | "vercel" = "docker") {
  return [
    "--target",
    target,
    "--origin",
    target === "docker"
      ? "http://127.0.0.1:3100"
      : target === "vercel"
        ? `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`
        : `https://opas-acceptance-${runId}.timo-bejan.workers.dev`,
    "--run-id",
    runId,
    "--confirm-disposable",
    runId,
    "--grant-id",
    grantId,
    ...(target === "cloudflare" ? ["--config", "wrangler.jsonc"] : []),
  ];
}

test("preview expiry syntax requires one Cloudflare location and a bounded grant ID", () => {
  assert.deepEqual(parsePreviewAcceptanceExpiryCommand(commandArgs()), {
    confirmation: runId,
    configPath: undefined,
    grantId,
    location: undefined,
    origin: "http://127.0.0.1:3100",
    runId,
    target: "docker",
  });
  assert.throws(
    () =>
      parsePreviewAcceptanceExpiryCommand([
        ...commandArgs(),
        "--local",
      ]),
    /PREVIEW_EXPIRY_LOCATION_INVALID/u,
  );
  assert.throws(
    () => parsePreviewAcceptanceExpiryCommand(commandArgs("cloudflare")),
    /PREVIEW_EXPIRY_LOCATION_INVALID/u,
  );
  assert.throws(
    () =>
      parsePreviewAcceptanceExpiryCommand([
        ...commandArgs().slice(0, -1),
        "short",
      ]),
    /PREVIEW_EXPIRY_GRANT_ID_INVALID/u,
  );
  assert.throws(
    () =>
      parsePreviewAcceptanceExpiryCommand([
        ...commandArgs().slice(0, -1),
        "G".repeat(43),
      ]),
    /PREVIEW_EXPIRY_GRANT_ID_INVALID/u,
  );
});

test("preview expiry refuses maintained hosts and databases outside its run ID", () => {
  const parsed = parsePreviewAcceptanceExpiryCommand(commandArgs());
  assert.throws(
    () =>
      validatePreviewAcceptanceExpiryDatabaseTarget(
        { ...parsed, origin: `https://${["demo", "opas", "dev"].join(".")}` },
        {
          DATABASE_URL:
            "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_expiry_postgres_001",
        },
      ),
    /ACCEPTANCE_MAINTAINED_TARGET_FORBIDDEN/u,
  );
  assert.throws(
    () =>
      validatePreviewAcceptanceExpiryDatabaseTarget(parsed, {
        DATABASE_URL:
          "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_unrelated",
      }),
    /ACCEPTANCE_DATABASE_NOT_DISPOSABLE/u,
  );
});

test("Cloudflare preview expiry isolates its child and preserves typed refusals", () => {
  const environment = cloudflarePreviewExpiryChildEnvironment(
    cloudflareAccountId,
    {
      ADMIN_SESSION_SECRET: "must-not-reach-child",
      CLOUDFLARE_API_TOKEN: "cloudflare-credential",
      CODEX_SESSION_ID: "must-not-reach-child",
      HOME: "/tmp/operator-home",
      PATH: "/usr/bin:/bin",
    },
  );
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, cloudflareAccountId);
  assert.equal(environment.CLOUDFLARE_DATA_COMMAND_CHILD, "1");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, "cloudflare-credential");
  assert.equal(environment.ADMIN_SESSION_SECRET, undefined);
  assert.equal(environment.CODEX_SESSION_ID, undefined);
  assert.equal(
    previewExpiryChildFailure(
      'worker diagnostic\n{"code":"PREVIEW_EXPIRY_ACTIVE_GRANT_NOT_FOUND","outcome":"refused"}\n',
    )?.message,
    "PREVIEW_EXPIRY_ACTIVE_GRANT_NOT_FOUND",
  );
  assert.equal(previewExpiryChildFailure("unstructured child failure"), undefined);
});

async function seedPreview(pool: Pool) {
  await pool.query(
    `insert into workspaces (id, slug, name, created_at, updated_at)
     values ($1, 'team-authoring-standard', 'Team authoring acceptance', $2, $2)`,
    [workspaceId, issuedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_at, updated_at
     ) values ($1, $2, 'admin@team-authoring.invalid', 'Avery Admin',
               'administrator', 'active', $3, $4, 600000, $5, $5)`,
    [administratorId, workspaceId, "A".repeat(43), "B".repeat(43), issuedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations,
       created_by_member_id, created_at, updated_at
     ) values ($1, $2, 'editor@team-authoring.invalid', 'Emery Editor', 'editor',
               'active', $3, $4, 600000, $5, $6, $6)`,
    [
      memberId,
      workspaceId,
      "S".repeat(43),
      "D".repeat(43),
      administratorId,
      issuedAt,
    ],
  );
  await pool.query(
    `insert into categories (
       id, workspace_id, slug, name, position, created_at, updated_at
     ) values ('category_expiry_postgres', $1, 'expiry', 'Expiry', 0, $2, $2)`,
    [workspaceId, issuedAt],
  );
  await pool.query(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, status, is_faq,
       author_name, position, created_at, updated_at
     ) values ($1, $2, 'category_expiry_postgres', 'expiry-postgres',
               'Expiry Postgres', '# Expiry Postgres', 'draft', false,
               'Emery Editor', 0, $3, $3)`,
    [articleId, workspaceId, issuedAt],
  );
  await pool.query(
    `insert into article_revisions (
       id, workspace_id, article_id, revision_number, category_id,
       category_slug, category_name, slug, title, mdx, is_faq, author_name,
       position, revision_hash, change_kind, created_by_member_id, created_at
     ) values ($1, $2, $3, 1, 'category_expiry_postgres', 'expiry', 'Expiry',
               'expiry-postgres', 'Expiry Postgres', '# Expiry Postgres', false,
               'Emery Editor', 0, $4, 'manual', $5, $6)`,
    [revisionId, workspaceId, articleId, "e".repeat(64), memberId, issuedAt],
  );
  await pool.query(
    `insert into article_slug_claims (
       workspace_id, normalized_slug, article_id, working_claim, article_row_claim
     ) values ($1, 'expiry-postgres', $2, true, true)`,
    [workspaceId, articleId],
  );
  await pool.query(
    `insert into article_heads (
       article_id, workspace_id, working_revision_id, working_revision_number,
       working_slug, review_state
     ) values ($1, $2, $3, 1, 'expiry-postgres', 'editing')`,
    [articleId, workspaceId, revisionId],
  );
  await pool.query(
    `insert into article_preview_grants (
       id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [grantId, workspaceId, revisionId, memberId, expiresAt, issuedAt],
  );
}

async function immutableTriggerRejects(pool: Pool) {
  try {
    await pool.query(
      "update article_preview_grants set expires_at = expires_at where id = $1",
      [grantId],
    );
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes("PREVIEW_GRANT_IMMUTABLE");
  }
}

test(
  "the Postgres command expires one active acceptance grant and restores its guard",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase(databaseName)
      .start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await migratePostgres(createPostgresDatabase(pool), {
        migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
      });
      await seedPreview(pool);
      for (const statement of postgresTeamAuthoringGuardStatements) {
        await pool.query(statement);
      }
      const repository = createPostgresArticlePreviewRepository(
        createPostgresDatabase(pool, { schema: postgresSchema }),
      );
      assert.ok(
        await repository.findActiveGrant({
          checkedAt,
          grantId,
          revisionId,
          workspaceId,
        }),
      );
      assert.equal(await immutableTriggerRejects(pool), true);

      const result = await runPreviewAcceptanceExpiryCommand(
        commandArgs(),
        { DATABASE_URL: container.getConnectionUri() },
        () => checkedAt,
      );
      assert.deepEqual(result, {
        expiredAt: "2026-09-03T12:04:59.000Z",
        grantId,
        outcome: "expired",
      });

      const stored = await pool.query<{
        created_at: Date;
        expires_at: Date;
      }>(
        "select created_at, expires_at from article_preview_grants where id = $1",
        [grantId],
      );
      assert.equal(stored.rows[0]?.expires_at.toISOString(), result.expiredAt);
      assert.equal(
        stored.rows[0]?.expires_at.getTime() -
          (stored.rows[0]?.created_at.getTime() ?? 0),
        7 * 24 * 60 * 60 * 1_000,
      );
      assert.equal(
        await repository.findActiveGrant({
          checkedAt,
          grantId,
          revisionId,
          workspaceId,
        }),
        null,
      );
      assert.equal(await immutableTriggerRejects(pool), true);
      await assert.rejects(
        runPreviewAcceptanceExpiryCommand(
          commandArgs(),
          { DATABASE_URL: container.getConnectionUri() },
          () => checkedAt,
        ),
        /PREVIEW_EXPIRY_ACTIVE_GRANT_NOT_FOUND/u,
      );
      assert.equal(await immutableTriggerRejects(pool), true);
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);
