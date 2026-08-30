// ABOUTME: Defines the OPAS relational model for Postgres and Neon deployments.
// ABOUTME: Keeps table and column names aligned with the SQLite/D1 schema.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const binary = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

const timestampColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ...timestampColumns,
});

export const categories = pgTable(
  "categories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("categories_workspace_slug_unique").on(table.workspaceId, table.slug),
    index("categories_workspace_position_index").on(table.workspaceId, table.position),
  ],
);

export const articles = pgTable(
  "articles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    mdx: text("mdx").notNull(),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    isFaq: boolean("is_faq").notNull().default(false),
    authorName: text("author_name").notNull().default("OPAS"),
    position: integer("position").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("articles_workspace_slug_unique").on(table.workspaceId, table.slug),
    uniqueIndex("articles_id_workspace_unique").on(table.id, table.workspaceId),
    index("articles_category_status_index").on(table.categoryId, table.status),
    check("articles_status_check", sql`${table.status} in ('draft', 'published')`),
  ],
);

export const assetManifests = pgTable(
  "asset_manifests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_manifests_id_workspace_unique").on(table.id, table.workspaceId),
    index("asset_manifests_workspace_expires_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    mediaType: text("media_type", {
      enum: ["image/gif", "image/jpeg", "image/png", "image/webp"],
    }).notNull(),
    byteSize: integer("byte_size").notNull(),
    content: binary("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("assets_workspace_hash_unique").on(table.workspaceId, table.hash),
    uniqueIndex("assets_id_workspace_unique").on(table.id, table.workspaceId),
    check("assets_hash_length_check", sql`length(${table.hash}) = 64`),
    check(
      "assets_media_type_check",
      sql`${table.mediaType} in ('image/gif', 'image/jpeg', 'image/png', 'image/webp')`,
    ),
    check(
      "assets_byte_size_check",
      sql`${table.byteSize} between 1 and 1048576`,
    ),
    check(
      "assets_content_size_check",
      sql`octet_length(${table.content}) = ${table.byteSize}`,
    ),
  ],
);

export const assetManifestItems = pgTable(
  "asset_manifest_items",
  {
    manifestId: text("manifest_id").notNull(),
    assetId: text("asset_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.manifestId, table.assetId] }),
    foreignKey({
      columns: [table.manifestId, table.workspaceId],
      foreignColumns: [assetManifests.id, assetManifests.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId, table.workspaceId],
      foreignColumns: [assets.id, assets.workspaceId],
    }).onDelete("cascade"),
    index("asset_manifest_items_asset_index").on(table.assetId),
  ],
);

export const articleAssets = pgTable(
  "article_assets",
  {
    articleId: text("article_id").notNull(),
    assetId: text("asset_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.assetId] }),
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId, table.workspaceId],
      foreignColumns: [assets.id, assets.workspaceId],
    }).onDelete("cascade"),
    index("article_assets_asset_index").on(table.assetId),
  ],
);

export const embeddingGenerations = pgTable(
  "embedding_generations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimension: integer("dimension").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    status: text("status", {
      enum: ["building", "active", "retired", "failed"],
    })
      .notNull()
      .default("building"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("embedding_generations_id_workspace_unique").on(
      table.id,
      table.workspaceId,
    ),
    index("embedding_generations_workspace_status_index").on(
      table.workspaceId,
      table.status,
    ),
    check(
      "embedding_generations_dimension_check",
      sql`${table.dimension} between 1 and 4096`,
    ),
    check(
      "embedding_generations_configuration_hash_check",
      sql`length(${table.configurationHash}) = 64`,
    ),
    check(
      "embedding_generations_status_check",
      sql`${table.status} in ('building', 'active', 'retired', 'failed')`,
    ),
  ],
);

export const workspaceIndexStates = pgTable(
  "workspace_index_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull().default(0),
    activeEmbeddingGenerationId: text("active_embedding_generation_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.activeEmbeddingGenerationId, table.workspaceId],
      foreignColumns: [embeddingGenerations.id, embeddingGenerations.workspaceId],
    }).onDelete("cascade"),
    check("workspace_index_states_generation_check", sql`${table.generation} >= 0`),
  ],
);

export const evidenceChunks = pgTable(
  "evidence_chunks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    articleId: text("article_id").notNull(),
    articleContentHash: text("article_content_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    embeddingInputHash: text("embedding_input_hash").notNull(),
    indexGeneration: integer("index_generation").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    headingPath: jsonb("heading_path").$type<readonly string[]>().notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    markdown: text("markdown").notNull(),
    evidenceText: text("evidence_text").notNull(),
    embeddingText: text("embedding_text").notNull(),
    sourceLineStart: integer("source_line_start").notNull(),
    sourceLineEnd: integer("source_line_end").notNull(),
    publicationState: text("publication_state", { enum: ["published"] })
      .notNull()
      .default("published"),
    ...timestampColumns,
  },
  (table) => [
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("evidence_chunks_identity_unique").on(
      table.id,
      table.workspaceId,
      table.contentHash,
      table.embeddingInputHash,
    ),
    uniqueIndex("evidence_chunks_article_ordinal_unique").on(
      table.workspaceId,
      table.articleId,
      table.ordinal,
    ),
    index("evidence_chunks_workspace_generation_index").on(
      table.workspaceId,
      table.indexGeneration,
    ),
    check(
      "evidence_chunks_hashes_check",
      sql`length(${table.articleContentHash}) = 64 and length(${table.contentHash}) = 64 and length(${table.embeddingInputHash}) = 64`,
    ),
    check(
      "evidence_chunks_position_check",
      sql`${table.indexGeneration} >= 1 and ${table.ordinal} >= 0 and ${table.sourceLineStart} >= 1 and ${table.sourceLineEnd} >= ${table.sourceLineStart}`,
    ),
    check(
      "evidence_chunks_heading_path_check",
      sql`jsonb_typeof(${table.headingPath}) = 'array'`,
    ),
    check(
      "evidence_chunks_publication_state_check",
      sql`${table.publicationState} = 'published'`,
    ),
  ],
);

export const chunkEmbeddings = pgTable(
  "chunk_embeddings",
  {
    chunkId: text("chunk_id").notNull(),
    embeddingGenerationId: text("embedding_generation_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    contentHash: text("content_hash").notNull(),
    embeddingInputHash: text("embedding_input_hash").notNull(),
    dimension: integer("dimension").notNull(),
    vector: jsonb("vector").$type<readonly number[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chunkId, table.embeddingGenerationId] }),
    foreignKey({
      columns: [
        table.chunkId,
        table.workspaceId,
        table.contentHash,
        table.embeddingInputHash,
      ],
      foreignColumns: [
        evidenceChunks.id,
        evidenceChunks.workspaceId,
        evidenceChunks.contentHash,
        evidenceChunks.embeddingInputHash,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.embeddingGenerationId, table.workspaceId],
      foreignColumns: [embeddingGenerations.id, embeddingGenerations.workspaceId],
    }).onDelete("cascade"),
    index("chunk_embeddings_workspace_generation_index").on(
      table.workspaceId,
      table.embeddingGenerationId,
    ),
    check(
      "chunk_embeddings_hashes_check",
      sql`length(${table.contentHash}) = 64 and length(${table.embeddingInputHash}) = 64`,
    ),
    check(
      "chunk_embeddings_vector_check",
      sql`${table.dimension} between 1 and 4096 and jsonb_typeof(${table.vector}) = 'array' and jsonb_array_length(${table.vector}) = ${table.dimension}`,
    ),
  ],
);

export const embeddingJobs = pgTable(
  "embedding_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    articleId: text("article_id").notNull(),
    articleContentHash: text("article_content_hash").notNull(),
    embeddingGenerationId: text("embedding_generation_id"),
    indexGeneration: integer("index_generation").notNull(),
    status: text("status", {
      enum: ["pending", "leased", "retryable", "completed", "failed", "superseded"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maximumAttempts: integer("maximum_attempts").notNull().default(3),
    checkpoint: integer("checkpoint").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.embeddingGenerationId, table.workspaceId],
      foreignColumns: [embeddingGenerations.id, embeddingGenerations.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("embedding_jobs_id_workspace_unique").on(table.id, table.workspaceId),
    uniqueIndex("embedding_jobs_workspace_lease_token_unique").on(
      table.workspaceId,
      table.leaseToken,
    ),
    index("embedding_jobs_claim_index").on(
      table.workspaceId,
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index("embedding_jobs_article_index").on(table.workspaceId, table.articleId),
    check(
      "embedding_jobs_hash_check",
      sql`length(${table.articleContentHash}) = 64`,
    ),
    check(
      "embedding_jobs_status_check",
      sql`${table.status} in ('pending', 'leased', 'retryable', 'completed', 'failed', 'superseded')`,
    ),
    check(
      "embedding_jobs_attempts_check",
      sql`${table.attempts} between 0 and ${table.maximumAttempts} and ${table.maximumAttempts} between 1 and 10 and ${table.checkpoint} >= 0`,
    ),
    check(
      "embedding_jobs_lease_check",
      sql`${table.status} <> 'leased' or (${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

export const savedQuestionSets = pgTable(
  "saved_question_sets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    questions: jsonb("questions").$type<readonly unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("saved_question_sets_id_workspace_unique").on(table.id, table.workspaceId),
    uniqueIndex("saved_question_sets_workspace_name_version_unique").on(
      table.workspaceId,
      table.name,
      table.version,
    ),
    check(
      "saved_question_sets_version_check",
      sql`${table.version} >= 1 and length(${table.sourceContentHash}) = 64 and jsonb_typeof(${table.questions}) = 'array'`,
    ),
  ],
);

export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    questionSetId: text("question_set_id").notNull(),
    indexGeneration: integer("index_generation").notNull(),
    embeddingGenerationId: text("embedding_generation_id"),
    retrievalMode: text("retrieval_mode").notNull(),
    provider: text("provider"),
    model: text("model"),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    results: jsonb("results"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.questionSetId, table.workspaceId],
      foreignColumns: [savedQuestionSets.id, savedQuestionSets.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.embeddingGenerationId, table.workspaceId],
      foreignColumns: [embeddingGenerations.id, embeddingGenerations.workspaceId],
    }).onDelete("cascade"),
    index("evaluation_runs_workspace_started_index").on(
      table.workspaceId,
      table.startedAt,
    ),
    check("evaluation_runs_generation_check", sql`${table.indexGeneration} >= 0`),
    check(
      "evaluation_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
  ],
);

export const themes = pgTable("themes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  config: jsonb("config").notNull(),
  ...timestampColumns,
});

export const articleFeedback = pgTable(
  "article_feedback",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    helpful: boolean("helpful").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("article_feedback_article_created_index").on(table.articleId, table.createdAt)],
);

export const articleViews = pgTable(
  "article_views",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("article_views_article_viewed_index").on(table.articleId, table.viewedAt)],
);

export const searchMisses = pgTable(
  "search_misses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("search_misses_workspace_created_index").on(table.workspaceId, table.createdAt)],
);
