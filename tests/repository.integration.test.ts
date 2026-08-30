// ABOUTME: Runs one repository contract against migrated Postgres and local SQLite databases.
// ABOUTME: Verifies schema parity, preservation-safe seeds, constraints, reads, writes, and cascades.
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

import { demoContent, demoIds, demoSeededAt } from "@/db/demo";
import { createPostgresAnswerInferenceRepository } from "@/db/postgres/answer-inference-repository";
import { createPostgresRepository } from "@/db/postgres/repository";
import { seedPostgres } from "@/db/postgres/seed";
import type {
  AnswerInferenceReservation,
  ArticleEvidenceCommit,
  ArticleSubmission,
  KnowledgeImportArticle,
  Repository,
} from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import {
  articleEvidenceCommitStatements as sqliteArticleEvidenceCommitStatements,
  articleEvidenceInitializationStatements as sqliteArticleEvidenceInitializationStatements,
} from "@/db/sqlite/evidence-repository";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { seedD1 } from "@/db/sqlite/seed";
import { executeKnowledgeImport } from "@/import/execute";
import { planKnowledgeImport } from "@/import/planner";

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
  themes: ["id", "workspace_id", "name", "config", "created_at", "updated_at"],
  workspace_index_states: [
    "workspace_id",
    "generation",
    "active_embedding_generation_id",
    "updated_at",
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
  seed(): Promise<void>;
  deploymentSeed?(): Promise<void>;
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
  deleteArticle(id: string): Promise<void>;
  close(): Promise<void>;
};

const tableNames = Object.keys(expectedColumns) as TableName[];
const dayInMilliseconds = 86_400_000;
let evidenceJobSequence = 0;

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

function importArticle(
  id: string,
  categoryId: string,
  slug: string,
  position: number,
  assetHashes: readonly string[] = [],
  status: "draft" | "published" = "published",
): KnowledgeImportArticle {
  const title = `Import ${id}`;
  const article = {
    id,
    workspaceId: demoIds.workspace,
    categoryId,
    slug,
    title,
    mdx: `# ${title}\n`,
    status,
    isFaq: false,
    authorName: "Import operator",
    position,
    publishedAt: status === "published" ? new Date() : null,
    assetHashes,
  };
  return {
    ...article,
    evidence: articleEvidence(article),
  };
}

async function exerciseKnowledgeImport(harness: Harness) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  let baseline = await harness.counts();
  const successManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    expiresAt,
  );
  const referencedAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    successManifest.id,
    { mediaType: "image/png", content: importPng(1) },
  );
  const unreferencedAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    successManifest.id,
    { mediaType: "image/png", content: importPng(2) },
  );

  const successCategoryIds = ["category_import_later", "category_import_first"];
  const successArticleIds = [
    "article_import_later",
    "article_import_first",
    "article_import_draft",
  ];
  await harness.repository.activateKnowledgeImport({
    workspaceId: demoIds.workspace,
    manifestId: successManifest.id,
    categories: [
      {
        id: successCategoryIds[0],
        slug: "import-later",
        name: "Import later",
        description: null,
        position: 41,
      },
      {
        id: successCategoryIds[1],
        slug: "import-first",
        name: "Import first",
        description: null,
        position: 40,
      },
    ],
    articles: [
      importArticle(
        successArticleIds[0],
        successCategoryIds[1],
        "import-later",
        1,
        [referencedAsset.hash],
      ),
      importArticle(
        successArticleIds[1],
        successCategoryIds[1],
        "import-first",
        0,
      ),
      importArticle(
        successArticleIds[2],
        successCategoryIds[0],
        "import-draft",
        0,
        [],
        "draft",
      ),
    ],
  });

  assert.deepEqual(
    (await harness.repository.listCategories(demoIds.workspace))
      .filter((category) => successCategoryIds.includes(category.id))
      .map((category) => category.id),
    [successCategoryIds[1], successCategoryIds[0]],
    `${harness.name} did not preserve imported category ordering`,
  );
  assert.deepEqual(
    (await harness.repository.listPublishedArticles(demoIds.workspace))
      .filter((article) => successArticleIds.includes(article.id))
      .map((article) => article.id),
    [successArticleIds[1], successArticleIds[0]],
    `${harness.name} did not preserve imported article ordering`,
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      successArticleIds[0],
    ),
    [referencedAsset.hash],
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, unreferencedAsset.hash),
    null,
    `${harness.name} retained an unreferenced staged import asset`,
  );
  assert.equal((await harness.counts()).asset_manifests, baseline.asset_manifests);
  assert.equal(
    (await harness.repository.getIndexingState(demoIds.workspace))?.generation,
    1,
    `${harness.name} did not commit one generation for the whole import`,
  );
  assert.deepEqual(
    (await harness.repository.listEvidenceChunks(demoIds.workspace)).map(
      (chunk) => chunk.articleId,
    ),
    [successArticleIds[1], successArticleIds[0]],
    `${harness.name} did not publish imported evidence in article order`,
  );
  assert.ok(
    (await harness.repository.getArticle(demoIds.workspace, successArticleIds[0]))
      ?.contentHash,
  );
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, successArticleIds[2]))
      ?.contentHash,
    null,
  );

  for (const articleId of successArticleIds) {
    await harness.repository.deleteArticle(demoIds.workspace, articleId);
  }
  for (const categoryId of successCategoryIds) {
    assert.equal(
      await harness.repository.deleteCategory(demoIds.workspace, categoryId),
      true,
    );
  }
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, referencedAsset.hash),
    null,
  );
  const countsAfterImportCleanup = await harness.counts();
  assert.deepEqual(
    { ...countsAfterImportCleanup, workspace_index_states: baseline.workspace_index_states },
    baseline,
  );
  assert.equal(
    countsAfterImportCleanup.workspace_index_states,
    baseline.workspace_index_states + 1,
  );
  baseline = countsAfterImportCleanup;

  const plannedPng = importPng(3);
  const plannedImport = await planKnowledgeImport(
    [
      {
        path: "SUMMARY.md",
        content: new TextEncoder().encode(
          "# Summary\n\n## Planned docs\n\n* [Overview](README.md)\n* [Guide](guide.md)\n",
        ),
      },
      {
        path: "README.md",
        content: new TextEncoder().encode(
          "# Overview\n\n![Import diagram](diagram.png)\n",
        ),
      },
      {
        path: "guide.md",
        content: new TextEncoder().encode("# Guide\n\nImported guide.\n"),
      },
      { path: "diagram.png", content: plannedPng },
    ],
    { defaultStatus: "published", defaultAuthorName: "Plan operator" },
  );
  assert.equal(plannedImport.ready, true);
  await executeKnowledgeImport({
    repository: harness.repository,
    workspaceId: demoIds.workspace,
    plan: plannedImport,
  });
  const plannedCategorySlugs = new Set(
    plannedImport.categories.map((category) => category.slug),
  );
  const plannedArticleSlugs = new Set(
    plannedImport.articles.map((article) => article.slug),
  );
  const activatedCategories = (
    await harness.repository.listCategories(demoIds.workspace)
  ).filter((category) => plannedCategorySlugs.has(category.slug));
  const activatedArticles = (
    await harness.repository.listArticles(demoIds.workspace)
  ).filter((article) => plannedArticleSlugs.has(article.slug));
  assert.deepEqual(
    activatedCategories.map((category) => category.slug),
    plannedImport.categories.map((category) => category.slug),
  );
  assert.deepEqual(
    activatedArticles.map((article) => article.slug),
    plannedImport.articles.map((article) => article.slug),
  );
  assert.deepEqual(
    await harness.repository.listArticleAssetHashes(
      demoIds.workspace,
      activatedArticles.find(
        (article) => article.slug === plannedImport.articles[0].slug,
      )!.id,
    ),
    plannedImport.articles[0].assetHashes,
  );
  for (const article of activatedArticles) {
    await harness.repository.deleteArticle(demoIds.workspace, article.id);
  }
  for (const category of activatedCategories) {
    assert.equal(
      await harness.repository.deleteCategory(demoIds.workspace, category.id),
      true,
    );
  }
  assert.deepEqual(await harness.counts(), baseline);

  const failureCases = [
    {
      name: "existing slug",
      requestedHash: null,
      article: (hash: string) => [
        importArticle(
          "article_import_rollback_first",
          "category_import_rollback",
          "import-rollback-first",
          0,
          [hash],
        ),
        importArticle(
          "article_import_rollback_conflict",
          "category_import_rollback",
          demoContent.articles[0].slug,
          1,
        ),
      ],
    },
    {
      name: "missing category",
      requestedHash: null,
      article: (hash: string) => [
        importArticle(
          "article_import_missing_category",
          "category_import_missing",
          "import-missing-category",
          0,
          [hash],
        ),
      ],
    },
    {
      name: "missing asset",
      requestedHash: "f".repeat(64),
      article: (hash: string) => [
        importArticle(
          "article_import_missing_asset",
          "category_import_rollback",
          "import-missing-asset",
          0,
          [hash],
        ),
      ],
    },
  ] as const;

  for (const [index, failureCase] of failureCases.entries()) {
    const manifest = await harness.repository.createAssetManifest(
      demoIds.workspace,
      expiresAt,
    );
    const asset = await harness.repository.stageAsset(
      demoIds.workspace,
      manifest.id,
      { mediaType: "image/png", content: importPng(10 + index) },
    );
    const requestedHash = failureCase.requestedHash ?? asset.hash;
    await assert.rejects(
      harness.repository.activateKnowledgeImport({
        workspaceId: demoIds.workspace,
        manifestId: manifest.id,
        categories: [
          {
            id: "category_import_rollback",
            slug: `import-rollback-${index}`,
            name: `Import rollback ${index}`,
            description: null,
            position: 50,
          },
        ],
        articles: failureCase.article(requestedHash),
      }),
      `${harness.name} accepted an import with ${failureCase.name}`,
    );
    assert.deepEqual(
      await harness.counts(),
      baseline,
      `${harness.name} retained rows from an import with ${failureCase.name}`,
    );
    assert.equal(
      await harness.repository.getAsset(demoIds.workspace, asset.hash),
      null,
      `${harness.name} retained an orphan from an import with ${failureCase.name}`,
    );
  }
  assert.equal(
    (
      await harness.repository.getArticle(
        demoIds.workspace,
        demoIds.publishedArticle,
      )
    )?.title,
    demoContent.articles[0].title,
    `${harness.name} changed existing content during an import rollback`,
  );

  const expiredManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    expiresAt,
  );
  const expiredAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    expiredManifest.id,
    { mediaType: "image/png", content: importPng(20) },
  );
  await harness.expireAssetManifest(expiredManifest.id);
  await assert.rejects(
    harness.repository.activateKnowledgeImport({
      workspaceId: demoIds.workspace,
      manifestId: expiredManifest.id,
      categories: [
        {
          id: "category_import_expired",
          slug: "import-expired",
          name: "Import expired",
          description: null,
          position: 50,
        },
      ],
      articles: [
        importArticle(
          "article_import_expired",
          "category_import_expired",
          "import-expired",
          0,
          [expiredAsset.hash],
        ),
      ],
    }),
    `${harness.name} accepted an expired import manifest`,
  );
  assert.deepEqual(await harness.counts(), baseline);

  const foreignWorkspaceId = `workspace_import_foreign_${harness.name.toLocaleLowerCase("en-US")}`;
  await harness.createWorkspace({
    id: foreignWorkspaceId,
    slug: foreignWorkspaceId,
    name: "Import foreign workspace",
  });
  const foreignManifest = await harness.repository.createAssetManifest(
    foreignWorkspaceId,
    expiresAt,
  );
  const foreignAsset = await harness.repository.stageAsset(
    foreignWorkspaceId,
    foreignManifest.id,
    { mediaType: "image/png", content: importPng(21) },
  );
  await assert.rejects(
    harness.repository.activateKnowledgeImport({
      workspaceId: demoIds.workspace,
      manifestId: foreignManifest.id,
      categories: [
        {
          id: "category_import_cross_workspace",
          slug: "import-cross-workspace",
          name: "Import cross workspace",
          description: null,
          position: 50,
        },
      ],
      articles: [
        importArticle(
          "article_import_cross_workspace",
          "category_import_cross_workspace",
          "import-cross-workspace",
          0,
          [foreignAsset.hash],
        ),
      ],
    }),
    `${harness.name} accepted another workspace's import manifest`,
  );
  assert.ok(
    await harness.repository.getAsset(foreignWorkspaceId, foreignAsset.hash),
    `${harness.name} deleted another workspace's staged import asset`,
  );
  assert.equal(
    (await harness.repository.listCategories(demoIds.workspace)).some(
      (category) => category.id === "category_import_cross_workspace",
    ),
    false,
  );
  await harness.repository.discardAssetManifest(
    foreignWorkspaceId,
    foreignManifest.id,
  );
  await harness.deleteWorkspace(foreignWorkspaceId);
  assert.deepEqual(await harness.counts(), baseline);
}

async function exerciseSeedRerun(
  harness: Harness,
  seed: () => Promise<void>,
  label: string,
) {
  const draft = await harness.repository.getArticle(
    demoIds.workspace,
    demoIds.draftArticle,
  );
  assert.ok(draft);
  await harness.repository.updateArticle(
    {
      id: draft.id,
      workspaceId: draft.workspaceId,
      categoryId: draft.categoryId,
      slug: draft.slug,
      title: `${label} article edit`,
      mdx: draft.mdx,
      status: draft.status,
      isFaq: draft.isFaq,
      authorName: draft.authorName,
      position: 9,
      publishedAt: draft.publishedAt,
    },
    undefined,
    null,
  );

  const theme = await harness.repository.getTheme(demoIds.workspace);
  assert.ok(theme);
  await harness.repository.updateTheme({
    workspaceId: demoIds.workspace,
    name: `${label} theme edit`,
    config: theme.config,
  });

  await harness.repository.deleteArticle(demoIds.workspace, demoIds.publishedArticle);
  assert.equal(
    await harness.repository.deleteCategory(
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    true,
  );

  await seed();

  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, demoIds.draftArticle))
      ?.title,
    `${label} article edit`,
    `${harness.name} ${label} replaced an administrator article edit`,
  );
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, demoIds.draftArticle))
      ?.position,
    9,
    `${harness.name} ${label} replaced administrator article order`,
  );
  assert.equal(
    (await harness.repository.getTheme(demoIds.workspace))?.name,
    `${label} theme edit`,
    `${harness.name} ${label} replaced an administrator theme edit`,
  );
  assert.deepEqual(
    (await harness.repository.listCategories(demoIds.workspace)).find(
      (category) => category.id === demoIds.gettingStartedCategory,
    ),
    {
      id: demoContent.categories[0].id,
      workspaceId: demoContent.categories[0].workspaceId,
      slug: demoContent.categories[0].slug,
      name: demoContent.categories[0].name,
      description: demoContent.categories[0].description,
      position: demoContent.categories[0].position,
    },
    `${harness.name} ${label} did not restore a missing seed category`,
  );

  const restoredArticle = await harness.repository.getArticle(
    demoIds.workspace,
    demoIds.publishedArticle,
  );
  assert.ok(restoredArticle, `${harness.name} ${label} did not restore a missing seed article`);
  assert.equal(restoredArticle.title, demoContent.articles[0].title);
  assert.equal(restoredArticle.createdAt.toISOString(), demoSeededAt);
}

async function exerciseSeedSlugConflicts(
  harness: Harness,
  seed: () => Promise<void>,
  label: string,
) {
  const replacementCategoryId = "category_seed_slug_replacement";
  const replacementArticleId = "article_seed_slug_replacement";
  const foreignWorkspaceId = `workspace_seed_parent_${label.replaceAll(" ", "_")}`;

  await harness.repository.deleteArticle(demoIds.workspace, demoIds.publishedArticle);
  assert.equal(
    await harness.repository.deleteCategory(
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    true,
  );
  await harness.repository.createCategory({
    ...demoContent.categories[0],
    id: replacementCategoryId,
    name: `${label} replacement category`,
  });

  await seed();

  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, demoIds.publishedArticle),
    null,
    `${harness.name} ${label} seeded an article without its fixed category parent`,
  );

  const replacementArticle = {
    ...demoContent.articles[0],
    id: replacementArticleId,
    categoryId: replacementCategoryId,
    title: `${label} replacement article`,
    publishedAt: new Date(demoContent.articles[0].publishedAt!),
  };
  await harness.repository.createArticle(
    replacementArticle,
    undefined,
    articleEvidence(replacementArticle, "getting-started"),
  );

  await seed();

  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, demoIds.publishedArticle),
    null,
    `${harness.name} ${label} restored an article whose slug belongs to another record`,
  );
  assert.equal(
    (
      await harness.repository.getArticle(demoIds.workspace, replacementArticleId)
    )?.slug,
    demoContent.articles[0].slug,
  );
  assert.equal(
    (await harness.repository.listCategories(demoIds.workspace)).some(
      (category) => category.id === demoIds.gettingStartedCategory,
    ),
    false,
    `${harness.name} ${label} restored a category whose slug belongs to another record`,
  );

  await harness.repository.deleteArticle(demoIds.workspace, replacementArticleId);
  assert.equal(
    await harness.repository.deleteCategory(demoIds.workspace, replacementCategoryId),
    true,
  );
  await seed();

  await harness.repository.deleteArticle(demoIds.workspace, demoIds.publishedArticle);
  assert.equal(
    await harness.repository.deleteCategory(
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    true,
  );
  await harness.createWorkspace({
    id: foreignWorkspaceId,
    slug: foreignWorkspaceId,
    name: `${label} foreign workspace`,
  });
  await harness.repository.createCategory({
    ...demoContent.categories[0],
    workspaceId: foreignWorkspaceId,
  });

  await seed();

  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, demoIds.publishedArticle),
    null,
    `${harness.name} ${label} seeded an article beneath another workspace's category`,
  );
  assert.equal(
    await harness.repository.deleteCategory(
      foreignWorkspaceId,
      demoIds.gettingStartedCategory,
    ),
    true,
  );
  await seed();
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
  await harness.seed();
  await harness.seed();

  assert.deepEqual(await harness.columns(), expectedColumns, `${harness.name} schema drifted`);
  assert.deepEqual(await harness.counts(), {
    answer_inference_leases: 0,
    article_feedback: 0,
    article_assets: 0,
    article_views: 0,
    articles: 2,
    asset_manifest_items: 0,
    asset_manifests: 0,
    assets: 0,
    categories: 2,
    chunk_embeddings: 0,
    embedding_generations: 0,
    embedding_jobs: 0,
    evaluation_runs: 0,
    evidence_chunks: 0,
    saved_question_sets: 0,
    search_misses: 0,
    support_handoffs: 0,
    themes: 1,
    workspace_index_states: 0,
    workspace_inference_states: 0,
    workspaces: 1,
  });

  if (harness.deploymentSeed) {
    await harness.deploymentSeed();
    await harness.deploymentSeed();
    assert.deepEqual(await harness.counts(), {
      answer_inference_leases: 0,
      article_feedback: 0,
      article_assets: 0,
      article_views: 0,
      articles: 2,
      asset_manifest_items: 0,
      asset_manifests: 0,
      assets: 0,
      categories: 2,
      chunk_embeddings: 0,
      embedding_generations: 0,
      embedding_jobs: 0,
      evaluation_runs: 0,
      evidence_chunks: 0,
      saved_question_sets: 0,
      search_misses: 0,
      support_handoffs: 0,
      themes: 1,
      workspace_index_states: 0,
      workspace_inference_states: 0,
      workspaces: 1,
    });
  }

  await harness.repository.checkHealth();
  await exerciseAnswerInferenceAdmission(harness);
  await exerciseKnowledgeImport(harness);

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
      demoContent.articles[1].slug,
    ),
    null,
    `${harness.name} exposed a draft article`,
  );
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, "missing-article"),
    null,
  );

  const publishedArticles = await harness.repository.listPublishedArticles(demoIds.workspace);
  assert.equal(publishedArticles.length, 1, `${harness.name} included drafts in public listings`);
  assert.equal(publishedArticles[0].id, demoIds.publishedArticle);

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
  await harness.repository.createCategory(contractCategory);
  assert.deepEqual(
    (await harness.repository.listCategories(demoIds.workspace)).map((category) => category.id),
    [
      demoIds.gettingStartedCategory,
      contractCategory.id,
      demoIds.customizationCategory,
    ],
    `${harness.name} did not order equal-position categories by id`,
  );

  await harness.repository.updateCategory({
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
  });
  assert.deepEqual((await harness.repository.listCategories(demoIds.workspace))[0], {
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
  });

  assert.equal(
    await harness.repository.deleteCategory(
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    false,
    `${harness.name} deleted a category that still contained articles`,
  );

  await harness.repository.updateCategory({
    ...contractCategory,
    workspaceId: "workspace_missing",
    name: "Wrong workspace",
  });
  assert.equal(
    (await harness.repository.listCategories(demoIds.workspace))[0].name,
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
  await harness.repository.createArticle(contractArticle, undefined, null);

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
    await harness.repository.createArticle({
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
  await harness.repository.deleteArticle(demoIds.workspace, "article_position_alpha");
  await harness.repository.deleteArticle(demoIds.workspace, "article_position_zulu");
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, contractArticle.slug),
    null,
    `${harness.name} exposed an admin-created draft`,
  );

  const contractPublishedAt = new Date("2026-02-03T04:05:06.000Z");
  const publishedContractArticle = {
    ...contractArticle,
    title: "Published repository contract",
    status: "published",
    publishedAt: contractPublishedAt,
  } as const;
  const publishedContractEvidence = articleEvidence(publishedContractArticle);
  assert.ok(publishedContractEvidence);
  await harness.repository.updateArticle(
    publishedContractArticle,
    undefined,
    publishedContractEvidence,
  );

  const updatedArticle = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(updatedArticle);
  assert.equal(updatedArticle.contentHash, publishedContractEvidence.articleContentHash);
  assert.equal(updatedArticle.status, "published");
  assert.equal(updatedArticle.title, "Published repository contract");
  assert.equal(updatedArticle.position, 7);
  assert.equal(updatedArticle.publishedAt?.toISOString(), contractPublishedAt.toISOString());
  assert.equal(updatedArticle.createdAt.toISOString(), contractCreatedAt.toISOString());
  assert.ok(updatedArticle.updatedAt.getTime() >= contractUpdatedAt.getTime());
  assert.ok(
    (await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} omitted a newly published article from the public listing`,
  );
  assert.equal(
    await harness.repository.updateCategory({
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
    harness.repository.updateArticle(
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
  assert.deepEqual(
    (await harness.repository.listPublishedArticles(demoIds.workspace)).map(
      (article) => article.id,
    ),
    [contractArticle.id, demoIds.publishedArticle],
  );

  const listedArticles = await harness.repository.listArticles(demoIds.workspace);
  assert.deepEqual(
    listedArticles.map((article) => [article.title, article.status]),
    [
      ["Published repository contract", "published"],
      [demoContent.articles[0].title, "published"],
      [demoContent.articles[1].title, "draft"],
    ],
  );

  await harness.repository.updateArticle(
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

  const assetContent = new Uint8Array(1024 * 1024).fill(7);
  assetContent.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const assetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const firstManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const duplicateManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const firstAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    firstManifest.id,
    { mediaType: "image/png", content: assetContent },
  );
  const duplicateAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    duplicateManifest.id,
    { mediaType: "image/png", content: assetContent },
  );

  assert.equal(firstAsset.hash, duplicateAsset.hash);
  assert.equal(firstAsset.byteSize, 1024 * 1024);
  assert.deepEqual(
    (await harness.repository.getAsset(demoIds.workspace, firstAsset.hash))?.content,
    assetContent,
  );
  assert.equal(
    await harness.repository.getPublishedAsset(demoIds.workspace, firstAsset.hash),
    null,
    `${harness.name} exposed a staged asset publicly`,
  );
  assert.equal(await harness.assetCount(), 1, `${harness.name} did not deduplicate an asset`);

  await harness.repository.discardAssetManifest(
    demoIds.workspace,
    duplicateManifest.id,
  );
  assert.equal(await harness.assetCount(), 1);

  const attachedContractEvidence = articleEvidence(publishedContractArticle);
  assert.ok(attachedContractEvidence);
  await harness.repository.updateArticle(
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
  await harness.repository.updateArticle(draftContractArticle, undefined, null);
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
    (
      await harness.repository.getEmbeddingJob(
        demoIds.workspace,
        attachedContractEvidence.job.id,
      )
    )?.status,
    "superseded",
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
  await harness.repository.updateArticle(
    republishedContractArticle,
    undefined,
    articleEvidence(republishedContractArticle),
  );
  let attachedAssetHash = firstAsset.hash;

  const retryAssetContent = importPng(31);
  const failedUpdateManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const failedUpdateAsset = await harness.repository.stageAsset(
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
    harness.repository.updateArticle(
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

  const retryManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const retryAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    retryManifest.id,
    { mediaType: "image/png", content: retryAssetContent },
  );
  assert.equal(retryAsset.hash, failedUpdateAsset.hash);
  await harness.repository.updateArticle(
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
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, firstAsset.hash),
    null,
    `${harness.name} retained the replaced article asset`,
  );

  const oversizedManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const oversizedAsset = new Uint8Array(1024 * 1024 + 1);
  oversizedAsset.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    harness.repository.stageAsset(demoIds.workspace, oversizedManifest.id, {
      mediaType: "image/png",
      content: oversizedAsset,
    }),
    /1 MiB or smaller/,
  );
  await assert.rejects(
    harness.repository.stageAsset(demoIds.workspace, oversizedManifest.id, {
      mediaType: "image/png",
      content: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    }),
    /does not match its media type/,
  );
  await harness.repository.discardAssetManifest(
    demoIds.workspace,
    oversizedManifest.id,
  );
  assert.equal(await harness.assetCount(), 1);
  await assert.rejects(
    harness.repository.stageAsset(demoIds.workspace, "asset_manifest_missing", {
      mediaType: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }),
  );
  assert.equal(
    await harness.assetCount(),
    1,
    `${harness.name} retained an asset from an unauthenticated manifest`,
  );

  const failedManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const failedAsset = await harness.repository.stageAsset(
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
    harness.repository.createArticle(
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

  const cancelledManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const cancelledAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    cancelledManifest.id,
    {
      mediaType: "image/gif",
      content: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    },
  );
  await harness.repository.discardAssetManifest(
    demoIds.workspace,
    cancelledManifest.id,
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, cancelledAsset.hash),
    null,
  );

  const expiringManifest = await harness.repository.createAssetManifest(
    demoIds.workspace,
    assetExpiresAt,
  );
  const expiredAsset = await harness.repository.stageAsset(
    demoIds.workspace,
    expiringManifest.id,
    { mediaType: "image/jpeg", content: new Uint8Array([0xff, 0xd8, 0xff]) },
  );
  await harness.repository.cleanupExpiredAssets(
    demoIds.workspace,
    new Date(assetExpiresAt.getTime() + 1),
  );
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, expiredAsset.hash),
    null,
  );
  assert.equal(await harness.assetCount(), 1);

  const attachedArticleBeforeRejectedUpdate = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(attachedArticleBeforeRejectedUpdate);
  await assert.rejects(
    harness.repository.updateArticle(
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

  await harness.repository.updateArticle(
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
  assert.equal(
    await harness.repository.getAsset(demoIds.workspace, attachedAssetHash),
    null,
    `${harness.name} retained an orphan after removing the final attachment`,
  );

  await harness.repository.deleteArticle("workspace_missing", contractArticle.id);
  assert.ok(await harness.repository.getArticle(demoIds.workspace, contractArticle.id));
  await harness.repository.deleteArticle(demoIds.workspace, contractArticle.id);
  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, contractArticle.id),
    null,
  );
  assert.equal(await harness.assetCount(), 0, `${harness.name} retained a deleted article asset`);
  assert.ok(
    !(await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} retained a deleted article in the public listing`,
  );

  assert.equal(
    await harness.repository.deleteCategory("workspace_missing", contractCategory.id),
    false,
  );
  assert.ok(
    (await harness.repository.listCategories(demoIds.workspace)).some(
      (category) => category.id === contractCategory.id,
    ),
  );
  assert.equal(
    await harness.repository.deleteCategory(demoIds.workspace, contractCategory.id),
    true,
  );
  assert.ok(
    !(await harness.repository.listCategories(demoIds.workspace)).some(
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
  await harness.repository.updateTheme({
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
      mdx: "# Analytics alpha",
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
      mdx: "# Analytics alpha B",
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
      mdx: "# Analytics zulu",
      status: "draft" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: null,
    },
  ];
  for (const article of analyticsArticles) {
    await harness.repository.createArticle(
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
  await harness.repository.createCategory({
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
    mdx: "# Isolation",
    status: "published",
    isFaq: false,
    authorName: "OPAS",
    publishedAt: new Date(),
  } as const;
  await harness.repository.createArticle(
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
  assert.deepEqual(analytics.articles, [
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
    {
      articleId: demoIds.draftArticle,
      title: "Customize your help center",
      status: "draft",
      views: 0,
      feedbackCount: 1,
      helpfulCount: 0,
    },
  ]);
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

  await harness.deleteArticle(demoIds.publishedArticle);
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 0,
    views: 0,
  });

  await exerciseSeedRerun(harness, harness.seed, "repository seed");
  await exerciseSeedSlugConflicts(harness, harness.seed, "repository seed");
  if (harness.deploymentSeed) {
    await exerciseSeedRerun(harness, harness.deploymentSeed, "deployment seed");
    await exerciseSeedSlugConflicts(harness, harness.deploymentSeed, "deployment seed");
  }
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
    seed: () => seedPostgres(database),
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
    async deleteArticle(id) {
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
    seed: () => seedD1(database),
    async createWorkspace(workspace) {
      client
        .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
        .run(workspace.id, workspace.slug, workspace.name);
    },
    async deploymentSeed() {
      client.exec(readFileSync(path.join(process.cwd(), "scripts/seed-d1.sql"), "utf8"));
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
    async deleteArticle(id) {
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

  await repository.cleanupExpiredAssets("workspace_d1_batch", expiredAt);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.deepEqual(batches[0], preparedStatements);
  assert.match(
    preparedStatements[0].sql,
    /delete from asset_manifests where workspace_id = \? and expires_at <= \?/,
  );
  assert.deepEqual(preparedStatements[0].parameters, [
    "workspace_d1_batch",
    expiredAt.getTime(),
  ]);
  assert.match(preparedStatements[1].sql, /delete from assets/);
  assert.deepEqual(preparedStatements[1].parameters, ["workspace_d1_batch"]);

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
    create table asset_manifest_items (asset_id text not null);
    insert into asset_manifests (id, workspace_id, expires_at)
      values ('manifest_local_batch', 'workspace_local_batch', 0);
    insert into assets (id, workspace_id)
      values ('asset_local_batch', 'workspace_local_batch');
  `);
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  const runTransaction = database.transaction.bind(database);
  let transactionCount = 0;
  database.transaction = ((transaction, config) => {
    transactionCount += 1;
    return runTransaction(transaction, config);
  }) as typeof database.transaction;

  try {
    await createSqliteRepository(database).cleanupExpiredAssets(
      "workspace_local_batch",
      new Date(1),
    );

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
