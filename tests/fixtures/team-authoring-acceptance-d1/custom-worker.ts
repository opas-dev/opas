// ABOUTME: Runs the frozen team-authoring scenario in local workerd against one remote disposable D1 binding.
// ABOUTME: Exposes only a bounded one-shot report and never returns the supplied preview signing secret.

import { drizzle } from "drizzle-orm/d1";

import { runEmbeddingWorkerBatch } from "../../../src/ai/embedding-runner";
import type { WorkersAiEmbeddingBinding } from "../../../src/ai/embeddings";
import { createSqliteMemberRepository } from "../../../src/db/sqlite/member-repository";
import { createSqliteArticleDraftRepository } from "../../../src/db/sqlite/article-draft-repository";
import { createSqliteArticlePreviewRepository } from "../../../src/db/sqlite/article-preview-repository";
import { createSqliteRepository } from "../../../src/db/sqlite/repository";
import * as schema from "../../../src/db/schema/sqlite";
import {
  runTeamAuthoringAcceptance,
  teamAuthoringAcceptanceManifestId,
  type TeamAuthoringAcceptanceActors,
  type TeamAuthoringAcceptanceBoundary,
  type TeamAuthoringEvidenceRow,
  type TeamAuthoringIndexRow,
  type TeamAuthoringPublicProjection,
} from "../../../src/evaluation/team-authoring-acceptance";
import { teamAuthoringStandard } from "../../../src/evaluation/fixtures/team-authoring-standard";
import {
  teamAuthoringBackfillProjectionHash,
  teamAuthoringBackfillVersion,
} from "../../../src/db/team-authoring-backfill";

type Environment = Readonly<{
  AI: WorkersAiEmbeddingBinding;
  DB: D1Database;
}>;
type RunRequest = Readonly<{
  origin: string;
  previewSecret: string;
  runId: string;
}>;

const cloudflareWorkersDomain = ["timo-bejan", "workers", "dev"].join(".");

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function actors(): TeamAuthoringAcceptanceActors {
  const result = Object.fromEntries(
    teamAuthoringStandard.members.map((member) => [
      member.role,
      {
        memberId: member.id,
        sessionId: randomId(),
        workspaceId: teamAuthoringStandard.workspaceId,
      },
    ]),
  ) as Record<keyof TeamAuthoringAcceptanceActors, TeamAuthoringAcceptanceActors["editor"]>;
  if (!result.administrator || !result.editor || !result.reviewer) {
    throw new Error("ACCEPTANCE_FIXTURE_MEMBERS_INVALID");
  }
  return result as TeamAuthoringAcceptanceActors;
}

function foundationStatements(
  environment: Environment,
  acceptanceActors: TeamAuthoringAcceptanceActors,
  now: number,
  migrationProjectionHash: string,
) {
  const expiry = now + 7 * 60 * 60 * 1_000;
  const manifestExpiry = now + 60 * 60 * 1_000;
  const [administrator, editor, reviewer] = teamAuthoringStandard.members;
  const [firstCategory, secondCategory] = teamAuthoringStandard.categories;
  const [firstAsset, secondAsset] = teamAuthoringStandard.assets;
  if (
    !administrator ||
    !editor ||
    !reviewer ||
    !firstCategory ||
    !secondCategory ||
    !firstAsset ||
    !secondAsset
  ) {
    throw new Error("ACCEPTANCE_FIXTURE_INVALID");
  }
  return [
    environment.DB.prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values (?, 'team-authoring-standard', 'Team authoring acceptance', ?, ?)`,
    ).bind(teamAuthoringStandard.workspaceId, now, now),
    environment.DB.prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values
         (?, ?, ?, ?, 'administrator', 'active', ?, ?, 600000, null, ?, ?),
         (?, ?, ?, ?, 'editor', 'active', ?, ?, 600000, ?, ?, ?),
         (?, ?, ?, ?, 'reviewer', 'active', ?, ?, 600000, ?, ?, ?)`,
    ).bind(
      administrator.id,
      teamAuthoringStandard.workspaceId,
      administrator.email,
      administrator.displayName,
      "A".repeat(43),
      "B".repeat(43),
      now,
      now,
      editor.id,
      teamAuthoringStandard.workspaceId,
      editor.email,
      editor.displayName,
      "C".repeat(43),
      "D".repeat(43),
      administrator.id,
      now,
      now,
      reviewer.id,
      teamAuthoringStandard.workspaceId,
      reviewer.email,
      reviewer.displayName,
      "E".repeat(43),
      "F".repeat(43),
      administrator.id,
      now,
      now,
    ),
    environment.DB.prepare(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).bind(
      acceptanceActors.administrator.sessionId,
      teamAuthoringStandard.workspaceId,
      acceptanceActors.administrator.memberId,
      now,
      expiry,
      acceptanceActors.editor.sessionId,
      teamAuthoringStandard.workspaceId,
      acceptanceActors.editor.memberId,
      now,
      expiry,
      acceptanceActors.reviewer.sessionId,
      teamAuthoringStandard.workspaceId,
      acceptanceActors.reviewer.memberId,
      now,
      expiry,
    ),
    environment.DB.prepare(
      `insert into categories (
         id, workspace_id, slug, name, description, position, version, created_at, updated_at
       ) values (?, ?, ?, ?, null, 0, 1, ?, ?), (?, ?, ?, ?, null, 1, 1, ?, ?)`,
    ).bind(
      firstCategory.id,
      teamAuthoringStandard.workspaceId,
      firstCategory.slug,
      firstCategory.name,
      now,
      now,
      secondCategory.id,
      teamAuthoringStandard.workspaceId,
      secondCategory.slug,
      secondCategory.name,
      now,
      now,
    ),
    environment.DB.prepare(
      `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
       values (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "asset_team_authoring_first",
      teamAuthoringStandard.workspaceId,
      firstAsset.hash,
      firstAsset.mediaType,
      8,
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      now,
      "asset_team_authoring_second",
      teamAuthoringStandard.workspaceId,
      secondAsset.hash,
      secondAsset.mediaType,
      12,
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      now,
    ),
    environment.DB.prepare(
      `insert into asset_manifests (id, workspace_id, expires_at, created_at)
       values (?, ?, ?, ?)`,
    ).bind(
      teamAuthoringAcceptanceManifestId,
      teamAuthoringStandard.workspaceId,
      manifestExpiry,
      now,
    ),
    environment.DB.prepare(
      `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
       values (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).bind(
      teamAuthoringAcceptanceManifestId,
      "asset_team_authoring_first",
      teamAuthoringStandard.workspaceId,
      now,
      teamAuthoringAcceptanceManifestId,
      "asset_team_authoring_second",
      teamAuthoringStandard.workspaceId,
      now,
    ),
    environment.DB.prepare(
      `insert into workspace_index_states (workspace_id, generation, updated_at)
       values (?, 0, ?)`,
    ).bind(teamAuthoringStandard.workspaceId, now),
    environment.DB.prepare(
      `insert into workspace_authoring_migrations (
         workspace_id, version, article_count, projection_hash, completed_at
       ) values (?, ?, 0, ?, ?)`,
    ).bind(
      teamAuthoringStandard.workspaceId,
      teamAuthoringBackfillVersion,
      migrationProjectionHash,
      now,
    ),
  ];
}

function integer(value: unknown, code: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function textValue(value: unknown, code: string) {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function isoTimestamp(value: unknown, code: string) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
}

function headingPath(value: unknown) {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("ACCEPTANCE_EVIDENCE_HEADING_PATH_INVALID");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("ACCEPTANCE_EVIDENCE_HEADING_PATH_INVALID");
  }
  return parsed as readonly string[];
}

function evidenceRow(row: Record<string, unknown>): TeamAuthoringEvidenceRow {
  const publicationState = textValue(
    row.publication_state,
    "ACCEPTANCE_EVIDENCE_PUBLICATION_STATE_INVALID",
  );
  if (publicationState !== "published") {
    throw new Error("ACCEPTANCE_EVIDENCE_PUBLICATION_STATE_INVALID");
  }
  return Object.freeze({
    articleContentHash: textValue(row.article_content_hash, "ACCEPTANCE_EVIDENCE_INVALID"),
    articleId: textValue(row.article_id, "ACCEPTANCE_EVIDENCE_INVALID"),
    canonicalUrl: textValue(row.canonical_url, "ACCEPTANCE_EVIDENCE_INVALID"),
    contentHash: textValue(row.content_hash, "ACCEPTANCE_EVIDENCE_INVALID"),
    createdAt: isoTimestamp(row.created_at, "ACCEPTANCE_EVIDENCE_TIME_INVALID"),
    embeddingInputHash: textValue(row.embedding_input_hash, "ACCEPTANCE_EVIDENCE_INVALID"),
    embeddingText: textValue(row.embedding_text, "ACCEPTANCE_EVIDENCE_INVALID"),
    evidenceText: textValue(row.evidence_text, "ACCEPTANCE_EVIDENCE_INVALID"),
    headingPath: headingPath(row.heading_path),
    id: textValue(row.id, "ACCEPTANCE_EVIDENCE_INVALID"),
    indexGeneration: integer(row.index_generation, "ACCEPTANCE_EVIDENCE_INVALID"),
    markdown: textValue(row.markdown, "ACCEPTANCE_EVIDENCE_INVALID"),
    ordinal: integer(row.ordinal, "ACCEPTANCE_EVIDENCE_INVALID"),
    publicationState,
    sourceLineEnd: integer(row.source_line_end, "ACCEPTANCE_EVIDENCE_INVALID"),
    sourceLineStart: integer(row.source_line_start, "ACCEPTANCE_EVIDENCE_INVALID"),
    title: textValue(row.title, "ACCEPTANCE_EVIDENCE_INVALID"),
    updatedAt: isoTimestamp(row.updated_at, "ACCEPTANCE_EVIDENCE_TIME_INVALID"),
    workspaceId: textValue(row.workspace_id, "ACCEPTANCE_EVIDENCE_INVALID"),
  });
}

function indexRow(row: Record<string, unknown>): TeamAuthoringIndexRow {
  const activeEmbeddingGenerationId = row.active_embedding_generation_id;
  if (
    activeEmbeddingGenerationId !== null &&
    typeof activeEmbeddingGenerationId !== "string"
  ) {
    throw new Error("ACCEPTANCE_INDEX_STATE_INVALID");
  }
  return Object.freeze({
    activeEmbeddingGenerationId,
    generation: integer(row.generation, "ACCEPTANCE_INDEX_STATE_INVALID"),
    updatedAt: isoTimestamp(row.updated_at, "ACCEPTANCE_INDEX_STATE_TIME_INVALID"),
    workspaceId: textValue(row.workspace_id, "ACCEPTANCE_INDEX_STATE_INVALID"),
  });
}

async function publicProjectionSettled(
  environment: Environment,
  articleId: string,
) {
  const ready = await environment.DB.prepare(
    `select (
       article.content_hash is not null
       and state.active_embedding_generation_id is not null
       and exists (
         select 1
         from embedding_jobs as completed_job
         where completed_job.id = (
           select latest_job.id
           from embedding_jobs as latest_job
           where latest_job.workspace_id = article.workspace_id
             and latest_job.article_id = article.id
             and latest_job.article_content_hash = article.content_hash
           order by latest_job.created_at desc, latest_job.id desc
           limit 1
         )
           and completed_job.status = 'completed'
           and completed_job.embedding_generation_id = state.active_embedding_generation_id
       )
       and exists (
         select 1
         from evidence_chunks as current_chunk
         where current_chunk.workspace_id = article.workspace_id
           and current_chunk.article_id = article.id
           and current_chunk.article_content_hash = article.content_hash
       )
       and not exists (
         select 1
         from evidence_chunks as current_chunk
         where current_chunk.workspace_id = article.workspace_id
           and current_chunk.article_id = article.id
           and current_chunk.article_content_hash = article.content_hash
           and not exists (
             select 1
             from chunk_embeddings as stored_embedding
             inner join embedding_generations as active_generation
               on active_generation.id = stored_embedding.embedding_generation_id
              and active_generation.workspace_id = stored_embedding.workspace_id
              and active_generation.status = 'active'
             where stored_embedding.chunk_id = current_chunk.id
               and stored_embedding.workspace_id = current_chunk.workspace_id
               and stored_embedding.embedding_generation_id = state.active_embedding_generation_id
               and stored_embedding.content_hash = current_chunk.content_hash
               and stored_embedding.embedding_input_hash = current_chunk.embedding_input_hash
               and stored_embedding.dimension = active_generation.dimension
           )
       )
     ) as ready
     from articles as article
     inner join workspace_index_states as state
       on state.workspace_id = article.workspace_id
     where article.workspace_id = ? and article.id = ? and article.status = 'published'`,
  )
    .bind(teamAuthoringStandard.workspaceId, articleId)
    .first<number>("ready");
  return ready === 1;
}

function boundary(environment: Environment, origin: string): TeamAuthoringAcceptanceBoundary {
  const acceptanceActors = actors();
  const database = drizzle(environment.DB, { schema });
  const embeddingRepository = createSqliteRepository(database);
  const repositoryOptions = {
    configuredSiteUrl: origin,
    createEvidenceId: () => `evidence_${crypto.randomUUID()}`,
    createReviewEventId: () => `review_event_${crypto.randomUUID()}`,
    createRevisionId: () => `revision_${crypto.randomUUID()}`,
  };
  return Object.freeze({
    actors: acceptanceActors,
    drafts: createSqliteArticleDraftRepository(database, repositoryOptions),
    members: createSqliteMemberRepository(database),
    previews: createSqliteArticlePreviewRepository(database),
    async prepareFixture() {
      const installation = await environment.DB.prepare(
        `select count(*) as count from sqlite_master
         where type = 'table' and name in ('article_revisions', 'article_preview_grants')`,
      ).first<number>("count");
      if (installation !== 2) throw new Error("ACCEPTANCE_SCHEMA_NOT_PREPARED");
      const existing = await environment.DB.prepare(
        "select id from workspaces where id = ? or slug = 'team-authoring-standard' limit 1",
      )
        .bind(teamAuthoringStandard.workspaceId)
        .first();
      if (existing) throw new Error("ACCEPTANCE_FIXTURE_ALREADY_PRESENT");
      const now = Date.now();
      const migrationProjectionHash = await teamAuthoringBackfillProjectionHash(
        teamAuthoringStandard.workspaceId,
        [],
      );
      await environment.DB.batch(
        foundationStatements(
          environment,
          acceptanceActors,
          now,
          migrationProjectionHash,
        ),
      );
    },
    async settlePublicProjection(articleId) {
      await runEmbeddingWorkerBatch({
        environment: {
          OPAS_DATABASE_DRIVER: "d1",
          OPAS_SITE_URL: origin,
        },
        getRepository: async () => embeddingRepository,
        workersAiBinding: environment.AI,
      });
      if (!(await publicProjectionSettled(environment, articleId))) {
        throw new Error("ACCEPTANCE_PUBLIC_RAG_NOT_SETTLED");
      }
    },
    async readPublicProjection(articleId) {
      const article = await environment.DB.prepare(
        `select content_hash, mdx, slug, status, title from articles
         where workspace_id = ? and id = ? and status = 'published'`,
      )
        .bind(teamAuthoringStandard.workspaceId, articleId)
        .first<Record<string, unknown>>();
      if (!article) return null;
      if (
        typeof article.content_hash !== "string" ||
        typeof article.mdx !== "string" ||
        typeof article.slug !== "string" ||
        article.status !== "published" ||
        typeof article.title !== "string"
      ) {
        throw new Error("ACCEPTANCE_PUBLIC_PROJECTION_INVALID");
      }
      const assets = await environment.DB.prepare(
        `select asset.hash
         from article_assets article_asset
         inner join assets asset on asset.id = article_asset.asset_id
         where article_asset.workspace_id = ? and article_asset.article_id = ?
         order by asset.hash`,
      )
        .bind(teamAuthoringStandard.workspaceId, articleId)
        .all<{ hash: string }>();
      const evidence = await environment.DB.prepare(
        "select count(*) as count from evidence_chunks where workspace_id = ? and article_id = ?",
      )
        .bind(teamAuthoringStandard.workspaceId, articleId)
        .first<number>("count");
      const generation = await environment.DB.prepare(
        "select generation from workspace_index_states where workspace_id = ?",
      )
        .bind(teamAuthoringStandard.workspaceId)
        .first<number>("generation");
      return Object.freeze({
        article: {
          contentHash: article.content_hash,
          mdx: article.mdx,
          slug: article.slug,
          status: "published" as const,
          title: article.title,
        },
        assetHashes: assets.results.map(({ hash }) => hash),
        evidenceCount: integer(evidence, "ACCEPTANCE_EVIDENCE_COUNT_INVALID"),
        indexGeneration: integer(generation, "ACCEPTANCE_INDEX_GENERATION_INVALID"),
      }) satisfies TeamAuthoringPublicProjection;
    },
    async readPublicRagProjection(articleId) {
      const [evidence, index] = await Promise.all([
        environment.DB.prepare(
          `select id, workspace_id, article_id, article_content_hash, content_hash,
                  embedding_input_hash, index_generation, ordinal, title, heading_path,
                  canonical_url, markdown, evidence_text, embedding_text,
                  source_line_start, source_line_end, publication_state, created_at, updated_at
           from evidence_chunks
           where workspace_id = ? and article_id = ?
           order by ordinal, id`,
        )
          .bind(teamAuthoringStandard.workspaceId, articleId)
          .all<Record<string, unknown>>(),
        environment.DB.prepare(
          `select workspace_id, generation, active_embedding_generation_id, updated_at
           from workspace_index_states
           where workspace_id = ?
           order by workspace_id`,
        )
          .bind(teamAuthoringStandard.workspaceId)
          .all<Record<string, unknown>>(),
      ]);
      return Object.freeze({
        evidence: Object.freeze(evidence.results.map(evidenceRow)),
        index: Object.freeze(index.results.map(indexRow)),
      });
    },
    async readRevisionAssetHashes(articleId, revisionId) {
      const rows = await environment.DB.prepare(
        `select asset.hash
         from article_revision_assets revision_asset
         inner join assets asset on asset.id = revision_asset.asset_id
         where revision_asset.workspace_id = ? and revision_asset.article_id = ?
           and revision_asset.revision_id = ?
         order by asset.hash`,
      )
        .bind(teamAuthoringStandard.workspaceId, articleId, revisionId)
        .all<{ hash: string }>();
      return rows.results.map(({ hash }) => hash);
    },
    async revisionCount(articleId) {
      const count = await environment.DB.prepare(
        "select count(*) as count from article_revisions where workspace_id = ? and article_id = ?",
      )
        .bind(teamAuthoringStandard.workspaceId, articleId)
        .first<number>("count");
      return integer(count, "ACCEPTANCE_REVISION_COUNT_INVALID");
    },
  });
}

async function requestBody(request: Request): Promise<RunRequest> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length < 1 || length > 4_096) {
    throw new Error("ACCEPTANCE_REQUEST_INVALID");
  }
  const value: unknown = await request.json();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "origin,previewSecret,runId"
  ) {
    throw new Error("ACCEPTANCE_REQUEST_INVALID");
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.origin !== "string" ||
    typeof body.previewSecret !== "string" ||
    new TextEncoder().encode(body.previewSecret).byteLength < 32 ||
    typeof body.runId !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(body.runId)
  ) {
    throw new Error("ACCEPTANCE_REQUEST_INVALID");
  }
  const origin = new URL(body.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== body.origin ||
    origin.hostname !== `opas-acceptance-${body.runId}.${cloudflareWorkersDomain}`
  ) {
    throw new Error("ACCEPTANCE_TARGET_INVALID");
  }
  return {
    origin: body.origin,
    previewSecret: body.previewSecret,
    runId: body.runId,
  };
}

let invoked = false;

export default {
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ready" });
    }
    if (request.method !== "POST" || url.pathname !== "/run" || invoked) {
      return new Response("Not Found\n", { status: 404 });
    }
    invoked = true;
    try {
      const input = await requestBody(request);
      const report = await runTeamAuthoringAcceptance({
        boundary: boundary(environment, input.origin),
        previewConfiguration: {
          deploymentId: new URL(input.origin).hostname,
          signingSecret: input.previewSecret,
        },
        target: {
          kind: "cloudflare-d1",
          origin: input.origin,
          runId: input.runId,
        },
      });
      return Response.json(report, { status: report.outcome === "passed" ? 200 : 422 });
    } catch {
      return Response.json({ error: "ACCEPTANCE_D1_WORKER_FAILED" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Environment>;
