// ABOUTME: Runs signed preview rotation and anonymous reads against a native D1 binding.
// ABOUTME: Reports exact grant, asset, fence, archive, and bearer-storage outcomes.

import { drizzle } from "drizzle-orm/d1";

import {
  issueArticlePreview,
  resolveArticlePreview,
  resolveArticlePreviewAsset,
  revokeArticlePreview,
} from "../../../src/auth/article-preview";
import {
  handleArticlePreviewAsset,
  handleArticlePreviewExchange,
  handleArticlePreviewSession,
} from "../../../src/auth/article-preview-http";
import { createSqliteArticlePreviewRepository } from "../../../src/db/sqlite/article-preview-repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";
import * as schema from "../../../src/db/schema/sqlite";

type Environment = Readonly<{ DB: D1Database }>;

const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_d1_preview";
const administratorId = "member_d1_preview_admin";
const creatorId = "member_d1_preview_editor";
const sessionId = "S".repeat(43);
const articleId = "article_d1_preview";
const revisionId = "revision_d1_preview_4";
const assetId = "asset_d1_preview";
const assetHash = "a".repeat(64);
const configuration = Object.freeze({
  deploymentId: "preview-d1.example.test",
  signingSecret: "d1-preview-signing-secret-with-at-least-32-bytes",
});
const actor = Object.freeze({ memberId: creatorId, sessionId, workspaceId });

function fixedBytes(offset: number) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

async function setup(environment: Environment) {
  const mdx = `# Exact preview\n\n![Stored](/api/assets/${assetHash})\n\n![Remote](https://cdn.example.test/image.png)`;
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'd1-preview', 'D1 preview', ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'admin@preview.test', 'Admin', 'administrator', 'active',
                   ?, ?, 600000, ?, ?)`,
      )
      .bind(
        administratorId,
        workspaceId,
        "A".repeat(43),
        "B".repeat(43),
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@preview.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        creatorId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, workspaceId, creatorId, timestamp, timestamp + 60 * 60 * 1_000),
    environment.DB
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values ('category_d1_preview', ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values (?, ?, 'category_d1_preview', 'exact-preview', 'Exact preview',
                   '# Exact preview', 'draft', 0, 'Editor', 4, ?, ?)`,
      )
      .bind(articleId, workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id,
           category_slug, category_name, slug, title, mdx, is_faq, author_name,
           position, revision_hash, change_kind, created_by_member_id, created_at
         ) values (?, ?, ?, 4, 'category_d1_preview', 'guides', 'Guides',
                   'exact-preview', 'Exact preview', ?, 0, 'Editor', 4, ?,
                   'manual', ?, ?)`,
      )
      .bind(revisionId, workspaceId, articleId, mdx, "e".repeat(64), creatorId, timestamp),
    environment.DB
      .prepare(
        `insert into article_slug_claims (
           workspace_id, normalized_slug, article_id, working_claim, article_row_claim
         ) values (?, 'exact-preview', ?, 1, 1)`,
      )
      .bind(workspaceId, articleId),
    environment.DB
      .prepare(
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, review_state
         ) values (?, ?, ?, 4, 'exact-preview', 'editing')`,
      )
      .bind(articleId, workspaceId, revisionId),
    environment.DB
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
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into article_revision_assets (
           workspace_id, article_id, revision_id, revision_number, asset_id
         ) values (?, ?, ?, 4, ?)`,
      )
      .bind(workspaceId, articleId, revisionId, assetId),
  ]);
  await environment.DB.batch(
    sqliteTeamAuthoringGuardStatements.map((source) => environment.DB.prepare(source)),
  );
}

async function issueAt(
  repository: ReturnType<typeof createSqliteArticlePreviewRepository>,
  issuedAt: Date,
  offset: number,
) {
  return issueArticlePreview(actor, revisionId, configuration, {
    clock: () => issuedAt,
    randomBytes: fixedBytes(offset),
    repository,
  });
}

function httpDependencies(
  environment: Environment,
  request: Request,
) {
  return {
    clock: () => new Date(timestamp + 500),
    configuration,
    repository: createSqliteArticlePreviewRepository(
      drizzle(environment.DB, { schema }),
    ),
    siteOrigin: new URL(request.url).origin,
  };
}

async function createHttpPreview(environment: Environment, request: Request) {
  const repository = createSqliteArticlePreviewRepository(
    drizzle(environment.DB, { schema }),
  );
  const issued = await issueAt(repository, new Date(timestamp), 50);
  if (issued.outcome !== "issued") throw new Error(issued.code);
  const url = new URL("/preview", request.url);
  url.hash = issued.token;
  return Response.json({ url: url.href });
}

async function exercise(environment: Environment) {
  const repository = createSqliteArticlePreviewRepository(
    drizzle(environment.DB, { schema }),
  );
  const first = await issueAt(repository, new Date(timestamp), 1);
  if (first.outcome !== "issued") throw new Error(first.code);
  const collision = await issueAt(repository, new Date(timestamp + 1_000), 1);
  const firstStillValidAfterCollision =
    (await resolveArticlePreview(first.token, configuration, {
      clock: () => new Date(timestamp + 1_500),
      repository,
    })) !== null;
  const rotationTime = new Date(timestamp + 2_000);
  const rotations = await Promise.all([
    issueAt(repository, rotationTime, 2),
    issueAt(repository, rotationTime, 3),
  ]);
  const activeId = await environment.DB
    .prepare(
      `select id from article_preview_grants
       where workspace_id = ? and revoked_at is null`,
    )
    .bind(workspaceId)
    .first<string>("id");
  if (!activeId) throw new Error("ACTIVE_GRANT_MISSING");
  const resolutionResults = await Promise.all(
    rotations.map(async (result) => {
      if (result.outcome !== "issued") return null;
      return {
        asset: await resolveArticlePreviewAsset(
          result.token,
          assetHash,
          configuration,
          { clock: () => new Date(timestamp + 3_000), repository },
        ),
        document: await resolveArticlePreview(result.token, configuration, {
          clock: () => new Date(timestamp + 3_000),
          repository,
        }),
        grantId: result.grantId,
        token: result.token,
      };
    }),
  );
  const valid = resolutionResults.filter(
    (result) => result?.document !== null && result?.document !== undefined,
  );
  const stored = await environment.DB
    .prepare("select * from article_preview_grants order by id")
    .all();
  const concurrentRevocations = await Promise.all([
    revokeArticlePreview(actor, activeId, {
      clock: () => new Date(timestamp + 3_500),
      repository,
    }),
    revokeArticlePreview(actor, activeId, {
      clock: () => new Date(timestamp + 3_500),
      repository,
    }),
  ]);
  const pausedTarget = await issueAt(
    repository,
    new Date(timestamp + 3_750),
    6,
  );
  if (pausedTarget.outcome !== "issued") throw new Error(pausedTarget.code);
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 1, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp + 4_000, workspaceId)
    .run();
  let pausedCode: string | null = null;
  try {
    await issueAt(repository, new Date(timestamp + 4_000), 4);
  } catch (error) {
    pausedCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : String(error);
  }
  const revoked = await revokeArticlePreview(actor, pausedTarget.grantId, {
    clock: () => new Date(timestamp + 5_000),
    repository,
  });
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 0, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp + 6_000, workspaceId)
    .run();
  const archived = await issueAt(repository, new Date(timestamp + 7_000), 5);
  if (archived.outcome !== "issued") throw new Error(archived.code);
  await environment.DB
    .prepare(
      `update article_heads set archived_at = ?, archived_by_member_id = ?
       where workspace_id = ? and article_id = ?`,
    )
    .bind(timestamp + 8_000, administratorId, workspaceId, articleId)
    .run();
  const archivedDocument = await resolveArticlePreview(
    archived.token,
    configuration,
    { clock: () => new Date(timestamp + 9_000), repository },
  );
  const archivedAsset = await resolveArticlePreviewAsset(
    archived.token,
    assetHash,
    configuration,
    { clock: () => new Date(timestamp + 9_000), repository },
  );
  return {
    activeId,
    archivedAsset: archivedAsset !== null,
    archivedDocument: archivedDocument !== null,
    collision,
    concurrentRevocations: concurrentRevocations.map(({ outcome }) => outcome),
    firstStillValidAfterCollision,
    pausedCode,
    resolutionCount: valid.length,
    resolvedAssetHash: valid[0]?.asset?.hash ?? null,
    resolvedMdx: valid[0]?.document?.mdx ?? null,
    revoked,
    rotations: rotations.map(({ outcome }) => outcome),
    storedBearer: rotations.some(
      (result) =>
        result.outcome === "issued" && JSON.stringify(stored).includes(result.token),
    ),
  };
}

export default {
  async fetch(request: Request, environment: Environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ready");
    try {
      if (pathname === "/setup") {
        await setup(environment);
        return Response.json({ setup: true });
      }
      if (pathname === "/http/issue") {
        return createHttpPreview(environment, request);
      }
      if (pathname === "/preview/exchange") {
        return handleArticlePreviewExchange(
          request,
          httpDependencies(environment, request),
        );
      }
      if (pathname === "/preview/session") {
        return handleArticlePreviewSession(
          request,
          httpDependencies(environment, request),
        );
      }
      if (pathname.startsWith("/preview/assets/")) {
        return handleArticlePreviewAsset(
          request,
          pathname.slice("/preview/assets/".length),
          httpDependencies(environment, request),
        );
      }
      if (pathname === "/exercise") return Response.json(await exercise(environment));
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Environment>;
