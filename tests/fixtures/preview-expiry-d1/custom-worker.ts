// ABOUTME: Exercises the preview-expiry operator mutation inside Wrangler's native D1 runtime.
// ABOUTME: Proves the immutable trigger is bypassed once, restored, and enforced afterward.

import { drizzle } from "drizzle-orm/d1";

import { handleArticlePreviewAsset, handleArticlePreviewSession } from "../../../src/auth/article-preview-http";
import { createSqliteArticlePreviewRepository } from "../../../src/db/sqlite/article-preview-repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";
import * as schema from "../../../src/db/schema/sqlite";
import { articlePreviewCookieName, createArticlePreviewToken } from "../../../src/auth/preview-claims";
import { teamAuthoringStandard } from "../../../src/evaluation/fixtures/team-authoring-standard";
import { expireD1PreviewAcceptanceGrant } from "../../../src/evaluation/preview-acceptance-expiry";

type Environment = Readonly<{ DB: D1Database }>;

const issuedAt = new Date("2026-09-03T12:00:00.000Z");
const expiresAt = new Date("2026-09-10T12:00:00.000Z");
const checkedAt = new Date("2026-09-03T12:05:00.000Z");
const expiredAt = new Date("2026-09-03T12:04:59.000Z");
const workspaceId = teamAuthoringStandard.workspaceId;
const administratorId = "member_team_admin";
const memberId = "member_team_editor";
const articleId = "article_expiry_d1";
const revisionId = "revision_expiry_d1";
const assetId = "asset_expiry_d1";
const assetHash = "a".repeat(64);
const grantId = "A".repeat(43);
const configuration = Object.freeze({
  deploymentId: "preview-expiry-d1.test",
  signingSecret: "preview-expiry-d1-signing-secret-at-least-32-bytes",
});

async function setup(database: D1Database) {
  await database.batch([
    database
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'team-authoring-standard', 'Team authoring acceptance', ?, ?)`,
      )
      .bind(workspaceId, issuedAt.getTime(), issuedAt.getTime()),
    database
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'admin@team-authoring.invalid', 'Avery Admin',
                   'administrator', 'active', ?, ?, 600000, ?, ?)`,
      )
      .bind(
        administratorId,
        workspaceId,
        "A".repeat(43),
        "B".repeat(43),
        issuedAt.getTime(),
        issuedAt.getTime(),
      ),
    database
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@team-authoring.invalid', 'Emery Editor', 'editor',
                   'active', ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        memberId,
        workspaceId,
        "S".repeat(43),
        "D".repeat(43),
        administratorId,
        issuedAt.getTime(),
        issuedAt.getTime(),
      ),
    database
      .prepare(
        `insert into categories (
           id, workspace_id, slug, name, position, created_at, updated_at
         ) values ('category_expiry_d1', ?, 'expiry', 'Expiry', 0, ?, ?)`,
      )
      .bind(workspaceId, issuedAt.getTime(), issuedAt.getTime()),
    database
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values (?, ?, 'category_expiry_d1', 'expiry-d1', 'Expiry D1',
                   '# Expiry D1', 'draft', 0, 'Emery Editor', 0, ?, ?)`,
      )
      .bind(articleId, workspaceId, issuedAt.getTime(), issuedAt.getTime()),
    database
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id,
           category_slug, category_name, slug, title, mdx, is_faq, author_name,
           position, revision_hash, change_kind, created_by_member_id, created_at
         ) values (?, ?, ?, 1, 'category_expiry_d1', 'expiry', 'Expiry',
                   'expiry-d1', 'Expiry D1', ?, 0, 'Emery Editor', 0, ?,
                   'manual', ?, ?)`,
      )
      .bind(
        revisionId,
        workspaceId,
        articleId,
        `# Expiry D1\n\n![Stored](/api/assets/${assetHash})`,
        "e".repeat(64),
        memberId,
        issuedAt.getTime(),
      ),
    database
      .prepare(
        `insert into article_slug_claims (
           workspace_id, normalized_slug, article_id, working_claim, article_row_claim
         ) values (?, 'expiry-d1', ?, 1, 1)`,
      )
      .bind(workspaceId, articleId),
    database
      .prepare(
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, review_state
         ) values (?, ?, ?, 1, 'expiry-d1', 'editing')`,
      )
      .bind(articleId, workspaceId, revisionId),
    database
      .prepare(
        `insert into assets (
           id, workspace_id, hash, media_type, byte_size, content, created_at
         ) values (?, ?, ?, 'image/png', 8, ?, ?)`,
      )
      .bind(
        assetId,
        workspaceId,
        assetHash,
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        issuedAt.getTime(),
      ),
    database
      .prepare(
        `insert into article_revision_assets (
           workspace_id, article_id, revision_id, revision_number, asset_id
         ) values (?, ?, ?, 1, ?)`,
      )
      .bind(workspaceId, articleId, revisionId, assetId),
    database
      .prepare(
        `insert into article_preview_grants (
           id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
         ) values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        grantId,
        workspaceId,
        revisionId,
        memberId,
        expiresAt.getTime(),
        issuedAt.getTime(),
      ),
  ]);
  await database.batch(
    sqliteTeamAuthoringGuardStatements.map((statement) =>
      database.prepare(statement),
    ),
  );
}

async function immutableTriggerRejects(database: D1Database) {
  try {
    await database
      .prepare(
        "update article_preview_grants set expires_at = expires_at where id = ?",
      )
      .bind(grantId)
      .run();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes("PREVIEW_GRANT_IMMUTABLE");
  }
}

function previewRequest(origin: string, pathname: string, token: string) {
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

async function exercise(environment: Environment, request: Request) {
  await setup(environment.DB);
  const guardedBefore = await immutableTriggerRejects(environment.DB);
  const signed = await createArticlePreviewToken(
    {
      databaseExpiresAt: expiresAt,
      grantId,
      revisionId,
      workspaceId,
    },
    configuration.signingSecret,
    configuration.deploymentId,
    issuedAt,
  );
  const result = await expireD1PreviewAcceptanceGrant(environment.DB, {
    checkedAt,
    databaseName: "opas_acceptance_expiry_d1_001",
    expiredAt,
    grantId,
    workspaceId,
  });
  const row = await environment.DB
    .prepare(
      "select created_at as createdAt, expires_at as expiresAt from article_preview_grants where id = ?",
    )
    .bind(grantId)
    .first<{ createdAt: number; expiresAt: number }>();
  const guardedAfter = await immutableTriggerRejects(environment.DB);
  const repository = createSqliteArticlePreviewRepository(
    drizzle(environment.DB, { schema }),
  );
  const runtime = {
    clock: () => checkedAt,
    configuration,
    repository,
    siteOrigin: new URL(request.url).origin,
  };
  const session = await handleArticlePreviewSession(
    previewRequest(runtime.siteOrigin, "/preview/session", signed.token),
    runtime,
  );
  const asset = await handleArticlePreviewAsset(
    previewRequest(
      runtime.siteOrigin,
      `/preview/assets/${assetHash}`,
      signed.token,
    ),
    assetHash,
    runtime,
  );
  const trigger = await environment.DB
    .prepare(
      "select count(*) as count from sqlite_schema where type = 'trigger' and name = ?",
    )
    .bind("article_preview_grants_revocation_update_trigger")
    .first<number>("count");
  return Response.json({
    assetStatus: asset.status,
    createdAt: row?.createdAt,
    expiredAt: row?.expiresAt,
    guardedAfter,
    guardedBefore,
    result,
    sessionStatus: session.status,
    triggerCount: trigger,
  });
}

const worker = {
  async fetch(request: Request, environment: Environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/exercise" && request.method === "POST") {
      try {
        return await exercise(environment, request);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};

export default worker;
