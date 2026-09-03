// ABOUTME: Exercises authorized asset mutations through a native D1 repository binding.
// ABOUTME: Reports transaction, fence, identity, cleanup, and revision-retention outcomes.

import { drizzle } from "drizzle-orm/d1";

import { AuthoringPausedError } from "../../../src/db/authoring-controls";
import type { AssetAuthoringRequest } from "../../../src/db/repository";
import * as schema from "../../../src/db/schema/sqlite";
import { createSqliteRepository } from "../../../src/db/sqlite/repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";

type Environment = Readonly<{ DB: D1Database }>;

type Counts = Readonly<{
  assets: number;
  items: number;
  manifests: number;
}>;

type ActorRejection = Readonly<{
  manifestRetained: boolean;
  rejected: number;
  unchanged: boolean;
}>;

const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_d1_assets";
const administratorId = "member_d1_asset_admin";
const editorId = "member_d1_asset_editor";
const disabledEditorId = "member_d1_asset_disabled";
const revokedEditorId = "member_d1_asset_revoked";
const reviewerId = "member_d1_asset_reviewer";
const editorSessionId = "E".repeat(43);
const disabledSessionId = "D".repeat(43);
const revokedSessionId = "X".repeat(43);
const reviewerSessionId = "R".repeat(43);
const articleId = "article_d1_asset_retention";
const revisionId = "revision_d1_asset_retention_1";

function actor(
  memberId: string,
  sessionId: string,
  checkedAt = timestamp + 1_000,
): AssetAuthoringRequest {
  return {
    checkedAt: new Date(checkedAt),
    memberId,
    sessionId,
    workspaceId,
  };
}

function png(marker: number) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    marker,
  ]);
}

async function sha256Hex(content: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    content.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function setup(environment: Environment) {
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'd1-assets', 'D1 assets', ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'admin@assets.test', 'Admin', 'administrator', 'active',
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
         ) values (?, ?, 'editor@assets.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        editorId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'disabled@assets.test', 'Disabled editor', 'editor', 'disabled',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        disabledEditorId,
        workspaceId,
        "E".repeat(43),
        "F".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'revoked@assets.test', 'Revoked editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        revokedEditorId,
        workspaceId,
        "G".repeat(43),
        "H".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'reviewer@assets.test', 'Reviewer', 'reviewer', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        reviewerId,
        workspaceId,
        "I".repeat(43),
        "J".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(
        editorSessionId,
        workspaceId,
        editorId,
        timestamp,
        timestamp + 28_800_000,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(
        disabledSessionId,
        workspaceId,
        disabledEditorId,
        timestamp,
        timestamp + 28_800_000,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (
           id, workspace_id, member_id, created_at, expires_at, revoked_at
         ) values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        revokedSessionId,
        workspaceId,
        revokedEditorId,
        timestamp,
        timestamp + 28_800_000,
        timestamp + 500,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewerSessionId,
        workspaceId,
        reviewerId,
        timestamp,
        timestamp + 28_800_000,
      ),
    environment.DB
      .prepare(
        `insert into categories (
           id, workspace_id, slug, name, position, created_at, updated_at
         ) values ('category_d1_assets', ?, 'assets', 'Assets', 0, ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
  ]);
}

async function counts(environment: Environment): Promise<Counts> {
  const row = await environment.DB.prepare(
    `select
       (select count(*) from assets where workspace_id = ?) as assets,
       (select count(*) from asset_manifests where workspace_id = ?) as manifests,
       (select count(*) from asset_manifest_items where workspace_id = ?) as items`,
  )
    .bind(workspaceId, workspaceId, workspaceId)
    .first<Counts>();
  if (!row) throw new Error("ASSET_COUNTS_MISSING");
  return {
    assets: Number(row.assets),
    items: Number(row.items),
    manifests: Number(row.manifests),
  };
}

async function exists(
  environment: Environment,
  table: "asset_manifests" | "assets",
  id: string,
) {
  const value = await environment.DB.prepare(
    `select count(*) as count from ${table} where id = ? and workspace_id = ?`,
  )
    .bind(id, workspaceId)
    .first<number>("count");
  return Number(value ?? 0) === 1;
}

async function assetIdForHash(environment: Environment, hash: string) {
  const id = await environment.DB.prepare(
    "select id from assets where workspace_id = ? and hash = ?",
  )
    .bind(workspaceId, hash)
    .first<string>("id");
  if (!id) throw new Error("ASSET_ID_MISSING");
  return id;
}

async function captureRejections(
  environment: Environment,
  request: AssetAuthoringRequest,
  manifestId: string,
  marker: number,
): Promise<ActorRejection> {
  const repository = createSqliteRepository(drizzle(environment.DB, { schema }));
  const before = await counts(environment);
  const operations = [
    () =>
      repository.createAuthorizedAssetManifest(
        request,
        new Date(request.checkedAt.getTime() + 60_000),
      ),
    () =>
      repository.stageAuthorizedAsset(request, manifestId, {
        content: png(marker),
        mediaType: "image/png",
      }),
    () => repository.discardAuthorizedAssetManifest(request, manifestId),
    () => repository.cleanupAuthorizedExpiredAssets(request),
  ];
  let rejected = 0;
  for (const operation of operations) {
    try {
      await operation();
    } catch {
      rejected += 1;
    }
  }
  return {
    manifestRetained: await exists(environment, "asset_manifests", manifestId),
    rejected,
    unchanged: JSON.stringify(await counts(environment)) === JSON.stringify(before),
  };
}

async function attachRevisionAsset(
  environment: Environment,
  asset: Readonly<{ hash: string; id: string }>,
) {
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values (?, ?, 'category_d1_assets', 'retained-asset', 'Retained asset',
                   ?, 'draft', 0, 'Editor', 0, ?, ?)`,
      )
      .bind(
        articleId,
        workspaceId,
        `# Retained asset\n\n![Retained](/api/assets/${asset.hash})`,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id,
           category_slug, category_name, slug, title, mdx, is_faq, author_name,
           position, revision_hash, change_kind, created_by_member_id, created_at
         ) values (?, ?, ?, 1, 'category_d1_assets', 'assets', 'Assets',
                   'retained-asset', 'Retained asset', ?, 0, 'Editor', 0, ?,
                   'manual', ?, ?)`,
      )
      .bind(
        revisionId,
        workspaceId,
        articleId,
        `# Retained asset\n\n![Retained](/api/assets/${asset.hash})`,
        "a".repeat(64),
        editorId,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into article_revision_assets (
           workspace_id, article_id, revision_id, revision_number, asset_id
         ) values (?, ?, ?, 1, ?)`,
      )
      .bind(workspaceId, articleId, revisionId, asset.id),
  ]);
  await environment.DB.batch(
    sqliteTeamAuthoringGuardStatements.map((source) =>
      environment.DB.prepare(source),
    ),
  );
}

async function exercise(environment: Environment) {
  const repository = createSqliteRepository(drizzle(environment.DB, { schema }));
  const editor = actor(editorId, editorSessionId);

  const disposableManifest = await repository.createAuthorizedAssetManifest(
    editor,
    new Date(timestamp + 60_000),
  );
  const disposableAsset = await repository.stageAuthorizedAsset(
    editor,
    disposableManifest.id,
    { content: png(1), mediaType: "image/png" },
  );
  const stagedAsset = await repository.getAsset(workspaceId, disposableAsset.hash);
  await repository.discardAuthorizedAssetManifest(editor, disposableManifest.id);

  const beforeInvalidStage = await counts(environment);
  let invalidStageRejected = false;
  try {
    await repository.stageAuthorizedAsset(editor, "manifest_missing", {
      content: png(2),
      mediaType: "image/png",
    });
  } catch {
    invalidStageRejected = true;
  }
  const afterInvalidStage = await counts(environment);
  const invalidAssetHash = await sha256Hex(png(2));
  const invalidAssetStored =
    (await repository.getAsset(workspaceId, invalidAssetHash)) !== null;

  const retentionManifest = await repository.createAuthorizedAssetManifest(
    editor,
    new Date(timestamp + 2_000),
  );
  const retainedAsset = await repository.stageAuthorizedAsset(
    editor,
    retentionManifest.id,
    { content: png(3), mediaType: "image/png" },
  );
  await attachRevisionAsset(environment, {
    hash: retainedAsset.hash,
    id: await assetIdForHash(environment, retainedAsset.hash),
  });

  const orphanManifest = await repository.createAuthorizedAssetManifest(
    editor,
    new Date(timestamp + 2_000),
  );
  const orphanAsset = await repository.stageAuthorizedAsset(editor, orphanManifest.id, {
    content: png(4),
    mediaType: "image/png",
  });
  await repository.cleanupAuthorizedExpiredAssets({
    ...editor,
    checkedAt: new Date(timestamp + 2_001),
  });

  const protectedManifest = await repository.createAuthorizedAssetManifest(
    editor,
    new Date(timestamp + 60_000),
  );
  const beforePause = await counts(environment);
  await environment.DB.prepare(
    `update workspace_authoring_controls
     set writes_paused = 1, generation = generation + 1, changed_at = ?
     where workspace_id = ?`,
  )
    .bind(timestamp + 3_000, workspaceId)
    .run();
  const pausedOperations = [
    () =>
      repository.createAuthorizedAssetManifest(
        editor,
        new Date(timestamp + 60_000),
      ),
    () =>
      repository.stageAuthorizedAsset(editor, protectedManifest.id, {
        content: png(5),
        mediaType: "image/png",
      }),
    () => repository.discardAuthorizedAssetManifest(editor, protectedManifest.id),
    () => repository.cleanupAuthorizedExpiredAssets(editor),
  ];
  const pauseCodes: string[] = [];
  for (const operation of pausedOperations) {
    try {
      await operation();
    } catch (error) {
      pauseCodes.push(
        error instanceof AuthoringPausedError ? error.code : "UNEXPECTED_ERROR",
      );
    }
  }
  const afterPause = await counts(environment);
  await environment.DB.prepare(
    `update workspace_authoring_controls
     set writes_paused = 0, generation = generation + 1, changed_at = ?
     where workspace_id = ?`,
  )
    .bind(timestamp + 3_001, workspaceId)
    .run();

  const disabled = await captureRejections(
    environment,
    actor(disabledEditorId, disabledSessionId),
    protectedManifest.id,
    6,
  );
  const revoked = await captureRejections(
    environment,
    actor(revokedEditorId, revokedSessionId),
    protectedManifest.id,
    7,
  );
  const reviewer = await captureRejections(
    environment,
    actor(reviewerId, reviewerSessionId),
    protectedManifest.id,
    8,
  );

  return {
    cleanupRemovedExpiredManifests:
      !(await exists(environment, "asset_manifests", retentionManifest.id)) &&
      !(await exists(environment, "asset_manifests", orphanManifest.id)),
    cleanupRemovedOrphan:
      (await repository.getAsset(workspaceId, orphanAsset.hash)) === null,
    cleanupRetainedRevisionAsset:
      (await repository.getAsset(workspaceId, retainedAsset.hash)) !== null,
    createdManifest: disposableManifest.workspaceId === workspaceId,
    disabled,
    discardedAsset:
      (await repository.getAsset(workspaceId, disposableAsset.hash)) === null,
    discardedManifest: !(await exists(
      environment,
      "asset_manifests",
      disposableManifest.id,
    )),
    invalidStageRejected,
    invalidStageRolledBack:
      JSON.stringify(afterInvalidStage) === JSON.stringify(beforeInvalidStage) &&
      !invalidAssetStored,
    pauseCodes,
    pausedManifestRetained: await exists(
      environment,
      "asset_manifests",
      protectedManifest.id,
    ),
    pausedUnchanged: JSON.stringify(afterPause) === JSON.stringify(beforePause),
    reviewer,
    revoked,
    stagedAsset: stagedAsset?.hash === disposableAsset.hash,
  };
}

const worker = {
  async fetch(request: Request, environment: Environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/exercise" && request.method === "POST") {
      try {
        await setup(environment);
        return Response.json(await exercise(environment));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.stack ?? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

export default worker;
