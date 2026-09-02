// ABOUTME: Defines the OPAS relational model for SQLite and Cloudflare D1 deployments.
// ABOUTME: Keeps table and column names aligned with the Postgres schema.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const binary = customType<{
  data: Uint8Array;
  driverData: ArrayBuffer | Uint8Array;
}>({
  dataType() {
    return "blob";
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

const timestampColumns = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ...timestampColumns,
});

export const workspaceAuthoringControls = sqliteTable(
  "workspace_authoring_controls",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    writesPaused: integer("writes_paused", { mode: "boolean" }).notNull().default(false),
    generation: integer("generation").notNull().default(0),
    changedByMemberId: text("changed_by_member_id"),
    changedAt: integer("changed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    check(
      "workspace_authoring_controls_writes_paused_check",
      sql`${table.writesPaused} in (0, 1)`,
    ),
    check(
      "workspace_authoring_controls_generation_check",
      sql`${table.generation} >= 0`,
    ),
  ],
);

export const categories = sqliteTable(
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

export const articles = sqliteTable(
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
    contentHash: text("content_hash"),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    isFaq: integer("is_faq", { mode: "boolean" }).notNull().default(false),
    authorName: text("author_name").notNull().default("OPAS"),
    position: integer("position").notNull().default(0),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("articles_workspace_slug_unique").on(table.workspaceId, table.slug),
    uniqueIndex("articles_id_workspace_unique").on(table.id, table.workspaceId),
    index("articles_category_status_index").on(table.categoryId, table.status),
    index("articles_workspace_status_content_hash_index").on(
      table.workspaceId,
      table.status,
      table.contentHash,
    ),
    check(
      "articles_content_hash_check",
      sql`${table.contentHash} is null or length(${table.contentHash}) = 64`,
    ),
    check("articles_status_check", sql`${table.status} in ('draft', 'published')`),
  ],
);

export const assetManifests = sqliteTable(
  "asset_manifests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("asset_manifests_id_workspace_unique").on(table.id, table.workspaceId),
    index("asset_manifests_workspace_expires_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
  ],
);

export const assets = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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
      sql`length(${table.content}) = ${table.byteSize}`,
    ),
  ],
);

export const assetManifestItems = sqliteTable(
  "asset_manifest_items",
  {
    manifestId: text("manifest_id").notNull(),
    assetId: text("asset_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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

export const articleAssets = sqliteTable(
  "article_assets",
  {
    articleId: text("article_id").notNull(),
    assetId: text("asset_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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

export const embeddingGenerations = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
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
    index("embedding_generations_reconciliation_index").on(
      table.workspaceId,
      table.status,
      table.provider,
      table.model,
      table.dimension,
      table.configurationHash,
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

export const workspaceIndexStates = sqliteTable(
  "workspace_index_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull().default(0),
    activeEmbeddingGenerationId: text("active_embedding_generation_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    foreignKey({
      columns: [table.activeEmbeddingGenerationId, table.workspaceId],
      foreignColumns: [embeddingGenerations.id, embeddingGenerations.workspaceId],
    }).onDelete("cascade"),
    check("workspace_index_states_generation_check", sql`${table.generation} >= 0`),
  ],
);

export const evidenceChunks = sqliteTable(
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
    headingPath: text("heading_path", { mode: "json" })
      .$type<readonly string[]>()
      .notNull(),
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
      sql`json_valid(${table.headingPath}) and json_type(${table.headingPath}) = 'array'`,
    ),
    check(
      "evidence_chunks_publication_state_check",
      sql`${table.publicationState} = 'published'`,
    ),
  ],
);

export const chunkEmbeddings = sqliteTable(
  "chunk_embeddings",
  {
    chunkId: text("chunk_id").notNull(),
    embeddingGenerationId: text("embedding_generation_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    contentHash: text("content_hash").notNull(),
    embeddingInputHash: text("embedding_input_hash").notNull(),
    dimension: integer("dimension").notNull(),
    vector: text("vector", { mode: "json" }).$type<readonly number[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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
      sql`${table.dimension} between 1 and 4096 and json_valid(${table.vector}) and json_type(${table.vector}) = 'array' and json_array_length(${table.vector}) = ${table.dimension}`,
    ),
  ],
);

export const embeddingJobs = sqliteTable(
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
    availableAt: integer("available_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
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
    uniqueIndex("embedding_jobs_generation_article_hash_unique").on(
      table.workspaceId,
      table.articleId,
      table.articleContentHash,
      table.embeddingGenerationId,
    ),
    index("embedding_jobs_claim_index").on(
      table.workspaceId,
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index("embedding_jobs_generation_claim_index").on(
      table.workspaceId,
      table.embeddingGenerationId,
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

export const savedQuestionSets = sqliteTable(
  "saved_question_sets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    questions: text("questions", { mode: "json" }).$type<readonly unknown[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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
      sql`${table.version} >= 1 and length(${table.sourceContentHash}) = 64 and json_valid(${table.questions}) and json_type(${table.questions}) = 'array'`,
    ),
  ],
);

export const evaluationRuns = sqliteTable(
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
    results: text("results", { mode: "json" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
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
    check(
      "evaluation_runs_results_check",
      sql`${table.results} is null or json_valid(${table.results})`,
    ),
  ],
);

export const workspaceInferenceStates = sqliteTable(
  "workspace_inference_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
);

export const answerInferenceLeases = sqliteTable(
  "answer_inference_leases",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceInferenceStates.workspaceId, {
        onDelete: "cascade",
      }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    reservedMicrodollars: integer("reserved_microdollars").notNull(),
    chargedMicrodollars: integer("charged_microdollars"),
    status: text("status", {
      enum: [
        "active",
        "cancelled",
        "completed",
        "expired",
        "failed",
        "invalid-output",
        "timeout",
      ],
    })
      .notNull()
      .default("active"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    reconciledAt: integer("reconciled_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("answer_inference_leases_id_workspace_unique").on(
      table.id,
      table.workspaceId,
    ),
    index("answer_inference_leases_workspace_status_expires_index").on(
      table.workspaceId,
      table.status,
      table.expiresAt,
    ),
    index("answer_inference_leases_workspace_started_index").on(
      table.workspaceId,
      table.startedAt,
    ),
    check(
      "answer_inference_leases_identity_check",
      sql`length(${table.provider}) between 1 and 64 and length(${table.model}) between 1 and 256`,
    ),
    check(
      "answer_inference_leases_amount_check",
      sql`${table.maximumOutputTokens} between 1 and 8192 and ${table.reservedMicrodollars} between 1 and 2000000000 and (${table.chargedMicrodollars} is null or ${table.chargedMicrodollars} between 0 and ${table.reservedMicrodollars})`,
    ),
    check(
      "answer_inference_leases_usage_check",
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0)`,
    ),
    check(
      "answer_inference_leases_status_check",
      sql`${table.status} in ('active', 'cancelled', 'completed', 'expired', 'failed', 'invalid-output', 'timeout')`,
    ),
    check(
      "answer_inference_leases_lifecycle_check",
      sql`(${table.status} = 'active' and ${table.chargedMicrodollars} is null and ${table.reconciledAt} is null) or (${table.status} <> 'active' and ${table.chargedMicrodollars} is not null and ${table.reconciledAt} is not null)`,
    ),
    check(
      "answer_inference_leases_expiry_check",
      sql`${table.expiresAt} > ${table.startedAt} and (${table.status} <> 'expired' or ${table.chargedMicrodollars} = ${table.reservedMicrodollars})`,
    ),
  ],
);

export const supportHandoffs = sqliteTable(
  "support_handoffs",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", {
      enum: ["pending", "delivered", "failed"],
    })
      .notNull()
      .default("pending"),
    contact: text("contact", { mode: "json" }).notNull(),
    context: text("context", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index("support_handoffs_workspace_status_created_index").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    check(
      "support_handoffs_identity_check",
      sql`length(${table.id}) = 36 and length(${table.payloadHash}) = 64`,
    ),
    check(
      "support_handoffs_status_check",
      sql`${table.status} in ('pending', 'delivered', 'failed')`,
    ),
    check(
      "support_handoffs_json_check",
      sql`json_valid(${table.contact}) and json_type(${table.contact}) = 'object' and json_valid(${table.context}) and json_type(${table.context}) = 'object'`,
    ),
    check(
      "support_handoffs_lifecycle_check",
      sql`(${table.status} = 'pending' and ${table.finishedAt} is null) or (${table.status} <> 'pending' and ${table.finishedAt} is not null)`,
    ),
  ],
);

export const conversationAnalytics = sqliteTable(
  "conversation_analytics",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outcome: text("outcome", {
      enum: ["abandoned", "abstained", "answered", "escalated", "low-rated"],
    }).notNull(),
    reason: text("reason"),
    conversation: text("conversation", { mode: "json" }).notNull(),
    retrievalTrace: text("retrieval_trace", { mode: "json" }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    durationMilliseconds: integer("duration_milliseconds").notNull(),
    firstTokenMilliseconds: integer("first_token_milliseconds"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicrodollars: integer("cost_microdollars"),
    bucketDay: text("bucket_day").notNull(),
    bucketSlot: integer("bucket_slot").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    uniqueIndex("conversation_analytics_workspace_bucket_unique").on(
      table.workspaceId,
      table.bucketDay,
      table.bucketSlot,
    ),
    index("conversation_analytics_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    index("conversation_analytics_workspace_started_index").on(
      table.workspaceId,
      table.startedAt,
    ),
    check(
      "conversation_analytics_identity_check",
      sql`length(${table.id}) = 36 and length(${table.provider}) between 1 and 64 and length(${table.model}) between 1 and 256`,
    ),
    check(
      "conversation_analytics_outcome_check",
      sql`${table.outcome} in ('abandoned', 'abstained', 'answered', 'escalated', 'low-rated')`,
    ),
    check(
      "conversation_analytics_reason_check",
      sql`${table.reason} is null or length(cast(${table.reason} as blob)) <= 256`,
    ),
    check(
      "conversation_analytics_json_check",
      sql`json_valid(${table.conversation}) and json_type(${table.conversation}) = 'array' and json_valid(${table.retrievalTrace}) and json_type(${table.retrievalTrace}) = 'array' and length(cast(${table.conversation} as blob)) <= 16384 and length(cast(${table.retrievalTrace} as blob)) <= 8192`,
    ),
    check(
      "conversation_analytics_measurements_check",
      sql`${table.durationMilliseconds} between 0 and 300000 and (${table.firstTokenMilliseconds} is null or ${table.firstTokenMilliseconds} between 0 and ${table.durationMilliseconds}) and (${table.inputTokens} is null or ${table.inputTokens} between 0 and 1000000) and (${table.outputTokens} is null or ${table.outputTokens} between 0 and 1000000) and (${table.costMicrodollars} is null or ${table.costMicrodollars} between 0 and 2000000000)`,
    ),
    check(
      "conversation_analytics_bucket_check",
      sql`length(${table.bucketDay}) = 8 and ${table.bucketDay} not glob '*[^0-9]*' and ${table.bucketSlot} between 0 and 1023`,
    ),
    check(
      "conversation_analytics_lifecycle_check",
      sql`${table.updatedAt} >= ${table.startedAt} and ${table.expiresAt} > ${table.startedAt}`,
    ),
  ],
);

export const workspacePublicWriteStates = sqliteTable(
  "workspace_public_write_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
);

export const publicOutcomeWriteWindows = sqliteTable(
  "public_outcome_write_windows",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" })
      .notNull(),
    writeCount: integer("write_count").notNull(),
  },
  (table) => [
    check(
      "public_outcome_write_windows_count_check",
      sql`${table.writeCount} between 1 and 300`,
    ),
  ],
);

export const publicWriteReservations = sqliteTable(
  "public_write_reservations",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspacePublicWriteStates.workspaceId, {
        onDelete: "cascade",
      }),
    kind: text("kind", { enum: ["handoff"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId, table.kind] }),
    index("public_write_reservations_workspace_kind_created_index").on(
      table.workspaceId,
      table.kind,
      table.createdAt,
    ),
    index("public_write_reservations_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "public_write_reservations_identity_check",
      sql`length(${table.id}) = 36 and ${table.kind} = 'handoff'`,
    ),
    check(
      "public_write_reservations_lifecycle_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const themes = sqliteTable("themes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  ...timestampColumns,
});

export const articleFeedback = sqliteTable(
  "article_feedback",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    helpful: integer("helpful", { mode: "boolean" }).notNull(),
    comment: text("comment"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("article_feedback_article_created_index").on(table.articleId, table.createdAt)],
);

export const articleViews = sqliteTable(
  "article_views",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    viewedAt: integer("viewed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("article_views_article_viewed_index").on(table.articleId, table.viewedAt)],
);

export const searchMisses = sqliteTable(
  "search_misses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("search_misses_workspace_created_index").on(table.workspaceId, table.createdAt)],
);
