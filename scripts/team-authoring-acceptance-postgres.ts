// ABOUTME: Opens the team-authoring acceptance boundary against disposable Postgres or Neon databases.
// ABOUTME: Uses the production repositories while limiting fixture setup to one absent workspace transaction.

import { randomBytes, randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import { drizzle as createNeonDatabase } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPostgresMemberRepository } from "@/db/postgres/member-repository";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { createPostgresArticlePreviewRepository } from "@/db/postgres/article-preview-repository";
import * as schema from "@/db/schema/postgres";
import type {
  TeamAuthoringAcceptanceActors,
  TeamAuthoringAcceptanceBoundary,
  TeamAuthoringEvidenceRow,
  TeamAuthoringIndexRow,
  TeamAuthoringPublicProjection,
} from "@/evaluation/team-authoring-acceptance";
import {
  teamAuthoringAcceptanceManifestId,
} from "@/evaluation/team-authoring-acceptance";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";

type QueryRow = Record<string, unknown>;
type Query = (text: string, values?: readonly unknown[]) => Promise<QueryRow[]>;
type Statement = Readonly<{ text: string; values: readonly unknown[] }>;
type PostgresAcceptanceDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

export type OpenPostgresAcceptanceBoundary = Readonly<{
  boundary: TeamAuthoringAcceptanceBoundary;
  close(): Promise<void>;
}>;

function sessionId() {
  return randomBytes(32).toString("base64url");
}

function acceptanceActors(): TeamAuthoringAcceptanceActors {
  const byRole = Object.fromEntries(
    teamAuthoringStandard.members.map((member) => [
      member.role,
      {
        memberId: member.id,
        sessionId: sessionId(),
        workspaceId: teamAuthoringStandard.workspaceId,
      },
    ]),
  ) as Record<keyof TeamAuthoringAcceptanceActors, TeamAuthoringAcceptanceActors["editor"]>;
  if (!byRole.administrator || !byRole.editor || !byRole.reviewer) {
    throw new Error("ACCEPTANCE_FIXTURE_MEMBERS_INVALID");
  }
  return byRole as TeamAuthoringAcceptanceActors;
}

function foundationStatements(actors: TeamAuthoringAcceptanceActors, now: Date): Statement[] {
  const expiry = new Date(now.getTime() + 7 * 60 * 60 * 1_000);
  const manifestExpiry = new Date(now.getTime() + 60 * 60 * 1_000);
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
    {
      text: `insert into workspaces (id, slug, name, created_at, updated_at)
             values ($1, 'team-authoring-standard', 'Team authoring acceptance', $2, $2)`,
      values: [teamAuthoringStandard.workspaceId, now],
    },
    {
      text: `insert into workspace_members (
               id, workspace_id, normalized_email, display_name, role, status,
               password_salt, password_digest, password_iterations,
               created_by_member_id, created_at, updated_at
             ) values
               ($1, $2, $3, $4, 'administrator', 'active', $5, $6, 600000, null, $7, $7),
               ($8, $2, $9, $10, 'editor', 'active', $11, $12, 600000, $1, $7, $7),
               ($13, $2, $14, $15, 'reviewer', 'active', $16, $17, 600000, $1, $7, $7)`,
      values: [
        administrator.id,
        teamAuthoringStandard.workspaceId,
        administrator.email,
        administrator.displayName,
        "A".repeat(43),
        "B".repeat(43),
        now,
        editor.id,
        editor.email,
        editor.displayName,
        "C".repeat(43),
        "D".repeat(43),
        reviewer.id,
        reviewer.email,
        reviewer.displayName,
        "E".repeat(43),
        "F".repeat(43),
      ],
    },
    {
      text: `insert into admin_sessions (
               id, workspace_id, member_id, created_at, expires_at
             ) values ($1, $2, $3, $4, $5), ($6, $2, $7, $4, $5), ($8, $2, $9, $4, $5)`,
      values: [
        actors.administrator.sessionId,
        teamAuthoringStandard.workspaceId,
        actors.administrator.memberId,
        now,
        expiry,
        actors.editor.sessionId,
        actors.editor.memberId,
        actors.reviewer.sessionId,
        actors.reviewer.memberId,
      ],
    },
    {
      text: `insert into categories (
               id, workspace_id, slug, name, description, position, version, created_at, updated_at
             ) values ($1, $2, $3, $4, null, 0, 1, $5, $5),
                      ($6, $2, $7, $8, null, 1, 1, $5, $5)`,
      values: [
        firstCategory.id,
        teamAuthoringStandard.workspaceId,
        firstCategory.slug,
        firstCategory.name,
        now,
        secondCategory.id,
        secondCategory.slug,
        secondCategory.name,
      ],
    },
    {
      text: `insert into assets (
               id, workspace_id, hash, media_type, byte_size, content, created_at
             ) values
               ('asset_team_authoring_first', $1, $2, $3, 8, decode('89504e470d0a1a0a', 'hex'), $4),
               ('asset_team_authoring_second', $1, $5, $6, 12, decode('524946460400000057454250', 'hex'), $4)`,
      values: [
        teamAuthoringStandard.workspaceId,
        firstAsset.hash,
        firstAsset.mediaType,
        now,
        secondAsset.hash,
        secondAsset.mediaType,
      ],
    },
    {
      text: `insert into asset_manifests (id, workspace_id, expires_at, created_at)
             values ($1, $2, $3, $4)`,
      values: [
        teamAuthoringAcceptanceManifestId,
        teamAuthoringStandard.workspaceId,
        manifestExpiry,
        now,
      ],
    },
    {
      text: `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
             values ($1, 'asset_team_authoring_first', $2, $3),
                    ($1, 'asset_team_authoring_second', $2, $3)`,
      values: [teamAuthoringAcceptanceManifestId, teamAuthoringStandard.workspaceId, now],
    },
    {
      text: `insert into workspace_index_states (workspace_id, generation, updated_at)
             values ($1, 0, $2)`,
      values: [teamAuthoringStandard.workspaceId, now],
    },
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
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
}

function headingPath(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("ACCEPTANCE_EVIDENCE_HEADING_PATH_INVALID");
  }
  return value as readonly string[];
}

function evidenceRow(row: QueryRow): TeamAuthoringEvidenceRow {
  const publicationState = textValue(
    row.publicationState,
    "ACCEPTANCE_EVIDENCE_PUBLICATION_STATE_INVALID",
  );
  if (publicationState !== "published") {
    throw new Error("ACCEPTANCE_EVIDENCE_PUBLICATION_STATE_INVALID");
  }
  return Object.freeze({
    articleContentHash: textValue(row.articleContentHash, "ACCEPTANCE_EVIDENCE_INVALID"),
    articleId: textValue(row.articleId, "ACCEPTANCE_EVIDENCE_INVALID"),
    canonicalUrl: textValue(row.canonicalUrl, "ACCEPTANCE_EVIDENCE_INVALID"),
    contentHash: textValue(row.contentHash, "ACCEPTANCE_EVIDENCE_INVALID"),
    createdAt: isoTimestamp(row.createdAt, "ACCEPTANCE_EVIDENCE_TIME_INVALID"),
    embeddingInputHash: textValue(row.embeddingInputHash, "ACCEPTANCE_EVIDENCE_INVALID"),
    embeddingText: textValue(row.embeddingText, "ACCEPTANCE_EVIDENCE_INVALID"),
    evidenceText: textValue(row.evidenceText, "ACCEPTANCE_EVIDENCE_INVALID"),
    headingPath: headingPath(row.headingPath),
    id: textValue(row.id, "ACCEPTANCE_EVIDENCE_INVALID"),
    indexGeneration: integer(row.indexGeneration, "ACCEPTANCE_EVIDENCE_INVALID"),
    markdown: textValue(row.markdown, "ACCEPTANCE_EVIDENCE_INVALID"),
    ordinal: integer(row.ordinal, "ACCEPTANCE_EVIDENCE_INVALID"),
    publicationState,
    sourceLineEnd: integer(row.sourceLineEnd, "ACCEPTANCE_EVIDENCE_INVALID"),
    sourceLineStart: integer(row.sourceLineStart, "ACCEPTANCE_EVIDENCE_INVALID"),
    title: textValue(row.title, "ACCEPTANCE_EVIDENCE_INVALID"),
    updatedAt: isoTimestamp(row.updatedAt, "ACCEPTANCE_EVIDENCE_TIME_INVALID"),
    workspaceId: textValue(row.workspaceId, "ACCEPTANCE_EVIDENCE_INVALID"),
  });
}

function indexRow(row: QueryRow): TeamAuthoringIndexRow {
  const activeEmbeddingGenerationId = row.activeEmbeddingGenerationId;
  if (
    activeEmbeddingGenerationId !== null &&
    typeof activeEmbeddingGenerationId !== "string"
  ) {
    throw new Error("ACCEPTANCE_INDEX_STATE_INVALID");
  }
  return Object.freeze({
    activeEmbeddingGenerationId,
    generation: integer(row.generation, "ACCEPTANCE_INDEX_STATE_INVALID"),
    updatedAt: isoTimestamp(row.updatedAt, "ACCEPTANCE_INDEX_STATE_TIME_INVALID"),
    workspaceId: textValue(row.workspaceId, "ACCEPTANCE_INDEX_STATE_INVALID"),
  });
}

function createBoundary(
  database: PostgresAcceptanceDatabase,
  query: Query,
  transact: (statements: readonly Statement[]) => Promise<void>,
  databaseName: string,
  origin: string,
): TeamAuthoringAcceptanceBoundary {
  const actors = acceptanceActors();
  const repositoryOptions = {
    configuredSiteUrl: origin,
    createEvidenceId: () => `evidence_${randomUUID()}`,
    createReviewEventId: () => `review_event_${randomUUID()}`,
    createRevisionId: () => `revision_${randomUUID()}`,
  };
  return Object.freeze({
    actors,
    drafts: createPostgresArticleDraftRepository(database, repositoryOptions),
    members: createPostgresMemberRepository(database),
    previews: createPostgresArticlePreviewRepository(database),
    async prepareFixture() {
      const identity = await query("select current_database() as name");
      if (identity[0]?.name !== databaseName) {
        throw new Error("ACCEPTANCE_DATABASE_IDENTITY_CHANGED");
      }
      const installation = await query(
        "select to_regclass('article_revisions') as revisions, to_regclass('article_preview_grants') as previews",
      );
      if (!installation[0]?.revisions || !installation[0]?.previews) {
        throw new Error("ACCEPTANCE_SCHEMA_NOT_PREPARED");
      }
      const existing = await query(
        "select id from workspaces where id = $1 or slug = 'team-authoring-standard' limit 1",
        [teamAuthoringStandard.workspaceId],
      );
      if (existing.length !== 0) throw new Error("ACCEPTANCE_FIXTURE_ALREADY_PRESENT");
      await transact(foundationStatements(actors, new Date()));
    },
    async readPublicProjection(articleId) {
      const articles = await query(
        `select content_hash as "contentHash", mdx, slug, status, title
         from articles
         where workspace_id = $1 and id = $2 and status = 'published'`,
        [teamAuthoringStandard.workspaceId, articleId],
      );
      const article = articles[0];
      if (!article) return null;
      if (
        typeof article.contentHash !== "string" ||
        typeof article.mdx !== "string" ||
        typeof article.slug !== "string" ||
        article.status !== "published" ||
        typeof article.title !== "string"
      ) {
        throw new Error("ACCEPTANCE_PUBLIC_PROJECTION_INVALID");
      }
      const [assets, evidence, index] = await Promise.all([
        query(
          `select asset.hash
           from article_assets article_asset
           inner join assets asset on asset.id = article_asset.asset_id
           where article_asset.workspace_id = $1 and article_asset.article_id = $2
           order by asset.hash`,
          [teamAuthoringStandard.workspaceId, articleId],
        ),
        query(
          "select count(*)::integer as count from evidence_chunks where workspace_id = $1 and article_id = $2",
          [teamAuthoringStandard.workspaceId, articleId],
        ),
        query(
          "select generation from workspace_index_states where workspace_id = $1",
          [teamAuthoringStandard.workspaceId],
        ),
      ]);
      return Object.freeze({
        article: {
          contentHash: article.contentHash,
          mdx: article.mdx,
          slug: article.slug,
          status: "published" as const,
          title: article.title,
        },
        assetHashes: assets.map(({ hash }) => String(hash)),
        evidenceCount: integer(evidence[0]?.count, "ACCEPTANCE_EVIDENCE_COUNT_INVALID"),
        indexGeneration: integer(
          index[0]?.generation,
          "ACCEPTANCE_INDEX_GENERATION_INVALID",
        ),
      }) satisfies TeamAuthoringPublicProjection;
    },
    async readPublicRagProjection(articleId) {
      const [evidence, index] = await Promise.all([
        query(
          `select id,
                  workspace_id as "workspaceId",
                  article_id as "articleId",
                  article_content_hash as "articleContentHash",
                  content_hash as "contentHash",
                  embedding_input_hash as "embeddingInputHash",
                  index_generation as "indexGeneration",
                  ordinal,
                  title,
                  heading_path as "headingPath",
                  canonical_url as "canonicalUrl",
                  markdown,
                  evidence_text as "evidenceText",
                  embedding_text as "embeddingText",
                  source_line_start as "sourceLineStart",
                  source_line_end as "sourceLineEnd",
                  publication_state as "publicationState",
                  created_at as "createdAt",
                  updated_at as "updatedAt"
           from evidence_chunks
           where workspace_id = $1 and article_id = $2
           order by ordinal, id`,
          [teamAuthoringStandard.workspaceId, articleId],
        ),
        query(
          `select workspace_id as "workspaceId",
                  generation,
                  active_embedding_generation_id as "activeEmbeddingGenerationId",
                  updated_at as "updatedAt"
           from workspace_index_states
           where workspace_id = $1
           order by workspace_id`,
          [teamAuthoringStandard.workspaceId],
        ),
      ]);
      return Object.freeze({
        evidence: Object.freeze(evidence.map(evidenceRow)),
        index: Object.freeze(index.map(indexRow)),
      });
    },
    async readRevisionAssetHashes(articleId, revisionId) {
      const rows = await query(
        `select asset.hash
         from article_revision_assets revision_asset
         inner join assets asset on asset.id = revision_asset.asset_id
         where revision_asset.workspace_id = $1
           and revision_asset.article_id = $2
           and revision_asset.revision_id = $3
         order by asset.hash`,
        [teamAuthoringStandard.workspaceId, articleId, revisionId],
      );
      return rows.map(({ hash }) => String(hash));
    },
    async revisionCount(articleId) {
      const rows = await query(
        "select count(*)::integer as count from article_revisions where workspace_id = $1 and article_id = $2",
        [teamAuthoringStandard.workspaceId, articleId],
      );
      return integer(rows[0]?.count, "ACCEPTANCE_REVISION_COUNT_INVALID");
    },
  });
}

export function openNodePostgresAcceptanceBoundary(
  connectionString: string,
  databaseName: string,
  origin: string,
): OpenPostgresAcceptanceBoundary {
  const pool = new Pool({ connectionString, max: 16 });
  const unexpectedPoolErrors: Error[] = [];
  let closing = false;
  pool.on("error", (error) => {
    if (!closing) unexpectedPoolErrors.push(error);
  });
  const database: NodePgDatabase<typeof schema> = createPostgresDatabase(pool, { schema });
  const query: Query = async (text, values = []) =>
    (await pool.query(text, [...values])).rows as QueryRow[];
  const transact = async (statements: readonly Statement[]) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const statement of statements) {
        await client.query(statement.text, [...statement.values]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return Object.freeze({
    boundary: createBoundary(database, query, transact, databaseName, origin),
    async close() {
      const unexpectedPoolError = unexpectedPoolErrors[0];
      closing = true;
      await pool.end();
      if (unexpectedPoolError) throw unexpectedPoolError;
    },
  });
}

export function openNeonAcceptanceBoundary(
  connectionString: string,
  databaseName: string,
  origin: string,
): OpenPostgresAcceptanceBoundary {
  const sql = neon(connectionString);
  const database: NeonHttpDatabase<typeof schema> = createNeonDatabase(sql, { schema });
  const query: Query = async (text, values = []) =>
    (await sql.query(text, [...values])) as QueryRow[];
  const transact = async (statements: readonly Statement[]) => {
    await sql.transaction((transaction) =>
      statements.map(({ text, values }) => transaction.query(text, [...values])),
    );
  };
  return Object.freeze({
    boundary: createBoundary(database, query, transact, databaseName, origin),
    async close() {},
  });
}
