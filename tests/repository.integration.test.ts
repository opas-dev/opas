// ABOUTME: Runs one repository contract against migrated Postgres and local SQLite databases.
// ABOUTME: Verifies schema parity, bootstrap-gated revision seeds, constraints, reads, writes, and cascades.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type { MemberActor } from "@/auth/member-repository";
import type { DraftActor, DraftArticleValues } from "@/db/article-drafts";
import type {
  CategoryAuthoringRepository,
  CategoryValues,
} from "@/db/category-authoring";
import { demoContent, demoIds, demoSeededAt } from "@/db/demo";
import { validateArticleEvidence } from "@/db/evidence";
import { createPostgresAnswerInferenceRepository } from "@/db/postgres/answer-inference-repository";
import { createPostgresCategoryAuthoringRepository } from "@/db/postgres/category-authoring-repository";
import { createPostgresRepository } from "@/db/postgres/repository";
import { createPostgresThemeAuthoringRepository } from "@/db/postgres/theme-authoring-repository";
import { seedPostgres } from "@/db/postgres/seed";
import type {
  AnswerInferenceReservation,
  ArticleAssetSelection,
  ArticleEvidenceCommit,
  ArticleSubmission,
  AssetUpload,
  Repository,
} from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import {
  articleEvidenceCommitStatements as sqliteArticleEvidenceCommitStatements,
  articleEvidenceInitializationStatements as sqliteArticleEvidenceInitializationStatements,
} from "@/db/sqlite/evidence-repository";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { createSqliteCategoryAuthoringRepository } from "@/db/sqlite/category-authoring-repository";
import { seedD1 } from "@/db/sqlite/seed";
import { createSqliteThemeAuthoringRepository } from "@/db/sqlite/theme-authoring-repository";
import type { ThemeAuthoringRepository } from "@/db/theme-authoring";

const expectedColumns = {
  answer_inference_leases: [
    "id",
    "workspace_id",
    "provider",
    "model",
    "maximum_output_tokens",
    "reserved_microdollars",
    "charged_microdollars",
    "status",
    "input_tokens",
    "output_tokens",
    "started_at",
    "expires_at",
    "reconciled_at",
  ],
  article_feedback: ["id", "article_id", "helpful", "comment", "created_at"],
  article_assets: ["article_id", "asset_id", "workspace_id", "created_at"],
  article_views: ["id", "article_id", "viewed_at"],
  articles: [
    "id",
    "workspace_id",
    "category_id",
    "slug",
    "title",
    "mdx",
    "status",
    "is_faq",
    "author_name",
    "published_at",
    "created_at",
    "updated_at",
    "position",
    "content_hash",
  ],
  asset_manifest_items: ["manifest_id", "asset_id", "workspace_id", "created_at"],
  asset_manifests: ["id", "workspace_id", "expires_at", "created_at"],
  assets: [
    "id",
    "workspace_id",
    "hash",
    "media_type",
    "byte_size",
    "content",
    "created_at",
  ],
  categories: [
    "id",
    "workspace_id",
    "slug",
    "name",
    "description",
    "position",
    "created_at",
    "updated_at",
    "version",
  ],
  chunk_embeddings: [
    "chunk_id",
    "embedding_generation_id",
    "workspace_id",
    "content_hash",
    "embedding_input_hash",
    "dimension",
    "vector",
    "created_at",
  ],
  embedding_generations: [
    "id",
    "workspace_id",
    "provider",
    "model",
    "dimension",
    "configuration_hash",
    "status",
    "created_at",
    "activated_at",
    "retired_at",
  ],
  embedding_jobs: [
    "id",
    "workspace_id",
    "article_id",
    "article_content_hash",
    "embedding_generation_id",
    "index_generation",
    "status",
    "attempts",
    "maximum_attempts",
    "checkpoint",
    "available_at",
    "lease_token",
    "lease_expires_at",
    "last_error_code",
    "created_at",
    "updated_at",
    "completed_at",
  ],
  evaluation_runs: [
    "id",
    "workspace_id",
    "question_set_id",
    "index_generation",
    "embedding_generation_id",
    "retrieval_mode",
    "provider",
    "model",
    "status",
    "results",
    "started_at",
    "completed_at",
  ],
  evidence_chunks: [
    "id",
    "workspace_id",
    "article_id",
    "article_content_hash",
    "content_hash",
    "embedding_input_hash",
    "index_generation",
    "ordinal",
    "title",
    "heading_path",
    "canonical_url",
    "markdown",
    "evidence_text",
    "embedding_text",
    "source_line_start",
    "source_line_end",
    "publication_state",
    "created_at",
    "updated_at",
  ],
  saved_question_sets: [
    "id",
    "workspace_id",
    "name",
    "version",
    "source_content_hash",
    "questions",
    "created_at",
  ],
  search_misses: ["id", "workspace_id", "query", "created_at"],
  support_handoffs: [
    "id",
    "workspace_id",
    "payload_hash",
    "status",
    "contact",
    "context",
    "created_at",
    "finished_at",
  ],
  themes: ["id", "workspace_id", "name", "config", "created_at", "updated_at", "version"],
  workspace_index_states: [
    "workspace_id",
    "generation",
    "active_embedding_generation_id",
    "updated_at",
  ],
  workspace_authoring_controls: [
    "workspace_id",
    "writes_paused",
    "generation",
    "changed_by_member_id",
    "changed_at",
  ],
  workspace_inference_states: ["workspace_id", "updated_at"],
  workspaces: ["id", "slug", "name", "created_at", "updated_at"],
} as const;

type TableName = keyof typeof expectedColumns;
type RuleViolation =
  | "duplicateWorkspaceSlug"
  | "duplicateCategorySlug"
  | "duplicateArticleSlug"
  | "duplicateWorkspaceTheme"
  | "orphanFeedback"
  | "orphanSearchMiss"
  | "oversizedAsset"
  | "invalidArticleStatus";

type Harness = {
  name: string;
  repository: Repository;
  categoryAuthoring: CategoryAuthoringRepository;
  themeAuthoring: ThemeAuthoringRepository;
  authoringActor(workspaceId: string): Promise<MemberActor>;
  seed(): Promise<void>;
  createWorkspace(workspace: { id: string; slug: string; name: string }): Promise<void>;
  columns(): Promise<Record<TableName, string[]>>;
  counts(): Promise<Record<TableName, number>>;
  feedback(id: string): Promise<{ helpful: boolean; comment: string | null } | null>;
  relatedArticleRecords(articleId: string): Promise<{ feedback: number; views: number }>;
  searchMissCount(id: string): Promise<number>;
  assetCount(): Promise<number>;
  expireAssetManifest(id: string): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  violate(rule: RuleViolation): Promise<void>;
  deleteFixtureArticle(id: string): Promise<void>;
  close(): Promise<void>;
};

const tableNames = Object.keys(expectedColumns) as TableName[];
const protectedAuthoringTables = [
  "categories",
  "articles",
  "themes",
  "asset_manifests",
  "asset_manifest_items",
  "assets",
  "article_assets",
  "workspace_index_states",
  "evidence_chunks",
  "embedding_generations",
  "chunk_embeddings",
  "embedding_jobs",
  "saved_question_sets",
  "evaluation_runs",
] as const;
const postgresPreFenceMigrations = [
  "0000_silly_johnny_blaze.sql",
  "0001_mysterious_bishop.sql",
  "0002_charming_dragon_lord.sql",
  "0003_harsh_goliath.sql",
  "0004_reflective_paladin.sql",
  "0005_harsh_tusk.sql",
  "0006_useful_celestials.sql",
  "0007_wise_onslaught.sql",
  "0008_brainy_crusher_hogan.sql",
  "0009_public_outcome_admission.sql",
] as const;
const sqlitePreFenceMigrations = [
  "0000_cool_gertrude_yorkes.sql",
  "0001_opposite_centennial.sql",
  "0002_tan_ezekiel.sql",
  "0003_melted_bloodscream.sql",
  "0004_lumpy_boomerang.sql",
  "0005_medical_sleepwalker.sql",
  "0006_large_bloodscream.sql",
  "0007_nostalgic_hulk.sql",
  "0008_lush_kid_colt.sql",
  "0009_public_outcome_admission.sql",
] as const;
const dayInMilliseconds = 86_400_000;
let evidenceJobSequence = 0;

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryActor(workspaceId: string): MemberActor {
  const identity = hashText(`repository-author:${workspaceId}`);
  return {
    memberId: `member_${identity.slice(0, 24)}`,
    sessionId: hashText(`repository-session:${workspaceId}`).slice(0, 43),
    workspaceId,
  };
}

function draftActor(actor: MemberActor): DraftActor {
  return { memberId: actor.memberId, sessionId: actor.sessionId };
}

function draftValues(article: ArticleSubmission): DraftArticleValues {
  return {
    authorName: article.authorName,
    categoryId: article.categoryId,
    id: article.id,
    isFaq: article.isFaq,
    mdx: article.mdx,
    position: article.position ?? 0,
    slug: article.slug,
    title: article.title,
    workspaceId: article.workspaceId,
  };
}

async function workingArticle(harness: Harness, article: ArticleSubmission) {
  const member = await harness.authoringActor(article.workspaceId);
  const actor = draftActor(member);
  const head = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: article.id,
    workspaceId: article.workspaceId,
  });
  return { actor, head };
}

async function createWorkflowArticle(
  harness: Harness,
  article: ArticleSubmission,
  assets: ArticleAssetSelection | undefined,
  evidence: ArticleEvidenceCommit | null,
) {
  validateArticleEvidence(article, evidence);
  const member = await harness.authoringActor(article.workspaceId);
  const actor = draftActor(member);
  const created = await harness.repository.createDraftArticle({
    actor,
    article: draftValues(article),
    assets: assets ?? { hashes: [] },
    changeKind: "manual",
  });
  if (created.status !== "saved") {
    if (assets?.manifestId) {
      await discardWorkflowAssetManifest(
        harness,
        article.workspaceId,
        assets.manifestId,
      );
    }
    throw new Error(`Article creation failed: ${JSON.stringify(created)}`);
  }
  if (article.status === "published") {
    const published = await harness.repository.emergencyPublishArticle({
      actor,
      articleId: article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: created.revisionNumber,
      reason: "Repository integration fixture",
      revisionId: created.revisionId,
      workspaceId: article.workspaceId,
    });
    if (published.status !== "transitioned") {
      throw new Error(`Article publication failed: ${JSON.stringify(published)}`);
    }
  }
}

async function saveWorkflowArticle(
  harness: Harness,
  article: ArticleSubmission,
  assets: ArticleAssetSelection | undefined,
  evidence: ArticleEvidenceCommit | null,
) {
  validateArticleEvidence(article, evidence);
  if (!(await harness.repository.getArticle(article.workspaceId, article.id))) return;
  const current = await workingArticle(harness, article);
  if (!current.head) return;
  const saved = await harness.repository.saveDraftArticle({
    actor: current.actor,
    article: draftValues(article),
    assets: assets ?? { hashes: current.head.assetHashes },
    changeKind: "manual",
    expectedWorkingRevisionNumber: current.head.revisionNumber,
  });
  if (saved.status === "conflict" || saved.status === "rejected") {
    if (assets?.manifestId) {
      await discardWorkflowAssetManifest(
        harness,
        article.workspaceId,
        assets.manifestId,
      );
    }
    throw new Error(`Article save failed: ${JSON.stringify(saved)}`);
  }
  const next = await workingArticle(harness, article);
  if (!next.head) throw new Error("Saved article head was not found.");
  if (article.status === "published") {
    if (
      next.head.publicStatus === "published" &&
      next.head.publishedRevisionId === next.head.revisionId
    ) {
      return;
    }
    const published = await harness.repository.emergencyPublishArticle({
      actor: next.actor,
      articleId: article.id,
      expectedReviewState: next.head.reviewState,
      expectedWorkingRevisionNumber: next.head.revisionNumber,
      reason: "Repository integration fixture",
      revisionId: next.head.revisionId,
      workspaceId: article.workspaceId,
    });
    if (published.status !== "transitioned") {
      throw new Error(`Article publication failed: ${JSON.stringify(published)}`);
    }
    return;
  }
  if (next.head.publicStatus === "published") {
    const unpublished = await harness.repository.unpublishArticle({
      actor: next.actor,
      articleId: article.id,
      expectedReviewState: next.head.reviewState,
      expectedWorkingRevisionNumber: next.head.revisionNumber,
      revisionId: next.head.revisionId,
      workspaceId: article.workspaceId,
    });
    if (unpublished.status !== "transitioned") {
      throw new Error(`Article unpublication failed: ${JSON.stringify(unpublished)}`);
    }
  }
}

async function removeWorkflowArticle(
  harness: Harness,
  workspaceId: string,
  articleId: string,
) {
  const article = await harness.repository.getArticle(workspaceId, articleId);
  if (!article) return;
  const current = await workingArticle(harness, article);
  if (!current.head) return;
  const archived = await harness.repository.archiveArticle({
    actor: current.actor,
    articleId,
    expectedPublicStatus: current.head.publicStatus,
    expectedReviewState: current.head.reviewState,
    expectedWorkingRevisionNumber: current.head.revisionNumber,
    revisionId: current.head.revisionId,
    workspaceId,
  });
  if (archived.status !== "transitioned") {
    throw new Error(`Article archive failed: ${JSON.stringify(archived)}`);
  }
  await harness.deleteFixtureArticle(articleId);
}

async function assetAuthoringRequest(
  harness: Harness,
  workspaceId: string,
  checkedAt = new Date(),
) {
  return { ...(await harness.authoringActor(workspaceId)), checkedAt };
}

async function createWorkflowAssetManifest(
  harness: Harness,
  workspaceId: string,
  expiresAt: Date,
) {
  return harness.repository.createAuthorizedAssetManifest(
    await assetAuthoringRequest(harness, workspaceId),
    expiresAt,
  );
}

async function stageWorkflowAsset(
  harness: Harness,
  workspaceId: string,
  manifestId: string,
  upload: AssetUpload,
) {
  return harness.repository.stageAuthorizedAsset(
    await assetAuthoringRequest(harness, workspaceId),
    manifestId,
    upload,
  );
}

async function discardWorkflowAssetManifest(
  harness: Harness,
  workspaceId: string,
  manifestId: string,
) {
  await harness.repository.discardAuthorizedAssetManifest(
    await assetAuthoringRequest(harness, workspaceId),
    manifestId,
  );
}

async function cleanupWorkflowAssets(
  harness: Harness,
  workspaceId: string,
  checkedAt: Date,
) {
  await harness.repository.cleanupAuthorizedExpiredAssets(
    await assetAuthoringRequest(harness, workspaceId, checkedAt),
  );
}

async function createCategory(harness: Harness, category: CategoryValues) {
  const result = await harness.categoryAuthoring.createCategory({
    actor: await harness.authoringActor(category.workspaceId),
    category,
    expectedCategoryVersion: 0,
  });
  assert.equal(result.status, "created");
}

async function updateCategory(harness: Harness, category: CategoryValues) {
  const current = (await harness.categoryAuthoring.listCategories(category.workspaceId)).find(
    (candidate) => candidate.id === category.id,
  );
  if (!current) return false;
  const result = await harness.categoryAuthoring.updateCategory({
    actor: await harness.authoringActor(category.workspaceId),
    category,
    expectedCategoryVersion: current.version,
  });
  return result.status === "unchanged" || result.status === "updated";
}

async function deleteCategory(
  harness: Harness,
  workspaceId: string,
  categoryId: string,
) {
  const current = (await harness.categoryAuthoring.listCategories(workspaceId)).find(
    (candidate) => candidate.id === categoryId,
  );
  if (!current) return false;
  const result = await harness.categoryAuthoring.deleteCategory({
    actor: await harness.authoringActor(workspaceId),
    category: { id: categoryId, workspaceId },
    expectedCategoryVersion: current.version,
  });
  return result.status === "deleted";
}

async function updateTheme(
  harness: Harness,
  theme: Readonly<{ config: unknown; name: string; workspaceId: string }>,
) {
  const current = await harness.themeAuthoring.getTheme(theme.workspaceId);
  assert.ok(current);
  const result = await harness.themeAuthoring.updateTheme({
    actor: await harness.authoringActor(theme.workspaceId),
    expectedThemeVersion: current.version,
    theme: {
      config: theme.config,
      id: current.id,
      name: theme.name,
      workspaceId: theme.workspaceId,
    },
  });
  assert.ok(result.status === "unchanged" || result.status === "updated");
}

function categorySlug(categoryId: string) {
  if (categoryId === demoIds.gettingStartedCategory) {
    return "getting-started";
  }
  return categoryId.replace(/^category_/u, "").replaceAll("_", "-");
}

function articleEvidence(
  article: ArticleSubmission,
  selectedCategorySlug = categorySlug(article.categoryId),
): ArticleEvidenceCommit | null {
  if (article.status === "draft") {
    return null;
  }

  const contentHash = hashText(
    JSON.stringify([article.title, article.mdx, selectedCategorySlug, article.slug]),
  );
  const sourceHash = hashText(article.mdx);
  return {
    workspaceId: article.workspaceId,
    articleId: article.id,
    categorySlug: selectedCategorySlug,
    articleContentHash: contentHash,
    chunks: [
      {
        id: `chunk_${hashText(article.id).slice(0, 32)}`,
        contentHash: sourceHash,
        embeddingInputHash: hashText(`${article.title}\n\n${article.mdx}`),
        ordinal: 0,
        title: article.title,
        headingPath: [],
        canonicalUrl: `https://docs.example.test/${selectedCategorySlug}/${article.slug}`,
        markdown: article.mdx,
        evidenceText: article.mdx,
        embeddingText: `${article.title}\n\n${article.mdx}`,
        sourceLineRange: {
          start: 1,
          end: Math.max(1, article.mdx.split("\n").length),
        },
      },
    ],
    job: {
      id: `embedding_job_repository_${evidenceJobSequence++}`,
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt: new Date(),
    },
  };
}

async function applyPostgresMigration(pool: Pool, filename: string) {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/postgres", filename),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      await pool.query(statement);
    }
  }
}

async function applyPostgresMigrationAtomically(pool: Pool, filename: string) {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/postgres", filename),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function applySqliteMigration(client: Database.Database, filename: string) {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/sqlite", filename),
    "utf8",
  );
  client.transaction(() => client.exec(migration))();
}

async function recordSearchSamples(
  repository: Repository,
  workspaceId: string,
  query: string,
  count: number,
  createdAt: Date,
) {
  for (let index = 0; index < count; index += 1) {
    await repository.recordSearchMiss({
      id: `analytics_miss_${workspaceId}_${query}_${index}`,
      workspaceId,
      query,
      createdAt,
    });
  }
}

function importPng(marker: number) {
  return new Uint8Array([
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


function inferenceReservation(
  workspaceId: string,
  id: string,
  startedAt: Date,
  options: Partial<AnswerInferenceReservation> = {},
): AnswerInferenceReservation {
  return {
    id,
    workspaceId,
    provider: "openai-compatible",
    model: "fixture-answer-model",
    maximumOutputTokens: 512,
    reservedMicrodollars: 60,
    maximumConcurrency: 3,
    dailyBudgetMicrodollars: 1_000,
    startedAt,
    expiresAt: new Date(startedAt.getTime() + 60_000),
    spendWindowStartedAt: new Date(startedAt.getTime() - dayInMilliseconds),
    retentionStartedAt: new Date(startedAt.getTime() - 31 * dayInMilliseconds),
    ...options,
  };
}

async function exerciseAnswerInferenceAdmission(harness: Harness) {
  const suffix = harness.name.toLowerCase();
  const concurrencyWorkspace = `workspace_inference_concurrency_${suffix}`;
  const spendWorkspace = `workspace_inference_spend_${suffix}`;
  const expiryWorkspace = `workspace_inference_expiry_${suffix}`;
  const retentionWorkspace = `workspace_inference_retention_${suffix}`;
  for (const workspaceId of [
    concurrencyWorkspace,
    spendWorkspace,
    expiryWorkspace,
    retentionWorkspace,
  ]) {
    await harness.createWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: workspaceId,
    });
  }

  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const raced = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      harness.repository.reserveAnswerInference(
        inferenceReservation(
          concurrencyWorkspace,
          `answer_lease_race_${suffix}_${index}`,
          startedAt,
        ),
      ),
    ),
  );
  const accepted = raced.filter((lease) => lease !== null);
  assert.equal(
    accepted.length,
    3,
    `${harness.name} exceeded the atomic inference concurrency limit`,
  );
  assert.ok(
    accepted.every(
      (lease) =>
        lease.provider === "openai-compatible" &&
        lease.model === "fixture-answer-model" &&
        lease.reservedMicrodollars === 60,
    ),
  );

  const firstLease = accepted[0]!;
  const firstSettlement = await harness.repository.reconcileAnswerInference({
    id: firstLease.id,
    workspaceId: concurrencyWorkspace,
    chargedMicrodollars: 10,
    inputTokens: 20,
    outputTokens: 8,
    reconciledAt: new Date(startedAt.getTime() + 1_000),
    status: "completed",
  });
  const repeatedSettlement = await harness.repository.reconcileAnswerInference({
    id: firstLease.id,
    workspaceId: concurrencyWorkspace,
    chargedMicrodollars: 0,
    inputTokens: 0,
    outputTokens: 0,
    reconciledAt: new Date(startedAt.getTime() + 2_000),
    status: "failed",
  });
  assert.equal(firstSettlement?.status, "completed");
  assert.equal(repeatedSettlement?.status, "completed");
  assert.equal(repeatedSettlement?.chargedMicrodollars, 10);
  assert.equal(repeatedSettlement?.inputTokens, 20);
  assert.equal(repeatedSettlement?.outputTokens, 8);

  assert.ok(
    await harness.repository.reserveAnswerInference(
      inferenceReservation(
        concurrencyWorkspace,
        `answer_lease_after_reconcile_${suffix}`,
        new Date(startedAt.getTime() + 3_000),
      ),
    ),
    `${harness.name} did not release reconciled inference concurrency`,
  );

  const spendFirst = await harness.repository.reserveAnswerInference(
    inferenceReservation(
      spendWorkspace,
      `answer_lease_spend_first_${suffix}`,
      startedAt,
      { dailyBudgetMicrodollars: 100, maximumConcurrency: 10 },
    ),
  );
  const spendSecond = await harness.repository.reserveAnswerInference(
    inferenceReservation(
      spendWorkspace,
      `answer_lease_spend_second_${suffix}`,
      startedAt,
      { dailyBudgetMicrodollars: 100, maximumConcurrency: 10 },
    ),
  );
  assert.ok(spendFirst);
  assert.equal(
    spendSecond,
    null,
    `${harness.name} exceeded the rolling inference spend limit`,
  );

  const expiring = await harness.repository.reserveAnswerInference(
    inferenceReservation(
      expiryWorkspace,
      `answer_lease_expiring_${suffix}`,
      startedAt,
      {
        dailyBudgetMicrodollars: 120,
        expiresAt: new Date(startedAt.getTime() + 1_000),
        maximumConcurrency: 1,
      },
    ),
  );
  assert.ok(expiring);
  const afterExpiryAt = new Date(startedAt.getTime() + 1_001);
  const recovered = await harness.repository.reserveAnswerInference(
    inferenceReservation(
      expiryWorkspace,
      `answer_lease_recovered_${suffix}`,
      afterExpiryAt,
      { dailyBudgetMicrodollars: 120, maximumConcurrency: 1 },
    ),
  );
  assert.ok(recovered, `${harness.name} did not recover expired lease concurrency`);
  const expired = await harness.repository.getAnswerInferenceLease(
    expiryWorkspace,
    expiring.id,
  );
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.chargedMicrodollars, expiring.reservedMicrodollars);
  const lateSettlement = await harness.repository.reconcileAnswerInference({
    id: expiring.id,
    workspaceId: expiryWorkspace,
    chargedMicrodollars: 0,
    inputTokens: 0,
    outputTokens: 0,
    reconciledAt: new Date(startedAt.getTime() + 2_000),
    status: "completed",
  });
  assert.equal(lateSettlement?.status, "expired");
  assert.equal(
    lateSettlement?.chargedMicrodollars,
    expiring.reservedMicrodollars,
    `${harness.name} released possibly-spent budget after lease expiry`,
  );

  const oldStartedAt = new Date(startedAt.getTime() - 40 * dayInMilliseconds);
  const oldLease = await harness.repository.reserveAnswerInference(
    inferenceReservation(
      retentionWorkspace,
      `answer_lease_old_${suffix}`,
      oldStartedAt,
    ),
  );
  assert.ok(oldLease);
  await harness.repository.reconcileAnswerInference({
    id: oldLease.id,
    workspaceId: retentionWorkspace,
    chargedMicrodollars: 10,
    inputTokens: 20,
    outputTokens: 8,
    reconciledAt: new Date(oldStartedAt.getTime() + 1_000),
    status: "completed",
  });
  assert.ok(
    await harness.repository.reserveAnswerInference(
      inferenceReservation(
        retentionWorkspace,
        `answer_lease_retention_trigger_${suffix}`,
        startedAt,
      ),
    ),
  );
  assert.equal(
    await harness.repository.getAnswerInferenceLease(
      retentionWorkspace,
      oldLease.id,
    ),
    null,
    `${harness.name} did not remove an expired-retention terminal lease`,
  );

  for (const workspaceId of [
    concurrencyWorkspace,
    spendWorkspace,
    expiryWorkspace,
    retentionWorkspace,
  ]) {
    await harness.deleteWorkspace(workspaceId);
  }
}

async function exerciseRepository(harness: Harness) {
  await harness.createWorkspace(demoContent.workspace);
  await harness.authoringActor(demoIds.workspace);
  await harness.seed();
  await harness.seed();

  const publishedDemoArticles = demoContent.articles.filter(
    (article) => article.status === "published",
  );
  const seededAssetCount = demoContent.assets.length;
  const draftDemoArticle = demoContent.articles.find(
    (article) => article.id === demoIds.draftArticle,
  );
  assert.ok(draftDemoArticle);

  assert.deepEqual(await harness.columns(), expectedColumns, `${harness.name} schema drifted`);
  assert.deepEqual(await harness.counts(), {
    answer_inference_leases: 0,
    article_feedback: 0,
    article_assets: 1,
    article_views: 0,
    articles: demoContent.articles.length,
    asset_manifest_items: 0,
    asset_manifests: 0,
    assets: demoContent.assets.length,
    categories: demoContent.categories.length,
    chunk_embeddings: 0,
    embedding_generations: 0,
    embedding_jobs: publishedDemoArticles.length,
    evaluation_runs: 0,
    evidence_chunks: 18,
    saved_question_sets: 0,
    search_misses: 0,
    support_handoffs: 0,
    themes: 1,
    workspace_authoring_controls: 1,
    workspace_index_states: 1,
    workspace_inference_states: 0,
    workspaces: 1,
  });

  await harness.repository.checkHealth();
  await exerciseAnswerInferenceAdmission(harness);

  const published = await harness.repository.findPublishedArticle(
    demoIds.workspace,
    demoContent.articles[0].slug,
  );
  assert.ok(published);
  assert.equal(published.id, demoIds.publishedArticle);
  assert.equal(published.isFaq, false);
  assert.equal(published.position, 0);
  assert.ok(published.publishedAt instanceof Date);
  assert.ok(published.createdAt instanceof Date);
  assert.ok(published.updatedAt instanceof Date);
  assert.equal(published.publishedAt.toISOString(), demoSeededAt);
  assert.equal(published.createdAt.toISOString(), demoSeededAt);
  assert.equal(published.updatedAt.toISOString(), demoSeededAt);

  assert.equal(
    await harness.repository.findPublishedArticle(
      demoIds.workspace,
      draftDemoArticle.slug,
    ),
    null,
    `${harness.name} exposed a draft article`,
  );
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, "missing-article"),
    null,
  );

  const publishedArticles = await harness.repository.listPublishedArticles(demoIds.workspace);
  assert.equal(
    publishedArticles.length,
    publishedDemoArticles.length,
    `${harness.name} included drafts in public listings`,
  );
  assert.deepEqual(
    publishedArticles.map((article) => article.id).sort(),
    publishedDemoArticles.map((article) => article.id).sort(),
  );

  const categories = await harness.repository.listCategories(demoIds.workspace);
  assert.deepEqual(
    categories,
    demoContent.categories.map((category) => ({
      id: category.id,
      workspaceId: category.workspaceId,
      slug: category.slug,
      name: category.name,
      description: category.description,
      position: category.position,
    })),
  );

  const contractCategory = {
    id: "category_contract",
    workspaceId: demoIds.workspace,
    slug: "contract",
    name: "Contract",
    description: null,
    position: 1,
  };
  await createCategory(harness, contractCategory);
  assert.deepEqual(
    (await harness.categoryAuthoring.listCategories(demoIds.workspace)).map(
      (category) => category.id,
    ),
    [
      demoIds.gettingStartedCategory,
      contractCategory.id,
      demoIds.customizationCategory,
      demoIds.answersCategory,
      demoIds.deploymentCategory,
    ],
    `${harness.name} did not order equal-position categories by id`,
  );

  await updateCategory(harness, {
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
  });
  assert.deepEqual((await harness.categoryAuthoring.listCategories(demoIds.workspace))[0], {
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
    version: 2,
  });

  assert.equal(
    await deleteCategory(
      harness,
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    false,
    `${harness.name} deleted a category that still contained articles`,
  );

  await updateCategory(harness, {
    ...contractCategory,
    workspaceId: "workspace_missing",
    name: "Wrong workspace",
  });
  assert.equal(
    (await harness.categoryAuthoring.listCategories(demoIds.workspace))[0].name,
    "Repository contract",
    `${harness.name} updated a category outside the requested workspace`,
  );

  const contractArticle = {
    id: "article_contract",
    workspaceId: demoIds.workspace,
    categoryId: contractCategory.id,
    slug: "repository-contract",
    title: "Repository contract",
    mdx: "# Repository contract",
    status: "draft" as const,
    isFaq: true,
    authorName: "Contract author",
    position: 7,
    publishedAt: null,
  };
  await createWorkflowArticle(harness, contractArticle, undefined, null);

  const createdArticle = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(createdArticle);
  const {
    contentHash: contractContentHash,
    createdAt: contractCreatedAt,
    updatedAt: contractUpdatedAt,
    ...createdArticleSubmission
  } = createdArticle;
  assert.deepEqual(createdArticleSubmission, contractArticle);
  assert.equal(contractContentHash, null);
  assert.ok(contractCreatedAt instanceof Date);
  assert.ok(contractUpdatedAt instanceof Date);
  for (const [id, position] of [
    ["article_position_alpha", 2],
    ["article_position_zulu", 2],
  ] as const) {
    await createWorkflowArticle(harness, {
      ...contractArticle,
      id,
      slug: id.replaceAll("_", "-"),
      title: id,
      position,
    }, undefined, null);
  }
  assert.deepEqual(
    (await harness.repository.listArticles(demoIds.workspace))
      .filter((article) => article.categoryId === contractCategory.id)
      .map((article) => article.id),
    ["article_position_alpha", "article_position_zulu", contractArticle.id],
    `${harness.name} did not order articles by position and id`,
  );
  await removeWorkflowArticle(harness, demoIds.workspace, "article_position_alpha");
  await removeWorkflowArticle(harness, demoIds.workspace, "article_position_zulu");
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, contractArticle.slug),
    null,
    `${harness.name} exposed an admin-created draft`,
  );

  const contractPublishedAt = new Date("2026-02-03T04:05:06.000Z");
  const publishedContractArticle = {
    ...contractArticle,
    mdx: "# Published repository contract",
    title: "Published repository contract",
    status: "published",
    publishedAt: contractPublishedAt,
  } as const;
  const publishedContractEvidence = articleEvidence(publishedContractArticle);
  assert.ok(publishedContractEvidence);
  await saveWorkflowArticle(harness,
    publishedContractArticle,
    undefined,
    publishedContractEvidence,
  );

  const updatedArticle = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(updatedArticle);
  assert.match(updatedArticle.contentHash ?? "", /^[a-f\d]{64}$/u);
  assert.equal(updatedArticle.status, "published");
  assert.equal(updatedArticle.title, "Published repository contract");
  assert.equal(updatedArticle.position, 7);
  assert.ok(updatedArticle.publishedAt instanceof Date);
  assert.equal(updatedArticle.createdAt.toISOString(), contractCreatedAt.toISOString());
  assert.ok(updatedArticle.updatedAt.getTime() >= contractUpdatedAt.getTime());
  assert.ok(
    (await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} omitted a newly published article from the public listing`,
  );
  assert.equal(
    await updateCategory(harness, {
      ...contractCategory,
      slug: "contract-moved",
    }),
    false,
    `${harness.name} changed a category route while published evidence used it`,
  );
  assert.equal(
    (await harness.repository.listCategories(demoIds.workspace)).find(
      (category) => category.id === contractCategory.id,
    )?.slug,
    contractCategory.slug,
  );
  const stateBeforeCategoryMismatch = await harness.repository.getIndexingState(
    demoIds.workspace,
  );
  const chunksBeforeCategoryMismatch = await harness.repository.listEvidenceChunks(
    demoIds.workspace,
  );
  const mismatchedCategoryArticle = {
    ...publishedContractArticle,
    title: "Mismatched category evidence",
  };
  await assert.rejects(
    saveWorkflowArticle(harness,
      mismatchedCategoryArticle,
      undefined,
      articleEvidence(mismatchedCategoryArticle, "wrong-category"),
    ),
    `${harness.name} accepted evidence prepared for another category route`,
  );
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, contractArticle.id))
      ?.title,
    publishedContractArticle.title,
  );
  assert.deepEqual(
    await harness.repository.getIndexingState(demoIds.workspace),
    stateBeforeCategoryMismatch,
  );
  assert.deepEqual(
    await harness.repository.listEvidenceChunks(demoIds.workspace),
    chunksBeforeCategoryMismatch,
  );
  const publishedArticleIds = (
    await harness.repository.listPublishedArticles(demoIds.workspace)
  ).map((article) => article.id);
  assert.equal(publishedArticleIds[0], contractArticle.id);
  assert.deepEqual(
    publishedArticleIds.slice(1).sort(),
    publishedDemoArticles.map((article) => article.id).sort(),
  );

  const listedArticles = await harness.repository.listArticles(demoIds.workspace);
  assert.deepEqual(
    listedArticles
      .map((article) => [article.id, article.title, article.status])
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
    [
      [contractArticle.id, "Published repository contract", "published"],
      ...demoContent.articles.map((article) => [
        article.id,
        article.title,
        article.status,
      ]),
    ].sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  );

  await saveWorkflowArticle(harness,
    {
      ...contractArticle,
      workspaceId: "workspace_missing",
      title: "Wrong workspace",
    },
    undefined,
    null,
  );
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, contractArticle.id))?.title,
    "Published repository contract",
    `${harness.name} updated an article outside the requested workspace`,
  );

  const assetContent = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const assetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const firstManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const duplicateManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const firstAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    firstManifest.id,
    { mediaType: "image/png", content: assetContent },
  );
  const duplicateAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    duplicateManifest.id,
    { mediaType: "image/png", content: assetContent },
  );

  assert.equal(firstAsset.hash, duplicateAsset.hash);
  assert.equal(firstAsset.byteSize, assetContent.byteLength);
  assert.deepEqual(
    (await harness.repository.getAsset(demoIds.workspace, firstAsset.hash))?.content,
    assetContent,
  );
  assert.equal(
    await harness.repository.getPublishedAsset(demoIds.workspace, firstAsset.hash),
    null,
    `${harness.name} exposed a staged asset publicly`,
  );
  assert.equal(
    await harness.assetCount(),
    seededAssetCount + 1,
    `${harness.name} did not deduplicate an asset`,
  );

  await discardWorkflowAssetManifest(harness,
    demoIds.workspace,
    duplicateManifest.id,
  );
  assert.equal(await harness.assetCount(), seededAssetCount + 1);

  const attachedContractEvidence = articleEvidence(publishedContractArticle);
  assert.ok(attachedContractEvidence);
  await saveWorkflowArticle(harness,
    publishedContractArticle,
    { manifestId: firstManifest.id, hashes: [firstAsset.hash] },
    attachedContractEvidence,
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      contractArticle.id,
    ),
    [firstAsset.hash],
  );
  assert.equal(
    (await harness.repository.getPublishedAsset(demoIds.workspace, firstAsset.hash))?.hash,
    firstAsset.hash,
    `${harness.name} hid an asset attached to a published article`,
  );
  const draftContractArticle = {
    ...contractArticle,
    status: "draft" as const,
    publishedAt: contractPublishedAt,
  };
  await saveWorkflowArticle(harness, draftContractArticle, undefined, null);
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, contractArticle.id))
      ?.contentHash,
    null,
  );
  assert.equal(
    (await harness.repository.listEvidenceChunks(demoIds.workspace)).some(
      (chunk) => chunk.articleId === contractArticle.id,
    ),
    false,
    `${harness.name} exposed evidence after unpublishing its article`,
  );
  assert.equal(
    await harness.repository.getPublishedAsset(demoIds.workspace, firstAsset.hash),
    null,
    `${harness.name} exposed a draft-only asset publicly`,
  );
  const republishedContractArticle = {
    ...contractArticle,
    status: "published" as const,
    publishedAt: contractPublishedAt,
  };
  await saveWorkflowArticle(harness,
    republishedContractArticle,
    undefined,
    articleEvidence(republishedContractArticle),
  );
  let attachedAssetHash = firstAsset.hash;

  const retryAssetContent = importPng(31);
  const failedUpdateManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const failedUpdateAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    failedUpdateManifest.id,
    { mediaType: "image/png", content: retryAssetContent },
  );
  const articleBeforePersistenceFailure = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(articleBeforePersistenceFailure);
  await assert.rejects(
    saveWorkflowArticle(harness,
      {
        ...articleBeforePersistenceFailure,
        slug: demoContent.articles[0].slug,
        title: "Rejected persistence update",
      },
      {
        manifestId: failedUpdateManifest.id,
        hashes: [failedUpdateAsset.hash],
      },
      articleEvidence({
        ...articleBeforePersistenceFailure,
        slug: demoContent.articles[0].slug,
        title: "Rejected persistence update",
      }),
    ),
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, failedUpdateAsset.hash),
    null,
    `${harness.name} retained a staged asset after persistence failed`,
  );
  assert.deepEqual(
    await harness.repository.getArticle(demoIds.workspace, contractArticle.id),
    articleBeforePersistenceFailure,
    `${harness.name} changed article fields when persistence failed`,
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      contractArticle.id,
    ),
    [attachedAssetHash],
  );

  const retryManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const retryAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    retryManifest.id,
    { mediaType: "image/png", content: retryAssetContent },
  );
  assert.equal(retryAsset.hash, failedUpdateAsset.hash);
  await saveWorkflowArticle(harness,
    articleBeforePersistenceFailure,
    {
      manifestId: retryManifest.id,
      hashes: [retryAsset.hash],
    },
    articleEvidence(articleBeforePersistenceFailure),
  );
  attachedAssetHash = retryAsset.hash;
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      contractArticle.id,
    ),
    [attachedAssetHash],
    `${harness.name} could not retry a failed staged asset save`,
  );
  assert.ok(
    await harness.repository.getAsset(demoIds.workspace, firstAsset.hash),
    `${harness.name} deleted an asset retained by immutable revision history`,
  );

  const oversizedManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const oversizedAsset = new Uint8Array(1024 * 1024 + 1);
  oversizedAsset.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    stageWorkflowAsset(harness, demoIds.workspace, oversizedManifest.id, {
      mediaType: "image/png",
      content: oversizedAsset,
    }),
    /1 MiB or smaller/,
  );
  await assert.rejects(
    stageWorkflowAsset(harness, demoIds.workspace, oversizedManifest.id, {
      mediaType: "image/png",
      content: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    }),
    /does not match its media type/,
  );
  await discardWorkflowAssetManifest(harness,
    demoIds.workspace,
    oversizedManifest.id,
  );
  assert.equal(await harness.assetCount(), seededAssetCount + 2);
  await assert.rejects(
    stageWorkflowAsset(harness, demoIds.workspace, "asset_manifest_missing", {
      mediaType: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }),
  );
  assert.equal(
    await harness.assetCount(),
    seededAssetCount + 2,
    `${harness.name} retained an asset from an unauthenticated manifest`,
  );

  const failedManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const failedAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    failedManifest.id,
    {
      mediaType: "image/webp",
      content: new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
    },
  );
  await assert.rejects(
    createWorkflowArticle(harness,
      {
        ...contractArticle,
        id: "article_asset_rollback",
        slug: demoContent.articles[0].slug,
      },
      { manifestId: failedManifest.id, hashes: [failedAsset.hash] },
      null,
    ),
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, failedAsset.hash),
    null,
    `${harness.name} retained an asset after a failed article save`,
  );

  const cancelledManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const cancelledAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    cancelledManifest.id,
    {
      mediaType: "image/gif",
      content: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    },
  );
  await discardWorkflowAssetManifest(harness,
    demoIds.workspace,
    cancelledManifest.id,
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, cancelledAsset.hash),
    null,
  );

  const expiringManifest = await createWorkflowAssetManifest(harness,
    demoIds.workspace,
    assetExpiresAt,
  );
  const expiredAsset = await stageWorkflowAsset(harness,
    demoIds.workspace,
    expiringManifest.id,
    { mediaType: "image/jpeg", content: new Uint8Array([0xff, 0xd8, 0xff]) },
  );
  await cleanupWorkflowAssets(harness,
    demoIds.workspace,
    new Date(assetExpiresAt.getTime() + 1),
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, expiredAsset.hash),
    null,
  );
  assert.equal(await harness.assetCount(), seededAssetCount + 2);

  const attachedArticleBeforeRejectedUpdate = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(attachedArticleBeforeRejectedUpdate);
  await assert.rejects(
    saveWorkflowArticle(harness,
      {
        ...attachedArticleBeforeRejectedUpdate,
        title: "Rejected forged asset update",
      },
      { hashes: ["f".repeat(64)] },
      articleEvidence({
        ...attachedArticleBeforeRejectedUpdate,
        title: "Rejected forged asset update",
      }),
    ),
  );
  assert.equal(
    (
      await harness.repository.getArticle(
        demoIds.workspace,
        contractArticle.id,
      )
    )?.title,
    attachedArticleBeforeRejectedUpdate.title,
    `${harness.name} retained article fields from a rejected asset update`,
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      contractArticle.id,
    ),
    [attachedAssetHash],
    `${harness.name} removed the current attachment during a rejected asset update`,
  );

  await saveWorkflowArticle(harness,
    attachedArticleBeforeRejectedUpdate,
    { hashes: [] },
    articleEvidence(attachedArticleBeforeRejectedUpdate),
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      contractArticle.id,
    ),
    [],
  );
  assert.ok(
    await harness.repository.getAsset(demoIds.workspace, attachedAssetHash),
    `${harness.name} deleted an asset retained by immutable revision history`,
  );

  await removeWorkflowArticle(harness, "workspace_missing", contractArticle.id);
  assert.ok(await harness.repository.getArticle(demoIds.workspace, contractArticle.id));
  await removeWorkflowArticle(harness, demoIds.workspace, contractArticle.id);
  await cleanupWorkflowAssets(harness, demoIds.workspace, new Date());
  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, contractArticle.id),
    null,
  );
  assert.equal(
    await harness.assetCount(),
    seededAssetCount,
    `${harness.name} retained a deleted article asset`,
  );
  assert.ok(
    !(await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} retained a deleted article in the public listing`,
  );

  assert.equal(
    await deleteCategory(harness, "workspace_missing", contractCategory.id),
    false,
  );
  assert.ok(
    (await harness.categoryAuthoring.listCategories(demoIds.workspace)).some(
      (category) => category.id === contractCategory.id,
    ),
  );
  assert.equal(
    await deleteCategory(harness, demoIds.workspace, contractCategory.id),
    true,
  );
  assert.ok(
    !(await harness.categoryAuthoring.listCategories(demoIds.workspace)).some(
      (category) => category.id === contractCategory.id,
    ),
  );

  const theme = await harness.repository.getTheme(demoIds.workspace);
  assert.ok(theme);
  assert.equal(theme.id, demoIds.theme);
  assert.equal(theme.name, demoContent.theme.name);
  assert.deepEqual(theme.config, demoContent.theme.config);
  assert.ok(theme.createdAt instanceof Date);
  assert.ok(theme.updatedAt instanceof Date);
  assert.equal(theme.createdAt.toISOString(), demoSeededAt);
  assert.equal(theme.updatedAt.toISOString(), demoSeededAt);

  const updatedThemeConfig = {
    ...demoContent.theme.config,
    light: {
      ...demoContent.theme.config.light,
      primary: "oklch(0.55 0.18 250)",
    },
  };
  await updateTheme(harness, {
    workspaceId: demoIds.workspace,
    name: "Contract Theme",
    config: updatedThemeConfig,
  });

  const updatedTheme = await harness.repository.getTheme(demoIds.workspace);
  assert.ok(updatedTheme);
  assert.equal(updatedTheme.id, demoIds.theme);
  assert.equal(updatedTheme.workspaceId, demoIds.workspace);
  assert.equal(updatedTheme.name, "Contract Theme");
  assert.deepEqual(updatedTheme.config, updatedThemeConfig);
  assert.equal(updatedTheme.createdAt.toISOString(), demoSeededAt);
  assert.ok(updatedTheme.updatedAt.getTime() > new Date(demoSeededAt).getTime());

  const contractEventAt = new Date();
  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: true,
    comment: "Clear and useful",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_contract",
    workspaceId: demoIds.workspace,
    query: "billing portal",
    createdAt: contractEventAt,
  });

  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });
  assert.equal(await harness.searchMissCount("search_miss_contract"), 1);

  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: "Colliding slot",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });

  await harness.repository.createFeedback({
    id: "feedback_expired",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: null,
    createdAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  await harness.repository.recordView({
    id: "view_expired",
    articleId: demoIds.publishedArticle,
    viewedAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 2,
    views: 2,
  });

  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: "Retention trigger",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });

  await harness.repository.recordSearchMiss({
    id: "search_miss_expired",
    workspaceId: demoIds.workspace,
    query: "expired query",
    createdAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_retention_trigger",
    workspaceId: demoIds.workspace,
    query: "current query",
    createdAt: contractEventAt,
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_retention_trigger",
    workspaceId: demoIds.workspace,
    query: "colliding slot",
    createdAt: contractEventAt,
  });
  assert.equal(await harness.searchMissCount("search_miss_expired"), 0);
  assert.equal(await harness.searchMissCount("search_miss_retention_trigger"), 1);

  const analyticsArticles = [
    {
      id: "article_analytics_alpha",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-alpha",
      title: "Analytics tie",
      mdx: "# Analytics tie",
      status: "published" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: new Date(),
    },
    {
      id: "article_analytics_alpha_b",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-alpha-b",
      title: "Analytics tie",
      mdx: "# Analytics tie",
      status: "published" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: new Date(),
    },
    {
      id: "article_analytics_zulu",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-zulu",
      title: "Zulu analytics",
      mdx: "# Zulu analytics",
      status: "draft" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: null,
    },
  ];
  for (const article of analyticsArticles) {
    await createWorkflowArticle(harness,
      article,
      undefined,
      articleEvidence(article),
    );
  }

  const viewArticleIds = [
    demoIds.publishedArticle,
    demoIds.publishedArticle,
    "article_analytics_alpha",
    "article_analytics_alpha",
    "article_analytics_alpha_b",
    "article_analytics_alpha_b",
    "article_analytics_zulu",
    "article_analytics_zulu",
  ];
  const analyticsEventAt = new Date();
  for (const [index, articleId] of viewArticleIds.entries()) {
    await harness.repository.recordView({
      id: `analytics_view_${index}`,
      articleId,
      viewedAt: analyticsEventAt,
    });
  }

  const analyticsFeedback = [
    { id: "analytics_feedback_published_no", articleId: demoIds.publishedArticle, helpful: false },
    { id: "analytics_feedback_published_yes", articleId: demoIds.publishedArticle, helpful: true },
    { id: "analytics_feedback_alpha", articleId: "article_analytics_alpha", helpful: false },
    { id: "analytics_feedback_zulu_1", articleId: "article_analytics_zulu", helpful: true },
    { id: "analytics_feedback_zulu_2", articleId: "article_analytics_zulu", helpful: true },
    { id: "analytics_feedback_draft", articleId: demoIds.draftArticle, helpful: false },
  ];
  for (const feedback of analyticsFeedback) {
    await harness.repository.createFeedback({ ...feedback, createdAt: analyticsEventAt });
  }

  const expiredAnalyticsEventAt = new Date(Date.now() - 31 * dayInMilliseconds);
  await harness.repository.recordView({
    id: "analytics_view_expired",
    articleId: "article_analytics_alpha",
    viewedAt: expiredAnalyticsEventAt,
  });
  await harness.repository.createFeedback({
    id: "analytics_feedback_expired",
    articleId: "article_analytics_alpha",
    helpful: true,
    createdAt: expiredAnalyticsEventAt,
  });
  assert.deepEqual(await harness.relatedArticleRecords("article_analytics_alpha"), {
    feedback: 2,
    views: 3,
  });

  const isolationWorkspace = {
    id: "workspace_analytics_isolation",
    slug: "analytics-isolation",
    name: "Analytics isolation",
  };
  await harness.createWorkspace(isolationWorkspace);
  await createCategory(harness, {
    id: "category_analytics_isolation",
    workspaceId: isolationWorkspace.id,
    slug: "analytics",
    name: "Analytics",
    description: null,
    position: 0,
  });
  const isolationArticle = {
    id: "article_analytics_isolation",
    workspaceId: isolationWorkspace.id,
    categoryId: "category_analytics_isolation",
    slug: "analytics",
    title: "Isolation article",
    mdx: "# Isolation article",
    status: "published",
    isFaq: false,
    authorName: "OPAS",
    publishedAt: new Date(),
  } as const;
  await createWorkflowArticle(harness,
    isolationArticle,
    undefined,
    articleEvidence(isolationArticle, "analytics"),
  );
  for (let index = 0; index < 5; index += 1) {
    await harness.repository.recordView({
      id: `analytics_isolation_view_${index}`,
      articleId: "article_analytics_isolation",
      viewedAt: analyticsEventAt,
    });
  }
  await harness.repository.createFeedback({
    id: "analytics_isolation_feedback",
    articleId: "article_analytics_isolation",
    helpful: true,
    createdAt: analyticsEventAt,
  });

  const recentSearchDate = new Date(Date.now() - 29 * dayInMilliseconds);
  const searchGroups = [
    ["alpha query", 4],
    ["beta query", 4],
    ["charlie query", 3],
    ["delta query", 3],
    ["echo query", 2],
    ["foxtrot query", 2],
    ["golf query", 2],
    ["hotel query", 2],
    ["india query", 2],
    ["juliet query", 2],
    ["kilo query", 1],
    ["lima query", 1],
  ] as const;
  for (const [query, count] of searchGroups) {
    await recordSearchSamples(
      harness.repository,
      demoIds.workspace,
      query,
      count,
      recentSearchDate,
    );
  }
  await recordSearchSamples(
    harness.repository,
    isolationWorkspace.id,
    "isolated query",
    5,
    recentSearchDate,
  );
  await recordSearchSamples(
    harness.repository,
    demoIds.workspace,
    "expired analytics query",
    6,
    new Date(Date.now() - 31 * dayInMilliseconds),
  );

  const analytics = await harness.repository.getAnalytics(demoIds.workspace);
  assert.deepEqual(analytics.articles.slice(0, 4), [
    {
      articleId: demoIds.publishedArticle,
      title: "Runtime MDX in OPAS",
      status: "published",
      views: 3,
      feedbackCount: 3,
      helpfulCount: 2,
    },
    {
      articleId: "article_analytics_alpha",
      title: "Analytics tie",
      status: "published",
      views: 2,
      feedbackCount: 1,
      helpfulCount: 0,
    },
    {
      articleId: "article_analytics_alpha_b",
      title: "Analytics tie",
      status: "published",
      views: 2,
      feedbackCount: 0,
      helpfulCount: 0,
    },
    {
      articleId: "article_analytics_zulu",
      title: "Zulu analytics",
      status: "draft",
      views: 2,
      feedbackCount: 2,
      helpfulCount: 2,
    },
  ]);
  assert.deepEqual(
    analytics.articles
      .slice(4)
      .sort((left, right) => left.articleId.localeCompare(right.articleId)),
    demoContent.articles
      .filter((article) => article.id !== demoIds.publishedArticle)
      .map((article) => ({
        articleId: article.id,
        title: article.title,
        status: article.status,
        views: 0,
        feedbackCount: article.id === demoIds.draftArticle ? 1 : 0,
        helpfulCount: 0,
      }))
      .sort((left, right) => left.articleId.localeCompare(right.articleId)),
  );
  assert.deepEqual(analytics.searchMisses, [
    { query: "alpha query", count: 4 },
    { query: "beta query", count: 4 },
    { query: "charlie query", count: 3 },
    { query: "delta query", count: 3 },
    { query: "echo query", count: 2 },
    { query: "foxtrot query", count: 2 },
    { query: "golf query", count: 2 },
    { query: "hotel query", count: 2 },
    { query: "india query", count: 2 },
    { query: "juliet query", count: 2 },
  ]);

  assert.deepEqual(await harness.repository.getAnalytics(isolationWorkspace.id), {
    articles: [
      {
        articleId: "article_analytics_isolation",
        title: "Isolation article",
        status: "published",
        views: 5,
        feedbackCount: 1,
        helpfulCount: 1,
      },
    ],
    searchMisses: [{ query: "isolated query", count: 5 }],
  });

  const violations: RuleViolation[] = [
    "duplicateWorkspaceSlug",
    "duplicateCategorySlug",
    "duplicateArticleSlug",
    "duplicateWorkspaceTheme",
    "orphanFeedback",
    "orphanSearchMiss",
    "oversizedAsset",
    "invalidArticleStatus",
  ];
  for (const violation of violations) {
    await assert.rejects(
      harness.violate(violation),
      `${harness.name} accepted ${violation}`,
    );
  }

  await harness.deleteFixtureArticle(demoIds.publishedArticle);
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 0,
    views: 0,
  });

}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });

  try {
    await migratePostgres(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
    });
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  return {
    name: "Postgres",
    repository: createPostgresRepository(database),
    categoryAuthoring: createPostgresCategoryAuthoringRepository(database),
    themeAuthoring: createPostgresThemeAuthoringRepository(database),
    seed: () => seedPostgres(database),
    async authoringActor(workspaceId) {
      const actor = repositoryActor(workspaceId);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000);
      await pool.query(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) select $1, $2, 'repository@example.test', 'Repository author',
                  'administrator', 'active', $3, $4, 600000, $5, $5
           where not exists (select 1 from workspace_members where id = $1)`,
        [actor.memberId, workspaceId, "a".repeat(43), "b".repeat(43), createdAt],
      );
      await pool.query(
        `insert into admin_sessions (
           id, workspace_id, member_id, created_at, expires_at
         ) select $1, $2, $3, $4, $5
           where not exists (select 1 from admin_sessions where id = $1)`,
        [actor.sessionId, workspaceId, actor.memberId, createdAt, expiresAt],
      );
      return actor;
    },
    async createWorkspace(workspace) {
      await pool.query(
        "insert into workspaces (id, slug, name) values ($1, $2, $3)",
        [workspace.id, workspace.slug, workspace.name],
      );
    },
    async columns() {
      const result = await pool.query<{ table_name: TableName; column_name: string }>(
        `select table_name, column_name
         from information_schema.columns
         where table_schema = 'public' and table_name = any($1::text[])
         order by table_name, ordinal_position`,
        [tableNames],
      );
      const columns = tableNames.reduce<Record<TableName, string[]>>((result, table) => {
        result[table] = [];
        return result;
      }, {} as Record<TableName, string[]>);
      for (const row of result.rows) {
        columns[row.table_name].push(row.column_name);
      }
      return columns;
    },
    async counts() {
      const entries = await Promise.all(
        tableNames.map(async (table) => {
          const result = await pool.query<{ count: string }>(`select count(*) from ${table}`);
          return [table, Number(result.rows[0].count)] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<TableName, number>;
    },
    async feedback(id) {
      const result = await pool.query<{ helpful: boolean; comment: string | null }>(
        "select helpful, comment from article_feedback where id = $1",
        [id],
      );
      return result.rows[0] ?? null;
    },
    async relatedArticleRecords(articleId) {
      const [feedback, views] = await Promise.all([
        pool.query<{ count: string }>(
          "select count(*) from article_feedback where article_id = $1",
          [articleId],
        ),
        pool.query<{ count: string }>("select count(*) from article_views where article_id = $1", [
          articleId,
        ]),
      ]);
      return {
        feedback: Number(feedback.rows[0].count),
        views: Number(views.rows[0].count),
      };
    },
    async searchMissCount(id) {
      const result = await pool.query<{ count: string }>(
        "select count(*) from search_misses where id = $1",
        [id],
      );
      return Number(result.rows[0].count);
    },
    async assetCount() {
      const result = await pool.query<{ count: string }>("select count(*) from assets");
      return Number(result.rows[0].count);
    },
    async expireAssetManifest(id) {
      await pool.query(
        "update asset_manifests set expires_at = $1 where id = $2",
        [new Date(0), id],
      );
    },
    async deleteWorkspace(id) {
      await pool.query("delete from workspaces where id = $1", [id]);
    },
    async violate(rule) {
      const statements: Record<RuleViolation, [string, unknown[]]> = {
        duplicateWorkspaceSlug: [
          "insert into workspaces (id, slug, name) values ($1, $2, $3)",
          ["workspace_duplicate", demoContent.workspace.slug, "Duplicate"],
        ],
        duplicateCategorySlug: [
          "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
          [
            "category_duplicate",
            demoIds.workspace,
            demoContent.categories[0].slug,
            "Duplicate",
          ],
        ],
        duplicateArticleSlug: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            "article_duplicate",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            demoContent.articles[0].slug,
            "Duplicate",
            "# Duplicate",
          ],
        ],
        duplicateWorkspaceTheme: [
          "insert into themes (id, workspace_id, name, config) values ($1, $2, $3, $4::jsonb)",
          ["theme_duplicate", demoIds.workspace, "Duplicate", "{}"],
        ],
        orphanFeedback: [
          "insert into article_feedback (id, article_id, helpful) values ($1, $2, $3)",
          ["feedback_orphan", "article_missing", true],
        ],
        orphanSearchMiss: [
          "insert into search_misses (id, workspace_id, query) values ($1, $2, $3)",
          ["search_miss_orphan", "workspace_missing", "missing"],
        ],
        oversizedAsset: [
          `insert into assets
             (id, workspace_id, hash, media_type, byte_size, content)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            "asset_oversized",
            demoIds.workspace,
            "a".repeat(64),
            "image/png",
            1024 * 1024 + 1,
            new Uint8Array(1024 * 1024 + 1),
          ],
        ],
        invalidArticleStatus: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "article_invalid_status",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            "invalid-status",
            "Invalid",
            "# Invalid",
            "archived",
          ],
        ],
      };
      const [statement, parameters] = statements[rule];
      await pool.query(statement, parameters);
    },
    async deleteFixtureArticle(id) {
      await pool.query("delete from articles where id = $1", [id]);
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createLocalSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });

  try {
    migrateSqlite(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
    });
    assert.equal(client.pragma("foreign_keys", { simple: true }), 1);
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    name: "SQLite",
    repository: createSqliteRepository(database),
    categoryAuthoring: createSqliteCategoryAuthoringRepository(database),
    themeAuthoring: createSqliteThemeAuthoringRepository(database),
    seed: () => seedD1(database),
    async authoringActor(workspaceId) {
      const actor = repositoryActor(workspaceId);
      const createdAt = Date.now();
      const expiresAt = createdAt + 7 * 60 * 60 * 1000;
      client
        .prepare(
          `insert into workspace_members (
             id, workspace_id, normalized_email, display_name, role, status,
             password_salt, password_digest, password_iterations, created_at, updated_at
           ) select ?, ?, 'repository@example.test', 'Repository author',
                    'administrator', 'active', ?, ?, 600000, ?, ?
             where not exists (select 1 from workspace_members where id = ?)`,
        )
        .run(
          actor.memberId,
          workspaceId,
          "a".repeat(43),
          "b".repeat(43),
          createdAt,
          createdAt,
          actor.memberId,
        );
      client
        .prepare(
          `insert into admin_sessions (
             id, workspace_id, member_id, created_at, expires_at
           ) select ?, ?, ?, ?, ?
             where not exists (select 1 from admin_sessions where id = ?)`,
        )
        .run(
          actor.sessionId,
          workspaceId,
          actor.memberId,
          createdAt,
          expiresAt,
          actor.sessionId,
        );
      return actor;
    },
    async createWorkspace(workspace) {
      client
        .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
        .run(workspace.id, workspace.slug, workspace.name);
    },
    async columns() {
      const entries = tableNames.map((table) => {
        const rows = client.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
        return [table, rows.map((row) => row.name)] as const;
      });
      return Object.fromEntries(entries) as Record<TableName, string[]>;
    },
    async counts() {
      const entries = tableNames.map((table) => {
        const row = client.prepare(`select count(*) as count from ${table}`).get() as {
          count: number;
        };
        return [table, row.count] as const;
      });
      return Object.fromEntries(entries) as Record<TableName, number>;
    },
    async feedback(id) {
      const row = client
        .prepare("select helpful, comment from article_feedback where id = ?")
        .get(id) as { helpful: number; comment: string | null } | undefined;
      return row ? { helpful: row.helpful === 1, comment: row.comment } : null;
    },
    async relatedArticleRecords(articleId) {
      const feedback = client
        .prepare("select count(*) as count from article_feedback where article_id = ?")
        .get(articleId) as { count: number };
      const views = client
        .prepare("select count(*) as count from article_views where article_id = ?")
        .get(articleId) as { count: number };
      return { feedback: feedback.count, views: views.count };
    },
    async searchMissCount(id) {
      const row = client.prepare("select count(*) as count from search_misses where id = ?").get(id) as {
        count: number;
      };
      return row.count;
    },
    async assetCount() {
      const row = client.prepare("select count(*) as count from assets").get() as {
        count: number;
      };
      return row.count;
    },
    async expireAssetManifest(id) {
      client
        .prepare("update asset_manifests set expires_at = ? where id = ?")
        .run(0, id);
    },
    async deleteWorkspace(id) {
      client.prepare("delete from workspaces where id = ?").run(id);
    },
    async violate(rule) {
      const statements: Record<RuleViolation, [string, unknown[]]> = {
        duplicateWorkspaceSlug: [
          "insert into workspaces (id, slug, name) values (?, ?, ?)",
          ["workspace_duplicate", demoContent.workspace.slug, "Duplicate"],
        ],
        duplicateCategorySlug: [
          "insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)",
          [
            "category_duplicate",
            demoIds.workspace,
            demoContent.categories[0].slug,
            "Duplicate",
          ],
        ],
        duplicateArticleSlug: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx)
           values (?, ?, ?, ?, ?, ?)`,
          [
            "article_duplicate",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            demoContent.articles[0].slug,
            "Duplicate",
            "# Duplicate",
          ],
        ],
        duplicateWorkspaceTheme: [
          "insert into themes (id, workspace_id, name, config) values (?, ?, ?, ?)",
          ["theme_duplicate", demoIds.workspace, "Duplicate", "{}"],
        ],
        orphanFeedback: [
          "insert into article_feedback (id, article_id, helpful) values (?, ?, ?)",
          ["feedback_orphan", "article_missing", 1],
        ],
        orphanSearchMiss: [
          "insert into search_misses (id, workspace_id, query) values (?, ?, ?)",
          ["search_miss_orphan", "workspace_missing", "missing"],
        ],
        oversizedAsset: [
          `insert into assets
             (id, workspace_id, hash, media_type, byte_size, content)
           values (?, ?, ?, ?, ?, ?)`,
          [
            "asset_oversized",
            demoIds.workspace,
            "a".repeat(64),
            "image/png",
            1024 * 1024 + 1,
            new Uint8Array(1024 * 1024 + 1),
          ],
        ],
        invalidArticleStatus: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [
            "article_invalid_status",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            "invalid-status",
            "Invalid",
            "# Invalid",
            "archived",
          ],
        ],
      };
      const [statement, parameters] = statements[rule];
      client.prepare(statement).run(...parameters);
    },
    async deleteFixtureArticle(id) {
      client.prepare("delete from articles where id = ?").run(id);
    },
    async close() {
      client.close();
    },
  };
}

test("repository contract passes on Postgres", { timeout: 120_000 }, async () => {
  const harness = await createPostgresHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test("repository contract passes on local SQLite", async () => {
  const harness = await createLocalSqliteHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test("SQLite repository uses the native D1 client for atomic statement batches", async () => {
  type PreparedStatement = {
    sql: string;
    parameters: unknown[];
  };

  const preparedStatements: PreparedStatement[] = [];
  const batches: PreparedStatement[][] = [];
  const client = {
    prepare(sql: string) {
      return {
        bind(...parameters: unknown[]) {
          const statement = { sql, parameters };
          preparedStatements.push(statement);
          return statement;
        },
      };
    },
    async batch(statements: PreparedStatement[]) {
      batches.push([...statements]);
      return [];
    },
  } as unknown as AnyD1Database;
  const database = createD1Database(client, { schema: sqliteSchema });
  const repository = createSqliteRepository(database);
  const expiredAt = new Date("2026-08-30T12:00:00.000Z");

  await repository.cleanupAuthorizedExpiredAssets({
    checkedAt: expiredAt,
    memberId: "member_d1_batch",
    sessionId: "session_d1_batch",
    workspaceId: "workspace_d1_batch",
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 4);
  assert.deepEqual(batches[0], preparedStatements);
  assert.match(preparedStatements[0].sql, /workspace_authoring_assertions/u);
  assert.match(preparedStatements[1].sql, /workspace_members/u);
  assert.match(
    preparedStatements[2].sql,
    /delete from asset_manifests where workspace_id = \? and expires_at <= \?/,
  );
  assert.deepEqual(preparedStatements[2].parameters, [
    "workspace_d1_batch",
    expiredAt.getTime(),
  ]);
  assert.match(preparedStatements[3].sql, /delete from assets/);
  assert.deepEqual(preparedStatements[3].parameters, ["workspace_d1_batch"]);

  await repository.reserveAnswerInference(
    inferenceReservation(
      "workspace_d1_batch",
      "answer_lease_d1_batch",
      expiredAt,
    ),
  );
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 5);
  assert.match(batches[1][0]!.sql, /insert into workspace_inference_states/);
  assert.match(batches[1][1]!.sql, /update workspace_inference_states/);
  assert.match(batches[1][2]!.sql, /update answer_inference_leases/);
  assert.match(batches[1][3]!.sql, /limit 100/);
  assert.match(batches[1][4]!.sql, /insert into answer_inference_leases/);

  await repository.reconcileAnswerInference({
    id: "answer_lease_d1_batch",
    workspaceId: "workspace_d1_batch",
    chargedMicrodollars: 10,
    inputTokens: 20,
    outputTokens: 8,
    reconciledAt: new Date(expiredAt.getTime() + 1_000),
    status: "completed",
  });
  assert.equal(batches.length, 3);
  assert.equal(batches[2].length, 2);
  assert.match(batches[2][0]!.sql, /update answer_inference_leases/);
  assert.match(batches[2][1]!.sql, /select/);
});

test("Postgres repository keeps Neon admission work in one transaction batch", async () => {
  type Query = { statement: unknown };
  const batches: Query[][] = [];
  const database = {
    execute(statement: unknown) {
      return { statement };
    },
    async batch(queries: Query[]) {
      batches.push([...queries]);
      return queries.map(() => ({ rows: [] }));
    },
  };
  const repository = createPostgresAnswerInferenceRepository(database as never);
  const startedAt = new Date("2026-08-30T12:00:00.000Z");

  await repository.reserveAnswerInference(
    inferenceReservation(
      "workspace_neon_batch",
      "answer_lease_neon_batch",
      startedAt,
    ),
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 5);

  await repository.reconcileAnswerInference({
    id: "answer_lease_neon_batch",
    workspaceId: "workspace_neon_batch",
    chargedMicrodollars: 10,
    inputTokens: 20,
    outputTokens: 8,
    reconciledAt: new Date(startedAt.getTime() + 1_000),
    status: "completed",
  });
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 2);
});

test("SQLite bulk publication stays below D1 query and parameter ceilings", () => {
  const client = {
    prepare() {
      throw new Error("Publication planning must not execute D1 statements");
    },
  } as unknown as AnyD1Database;
  const database = createD1Database(client, { schema: sqliteSchema });
  const commits = Array.from({ length: 200 }, (_, index) => {
    const article = {
      id: `article_d1_bulk_${index}`,
      workspaceId: demoIds.workspace,
      categoryId: "category_d1_bulk",
      slug: `bulk-${index}`,
      title: `Bulk ${index}`,
      mdx: `# Bulk ${index}\n\nD1 bulk publication.`,
      status: "published" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: new Date("2026-08-30T12:00:00.000Z"),
    };
    const commit = articleEvidence(article, "bulk");
    assert.ok(commit);
    return commit;
  });
  const statements = sqliteArticleEvidenceCommitStatements(
    database,
    commits,
    new Date("2026-08-30T12:00:00.000Z"),
  );
  const queries = statements.map((statement) => database.run(statement).getQuery());

  assert.equal(queries.length, 8);
  assert.ok(queries.length <= 50);
  assert.ok(queries.every((query) => query.params.length <= 100));
  assert.ok(
    queries.every((query) => new TextEncoder().encode(query.sql).byteLength <= 100_000),
  );
});

test("SQLite evidence initialization stays below D1 statement ceilings", () => {
  const client = {
    prepare() {
      throw new Error("Evidence initialization planning must not execute D1 statements");
    },
  } as unknown as AnyD1Database;
  const database = createD1Database(client, { schema: sqliteSchema });
  const seeded = demoContent.articles.find(
    (article) => article.id === demoIds.publishedArticle,
  );
  assert.ok(seeded);
  const initializedAt = new Date("2026-08-30T12:00:00.000Z");
  const article = {
    ...seeded,
    publishedAt: seeded.publishedAt ? new Date(seeded.publishedAt) : null,
    categorySlug: "getting-started",
    updatedAt: initializedAt,
  };
  const evidence = articleEvidence(article, article.categorySlug);
  assert.ok(evidence);
  const queries = sqliteArticleEvidenceInitializationStatements(database, {
    article,
    evidence,
    initializedAt,
  }).map((statement) => database.run(statement).getQuery());

  assert.ok(queries.length <= 10);
  assert.ok(queries.every((query) => query.params.length <= 100));
  assert.ok(
    queries.every(
      (query) => new TextEncoder().encode(query.sql).byteLength <= 100_000,
    ),
  );
});

test("SQLite repository keeps local atomic statements in one Drizzle transaction", async () => {
  const client = new Database(":memory:");
  client.exec(`
    create table workspace_authoring_assertions (workspace_id text not null);
    create table workspace_members (
      id text primary key,
      workspace_id text not null,
      status text not null,
      role text not null
    );
    create table admin_sessions (
      id text primary key,
      workspace_id text not null,
      member_id text not null,
      revoked_at integer,
      expires_at integer not null
    );
    create table asset_manifests (
      id text primary key,
      workspace_id text not null,
      expires_at integer not null
    );
    create table assets (
      id text primary key,
      workspace_id text not null
    );
    create table article_assets (asset_id text not null);
    create table article_revision_assets (asset_id text not null);
    create table asset_manifest_items (asset_id text not null);
    insert into asset_manifests (id, workspace_id, expires_at)
      values ('manifest_local_batch', 'workspace_local_batch', 0);
    insert into assets (id, workspace_id)
      values ('asset_local_batch', 'workspace_local_batch');
    insert into workspace_members (id, workspace_id, status, role)
      values ('member_local_batch', 'workspace_local_batch', 'active', 'administrator');
    insert into admin_sessions (id, workspace_id, member_id, expires_at)
      values ('session_local_batch', 'workspace_local_batch', 'member_local_batch', 2);
  `);
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  const runTransaction = database.transaction.bind(database);
  let transactionCount = 0;
  database.transaction = ((transaction, config) => {
    transactionCount += 1;
    return runTransaction(transaction, config);
  }) as typeof database.transaction;

  try {
    await createSqliteRepository(database).cleanupAuthorizedExpiredAssets({
      checkedAt: new Date(1),
      memberId: "member_local_batch",
      sessionId: "session_local_batch",
      workspaceId: "workspace_local_batch",
    });

    assert.equal(transactionCount, 1);
    assert.equal(
      client.prepare("select count(*) as count from asset_manifests").pluck().get(),
      0,
    );
    assert.equal(
      client.prepare("select count(*) as count from assets").pluck().get(),
      0,
    );
  } finally {
    client.close();
  }
});

test("SQLite preserves populated v0.1 data through article evidence migration", () => {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");

  try {
    const migrationDirectory = path.join(process.cwd(), "drizzle/sqlite");
    client.transaction(() => {
      client.exec(readFileSync(path.join(migrationDirectory, "0000_cool_gertrude_yorkes.sql"), "utf8"));
    })();
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(demoIds.workspace, demoContent.workspace.slug, demoContent.workspace.name);
    client
      .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
      .run(
        demoIds.gettingStartedCategory,
        demoIds.workspace,
        demoContent.categories[0].slug,
        demoContent.categories[0].name,
      );
    client
      .prepare(
        `insert into articles
           (id, workspace_id, category_id, slug, title, mdx, status)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        demoIds.publishedArticle,
        demoIds.workspace,
        demoIds.gettingStartedCategory,
        demoContent.articles[0].slug,
        demoContent.articles[0].title,
        demoContent.articles[0].mdx,
        demoContent.articles[0].status,
      );
    client
      .prepare("insert into article_feedback (id, article_id, helpful) values (?, ?, ?)")
      .run("feedback_before_upgrade", demoIds.publishedArticle, 1);
    client
      .prepare("insert into article_views (id, article_id) values (?, ?)")
      .run("view_before_upgrade", demoIds.publishedArticle);

    client.transaction(() => {
      client.exec(
        readFileSync(path.join(migrationDirectory, "0001_opposite_centennial.sql"), "utf8"),
      );
    })();

    assert.equal(
      (client.prepare("select count(*) as count from article_feedback").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (client.prepare("select count(*) as count from article_views").get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
    assert.throws(() => {
      client
        .prepare(
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "article_invalid_after_upgrade",
          demoIds.workspace,
          demoIds.gettingStartedCategory,
          "invalid-after-upgrade",
          "Invalid",
          "# Invalid",
          "archived",
        );
    });

    client.transaction(() => {
      client.exec(readFileSync(path.join(migrationDirectory, "0002_tan_ezekiel.sql"), "utf8"));
    })();

    client.transaction(() => {
      client.exec(readFileSync(path.join(migrationDirectory, "0003_melted_bloodscream.sql"), "utf8"));
    })();
    client.transaction(() => {
      client.exec(readFileSync(path.join(migrationDirectory, "0004_lumpy_boomerang.sql"), "utf8"));
    })();

    assert.equal(
      (client
        .prepare("select position from articles where id = ?")
        .get(demoIds.publishedArticle) as { position: number }).position,
      0,
    );
    assert.equal(
      (client
        .prepare("select content_hash from articles where id = ?")
        .get(demoIds.publishedArticle) as { content_hash: string | null }).content_hash,
      null,
    );
    assert.throws(() =>
      client
        .prepare("update articles set content_hash = ? where id = ?")
        .run("invalid", demoIds.publishedArticle),
    );
    assert.equal(
      (client.prepare("select count(*) as count from article_feedback").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (client.prepare("select count(*) as count from evidence_chunks").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (client.prepare("select count(*) as count from article_views").get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
  } finally {
    client.close();
  }
});

test("Postgres preserves populated v0.1 data through article evidence migration", { timeout: 120_000 }, async () => {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  try {
    await applyPostgresMigration(pool, "0000_silly_johnny_blaze.sql");
    await applyPostgresMigration(pool, "0001_mysterious_bishop.sql");
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, $2, $3)",
      [demoIds.workspace, demoContent.workspace.slug, demoContent.workspace.name],
    );
    await pool.query(
      "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
      [
        demoIds.gettingStartedCategory,
        demoIds.workspace,
        demoContent.categories[0].slug,
        demoContent.categories[0].name,
      ],
    );
    await pool.query(
      `insert into articles
         (id, workspace_id, category_id, slug, title, mdx, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        demoIds.publishedArticle,
        demoIds.workspace,
        demoIds.gettingStartedCategory,
        demoContent.articles[0].slug,
        demoContent.articles[0].title,
        demoContent.articles[0].mdx,
        demoContent.articles[0].status,
      ],
    );
    await pool.query(
      "insert into article_feedback (id, article_id, helpful) values ($1, $2, $3)",
      ["feedback_before_asset_upgrade", demoIds.publishedArticle, true],
    );
    await pool.query(
      "insert into article_views (id, article_id) values ($1, $2)",
      ["view_before_asset_upgrade", demoIds.publishedArticle],
    );

    await applyPostgresMigration(pool, "0002_charming_dragon_lord.sql");
    await applyPostgresMigration(pool, "0003_harsh_goliath.sql");
    await applyPostgresMigration(pool, "0004_reflective_paladin.sql");

    assert.equal(
      (
        await pool.query<{ position: number }>(
          "select position from articles where id = $1",
          [demoIds.publishedArticle],
        )
      ).rows[0].position,
      0,
    );
    assert.equal(
      (
        await pool.query<{ content_hash: string | null }>(
          "select content_hash from articles where id = $1",
          [demoIds.publishedArticle],
        )
      ).rows[0].content_hash,
      null,
    );
    await assert.rejects(
      pool.query("update articles set content_hash = $1 where id = $2", [
        "invalid",
        demoIds.publishedArticle,
      ]),
      /articles_content_hash_check/u,
    );
    assert.equal(
      Number((await pool.query("select count(*) from article_feedback")).rows[0].count),
      1,
    );
    assert.equal(
      Number((await pool.query("select count(*) from article_views")).rows[0].count),
      1,
    );
    assert.equal(
      Number((await pool.query("select count(*) from asset_manifests")).rows[0].count),
      0,
    );
    assert.equal(
      Number((await pool.query("select count(*) from evidence_chunks")).rows[0].count),
      0,
    );
  } finally {
    await pool.end();
    await container.stop();
  }
});

test("Postgres authoring fence backfills, locks, and fails closed", { timeout: 120_000 }, async () => {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const workspaceId = "workspace_authoring_fence_postgres";

  try {
    for (const migration of postgresPreFenceMigrations) {
      await applyPostgresMigration(pool, migration);
    }
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, $2, $3)",
      [workspaceId, "authoring-fence-postgres", "Authoring fence"],
    );
    await pool.query(
      "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
      ["category_authoring_fence_existing", workspaceId, "existing", "Existing"],
    );

    await applyPostgresMigration(pool, "0010_workspace_authoring_controls.sql");

    assert.deepEqual(
      (
        await pool.query(
          `select workspace_id, writes_paused, generation, changed_by_member_id
           from workspace_authoring_controls
           where workspace_id = $1`,
          [workspaceId],
        )
      ).rows,
      [
        {
          workspace_id: workspaceId,
          writes_paused: false,
          generation: 0,
          changed_by_member_id: null,
        },
      ],
    );

    const guardTriggers = (
      await pool.query<{ table_name: string; trigger_name: string }>(
        `select tables.relname as table_name, triggers.tgname as trigger_name
         from pg_trigger triggers
         inner join pg_class tables on tables.oid = triggers.tgrelid
         inner join pg_namespace namespaces on namespaces.oid = tables.relnamespace
         where namespaces.nspname = 'public'
           and not triggers.tgisinternal
           and triggers.tgname like '%authoring_control%trigger'
         order by tables.relname, triggers.tgname`,
      )
    ).rows;
    assert.deepEqual(
      guardTriggers,
      [
        ...protectedAuthoringTables.map((table) => ({
          table_name: table,
          trigger_name: `${table}_authoring_control_trigger`,
        })),
        {
          table_name: "workspaces",
          trigger_name: "workspaces_authoring_control_delete_trigger",
        },
        {
          table_name: "workspaces",
          trigger_name: "workspaces_authoring_control_insert_trigger",
        },
      ].sort((left, right) =>
        `${left.table_name}:${left.trigger_name}`.localeCompare(
          `${right.table_name}:${right.trigger_name}`,
        ),
      ),
    );
    const assertionFunction = await pool.query<{ definition: string }>(
      `select pg_get_functiondef(
         'opas_assert_authoring_open(text)'::regprocedure
       ) as definition`,
    );
    assert.match(assertionFunction.rows[0].definition, /FOR SHARE/u);
    assert.match(assertionFunction.rows[0].definition, /AUTHORING_PAUSED/u);
    await pool.query("select opas_assert_authoring_open($1)", [workspaceId]);

    const freshWorkspaceId = "workspace_authoring_fence_fresh_postgres";
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, $2, $3)",
      [freshWorkspaceId, "authoring-fence-fresh-postgres", "Fresh fence"],
    );
    assert.deepEqual(
      (
        await pool.query(
          `select writes_paused, generation
           from workspace_authoring_controls
           where workspace_id = $1`,
          [freshWorkspaceId],
        )
      ).rows,
      [{ writes_paused: false, generation: 0 }],
    );

    await pool.query(
      "delete from workspace_authoring_controls where workspace_id = $1",
      [workspaceId],
    );
    await assert.rejects(
      pool.query("select opas_assert_authoring_open($1)", [workspaceId]),
      /AUTHORING_PAUSED/u,
    );
    await assert.rejects(
      pool.query(
        "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
        ["category_authoring_fence_missing", workspaceId, "missing", "Missing"],
      ),
      /AUTHORING_PAUSED/u,
    );
    await assert.rejects(
      pool.query("delete from workspaces where id = $1", [workspaceId]),
      /AUTHORING_PAUSED/u,
    );
    await pool.query(
      "insert into search_misses (id, workspace_id, query) values ($1, $2, $3)",
      ["search_authoring_fence_missing", workspaceId, "allowed while missing"],
    );

    await pool.query(
      `insert into workspace_authoring_controls
         (workspace_id, writes_paused, generation, changed_by_member_id)
       values ($1, false, 0, null)`,
      [workspaceId],
    );
    await pool.query("select opas_assert_authoring_open($1)", [workspaceId]);
    await pool.query(
      "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
      ["category_authoring_fence_open", workspaceId, "open", "Open"],
    );

    const writer = await pool.connect();
    const pauser = await pool.connect();
    let pauseUpdate: Promise<unknown> | undefined;
    try {
      await writer.query("begin");
      await writer.query(
        "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
        ["category_authoring_fence_drain", workspaceId, "drain", "Drain"],
      );
      await pauser.query("begin");
      const pauserPid = (
        await pauser.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0].pid;
      pauseUpdate = pauser.query(
        `update workspace_authoring_controls
         set writes_paused = true, generation = generation + 1
         where workspace_id = $1`,
        [workspaceId],
      );

      let pauseWaitedForLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool.query<{ wait_event_type: string | null }>(
          "select wait_event_type from pg_stat_activity where pid = $1",
          [pauserPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          pauseWaitedForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await writer.query("commit");
      await pauseUpdate;
      await pauser.query("commit");
      assert.equal(pauseWaitedForLock, true, "pause did not wait for the guarded writer");
    } catch (error) {
      await writer.query("rollback").catch(() => undefined);
      await pauseUpdate?.catch(() => undefined);
      await pauser.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      writer.release();
      pauser.release();
    }

    await assert.rejects(
      pool.query("select opas_assert_authoring_open($1)", [workspaceId]),
      /AUTHORING_PAUSED/u,
    );
    await assert.rejects(
      pool.query(
        "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
        ["category_authoring_fence_paused", workspaceId, "paused", "Paused"],
      ),
      /AUTHORING_PAUSED/u,
    );
    await assert.rejects(
      pool.query("update categories set name = $1 where id = $2", [
        "Paused update",
        "category_authoring_fence_open",
      ]),
      /AUTHORING_PAUSED/u,
    );
    await assert.rejects(
      pool.query("delete from categories where id = $1", [
        "category_authoring_fence_open",
      ]),
      /AUTHORING_PAUSED/u,
    );

    await pool.query(
      "insert into search_misses (id, workspace_id, query) values ($1, $2, $3)",
      ["search_authoring_fence_paused", workspaceId, "allowed while paused"],
    );
    await pool.query(
      "update search_misses set query = $1 where id = $2",
      ["still allowed while paused", "search_authoring_fence_paused"],
    );
    await pool.query(
      "delete from search_misses where id = $1",
      ["search_authoring_fence_paused"],
    );

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("begin");
      await rollbackClient.query(
        "insert into search_misses (id, workspace_id, query) values ($1, $2, $3)",
        ["search_authoring_fence_rollback", workspaceId, "must roll back"],
      );
      await assert.rejects(
        rollbackClient.query("update categories set name = $1 where id = $2", [
          "Must not persist",
          "category_authoring_fence_open",
        ]),
        /AUTHORING_PAUSED/u,
      );
      await rollbackClient.query("rollback");
    } finally {
      rollbackClient.release();
    }
    assert.equal(
      Number(
        (
          await pool.query(
            "select count(*) from search_misses where id = $1",
            ["search_authoring_fence_rollback"],
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await pool.query<{ name: string }>(
          "select name from categories where id = $1",
          ["category_authoring_fence_open"],
        )
      ).rows[0].name,
      "Open",
    );

    await pool.query(
      `update workspace_authoring_controls
       set writes_paused = true, generation = generation + 1
       where not writes_paused`,
    );
    await applyPostgresMigrationAtomically(pool, "0011_magical_loki.sql");
    await applyPostgresMigrationAtomically(pool, "0012_talented_lord_tyger.sql");
    await pool.query(
      `update workspace_authoring_controls
       set writes_paused = false, generation = generation + 1
       where workspace_id = $1`,
      [freshWorkspaceId],
    );

    await pool.query(
      `update workspace_authoring_controls
       set writes_paused = false, generation = generation + 1
       where workspace_id = $1`,
      [workspaceId],
    );
    await pool.query("select opas_assert_authoring_open($1)", [workspaceId]);
    await pool.query("update categories set name = $1 where id = $2", [
      "Resumed",
      "category_authoring_fence_open",
    ]);
    await pool.query("delete from categories where id = $1", [
      "category_authoring_fence_open",
    ]);
    await pool.query("delete from workspaces where id = $1", [freshWorkspaceId]);
    await pool.query("delete from workspaces where id = $1", [workspaceId]);
    assert.equal(
      Number(
        (
          await pool.query(
            "select count(*) from workspace_authoring_controls where workspace_id = any($1::text[])",
            [[freshWorkspaceId, workspaceId]],
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await pool.end();
    await container.stop();
  }
});

test("SQLite authoring fence backfills, asserts, and rolls back", async () => {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const workspaceId = "workspace_authoring_fence_sqlite";

  try {
    for (const migration of sqlitePreFenceMigrations) {
      applySqliteMigration(client, migration);
    }
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(workspaceId, "authoring-fence-sqlite", "Authoring fence");
    client
      .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
      .run("category_authoring_fence_existing", workspaceId, "existing", "Existing");

    applySqliteMigration(client, "0010_workspace_authoring_controls.sql");

    assert.deepEqual(
      client
        .prepare(
          `select workspace_id, writes_paused, generation, changed_by_member_id
           from workspace_authoring_controls
           where workspace_id = ?`,
        )
        .all(workspaceId),
      [
        {
          workspace_id: workspaceId,
          writes_paused: 0,
          generation: 0,
          changed_by_member_id: null,
        },
      ],
    );

    const guardTriggers = client
      .prepare(
        `select tbl_name as table_name, name as trigger_name, sql
         from sqlite_master
         where type = 'trigger' and name like '%authoring_control%trigger'
         order by tbl_name, name`,
      )
      .all() as Array<{ table_name: string; trigger_name: string; sql: string }>;
    assert.deepEqual(
      guardTriggers.map(({ table_name, trigger_name }) => ({ table_name, trigger_name })),
      [
        ...protectedAuthoringTables.flatMap((table) =>
          ["delete", "insert", "update"].map((operation) => ({
            table_name: table,
            trigger_name: `${table}_authoring_control_${operation}_trigger`,
          })),
        ),
        {
          table_name: "workspaces",
          trigger_name: "workspaces_authoring_control_delete_trigger",
        },
        {
          table_name: "workspaces",
          trigger_name: "workspaces_authoring_control_insert_trigger",
        },
      ].sort((left, right) =>
        `${left.table_name}:${left.trigger_name}`.localeCompare(
          `${right.table_name}:${right.trigger_name}`,
        ),
      ),
    );
    for (const trigger of guardTriggers.filter(
      ({ trigger_name }) =>
        trigger_name !== "workspaces_authoring_control_insert_trigger",
    )) {
      assert.match(trigger.sql, /AUTHORING_PAUSED/u);
    }
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from sqlite_master
             where type = 'trigger' and tbl_name = 'search_misses'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.deepEqual(
      client
        .prepare(
          `select type, name
           from sqlite_master
           where name in (
             'workspace_authoring_assertions',
             'workspace_authoring_assertions_insert_trigger'
           )
           order by type`,
        )
        .all(),
      [
        { type: "trigger", name: "workspace_authoring_assertions_insert_trigger" },
        { type: "view", name: "workspace_authoring_assertions" },
      ],
    );
    client
      .prepare("insert into workspace_authoring_assertions (workspace_id) values (?)")
      .run(workspaceId);
    assert.equal(
      (
        client
          .prepare("select count(*) as count from workspace_authoring_assertions")
          .get() as { count: number }
      ).count,
      0,
    );

    const freshWorkspaceId = "workspace_authoring_fence_fresh_sqlite";
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(freshWorkspaceId, "authoring-fence-fresh-sqlite", "Fresh fence");
    assert.deepEqual(
      client
        .prepare(
          `select writes_paused, generation
           from workspace_authoring_controls
           where workspace_id = ?`,
        )
        .all(freshWorkspaceId),
      [{ writes_paused: 0, generation: 0 }],
    );

    client
      .prepare("delete from workspace_authoring_controls where workspace_id = ?")
      .run(workspaceId);
    assert.throws(
      () =>
        client
          .prepare("insert into workspace_authoring_assertions (workspace_id) values (?)")
          .run(workspaceId),
      /AUTHORING_PAUSED/u,
    );
    assert.throws(
      () =>
        client
          .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
          .run("category_authoring_fence_missing", workspaceId, "missing", "Missing"),
      /AUTHORING_PAUSED/u,
    );
    assert.throws(
      () => client.prepare("delete from workspaces where id = ?").run(workspaceId),
      /AUTHORING_PAUSED/u,
    );
    client
      .prepare("insert into search_misses (id, workspace_id, query) values (?, ?, ?)")
      .run("search_authoring_fence_missing", workspaceId, "allowed while missing");

    client
      .prepare(
        `insert into workspace_authoring_controls
           (workspace_id, writes_paused, generation, changed_by_member_id)
         values (?, 0, 0, null)`,
      )
      .run(workspaceId);
    client
      .prepare("insert into workspace_authoring_assertions (workspace_id) values (?)")
      .run(workspaceId);
    client
      .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
      .run("category_authoring_fence_open", workspaceId, "open", "Open");

    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1
         where workspace_id = ?`,
      )
      .run(workspaceId);
    assert.throws(
      () =>
        client
          .prepare("insert into workspace_authoring_assertions (workspace_id) values (?)")
          .run(workspaceId),
      /AUTHORING_PAUSED/u,
    );
    assert.throws(
      () =>
        client
          .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
          .run("category_authoring_fence_paused", workspaceId, "paused", "Paused"),
      /AUTHORING_PAUSED/u,
    );
    assert.throws(
      () =>
        client
          .prepare("update categories set name = ? where id = ?")
          .run("Paused update", "category_authoring_fence_open"),
      /AUTHORING_PAUSED/u,
    );
    assert.throws(
      () =>
        client
          .prepare("delete from categories where id = ?")
          .run("category_authoring_fence_open"),
      /AUTHORING_PAUSED/u,
    );

    client
      .prepare("insert into search_misses (id, workspace_id, query) values (?, ?, ?)")
      .run("search_authoring_fence_paused", workspaceId, "allowed while paused");
    client
      .prepare("update search_misses set query = ? where id = ?")
      .run("still allowed while paused", "search_authoring_fence_paused");
    client
      .prepare("delete from search_misses where id = ?")
      .run("search_authoring_fence_paused");

    assert.throws(
      () =>
        client.transaction(() => {
          client
            .prepare("insert into search_misses (id, workspace_id, query) values (?, ?, ?)")
            .run("search_authoring_fence_rollback", workspaceId, "must roll back");
          client
            .prepare("update categories set name = ? where id = ?")
            .run("Must not persist", "category_authoring_fence_open");
        })(),
      /AUTHORING_PAUSED/u,
    );
    assert.equal(
      (
        client
          .prepare("select count(*) as count from search_misses where id = ?")
          .get("search_authoring_fence_rollback") as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        client
          .prepare("select name from categories where id = ?")
          .get("category_authoring_fence_open") as { name: string }
      ).name,
      "Open",
    );

    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1
         where writes_paused = 0`,
      )
      .run();
    applySqliteMigration(client, "0011_silly_green_goblin.sql");
    applySqliteMigration(client, "0012_aromatic_vin_gonzales.sql");
    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 0, generation = generation + 1
         where workspace_id = ?`,
      )
      .run(freshWorkspaceId);

    client
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 0, generation = generation + 1
         where workspace_id = ?`,
      )
      .run(workspaceId);
    client
      .prepare("insert into workspace_authoring_assertions (workspace_id) values (?)")
      .run(workspaceId);
    client
      .prepare("update categories set name = ? where id = ?")
      .run("Resumed", "category_authoring_fence_open");
    client
      .prepare("delete from categories where id = ?")
      .run("category_authoring_fence_open");
    client.prepare("delete from workspaces where id = ?").run(freshWorkspaceId);
    client.prepare("delete from workspaces where id = ?").run(workspaceId);
    assert.equal(
      (
        client
          .prepare(
            `select count(*) as count
             from workspace_authoring_controls
             where workspace_id in (?, ?)`,
          )
          .get(freshWorkspaceId, workspaceId) as { count: number }
      ).count,
      0,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
  } finally {
    client.close();
  }
});
