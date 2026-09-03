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

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["administrator", "editor", "reviewer"] }).notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordDigest: text("password_digest").notNull(),
    passwordIterations: integer("password_iterations").notNull(),
    createdByMemberId: text("created_by_member_id"),
    ...timestampColumns,
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_members_id_workspace_unique").on(
      table.id,
      table.workspaceId,
    ),
    uniqueIndex("workspace_members_workspace_email_unique").on(
      table.workspaceId,
      table.normalizedEmail,
    ),
    foreignKey({
      columns: [table.createdByMemberId, table.workspaceId],
      foreignColumns: [table.id, table.workspaceId],
    }).onDelete("cascade"),
    index("workspace_members_workspace_status_role_index").on(
      table.workspaceId,
      table.status,
      table.role,
    ),
    check(
      "workspace_members_email_check",
      sql`${table.normalizedEmail} = lower(trim(${table.normalizedEmail})) and length(${table.normalizedEmail}) between 3 and 320`,
    ),
    check(
      "workspace_members_display_name_check",
      sql`length(${table.displayName}) between 1 and 100`,
    ),
    check(
      "workspace_members_role_check",
      sql`${table.role} in ('administrator', 'editor', 'reviewer')`,
    ),
    check(
      "workspace_members_status_check",
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      "workspace_members_password_check",
      sql`length(${table.passwordSalt}) = 43 and length(${table.passwordDigest}) = 43 and ${table.passwordSalt} ~ '^[0-9A-Za-z_-]{43}$' and ${table.passwordDigest} ~ '^[0-9A-Za-z_-]{43}$' and ${table.passwordIterations} = 600000`,
    ),
  ],
);

export const workspaceAuthoringControls = pgTable(
  "workspace_authoring_controls",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    writesPaused: boolean("writes_paused").notNull().default(false),
    generation: integer("generation").notNull().default(0),
    changedByMemberId: text("changed_by_member_id"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "workspace_authoring_controls_generation_check",
      sql`${table.generation} >= 0`,
    ),
  ],
);

export const adminLoginWindows = pgTable(
  "admin_login_windows",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dimension: text("dimension", {
      enum: ["source", "source_principal", "principal", "workspace"],
    }).notNull(),
    keyDigest: text("key_digest").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.dimension,
        table.keyDigest,
        table.windowStartedAt,
      ],
    }),
    index("admin_login_windows_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "admin_login_windows_dimension_check",
      sql`${table.dimension} in ('source', 'source_principal', 'principal', 'workspace')`,
    ),
    check(
      "admin_login_windows_digest_check",
      sql`length(${table.keyDigest}) = 64 and ${table.keyDigest} = lower(${table.keyDigest}) and ${table.keyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("admin_login_windows_count_check", sql`${table.count} >= 0`),
    check(
      "admin_login_windows_time_check",
      sql`${table.expiresAt} > ${table.windowStartedAt} and ${table.expiresAt} <= ${table.windowStartedAt} + interval '24 hours' and (${table.blockedUntil} is null or (${table.blockedUntil} >= ${table.windowStartedAt} and ${table.blockedUntil} <= ${table.expiresAt}))`,
    ),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.memberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    index("admin_sessions_workspace_member_expiry_index").on(
      table.workspaceId,
      table.memberId,
      table.expiresAt,
    ),
    check(
      "admin_sessions_id_check",
      sql`length(${table.id}) = 43 and ${table.id} ~ '^[0-9A-Za-z_-]{43}$'`,
    ),
    check(
      "admin_sessions_time_check",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '8 hours' and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const memberInvitations = pgTable(
  "member_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["invite", "credential_reset"] }).notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    targetRole: text("target_role", {
      enum: ["administrator", "editor", "reviewer"],
    }),
    memberId: text("member_id"),
    tokenDigest: text("token_digest").notNull(),
    createdByMemberId: text("created_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("member_invitations_token_digest_unique").on(table.tokenDigest),
    uniqueIndex("member_invitations_active_invite_unique")
      .on(table.workspaceId, table.normalizedEmail)
      .where(
        sql`${table.kind} = 'invite' and ${table.acceptedAt} is null and ${table.revokedAt} is null`,
      ),
    uniqueIndex("member_invitations_active_reset_unique")
      .on(table.workspaceId, table.memberId)
      .where(
        sql`${table.kind} = 'credential_reset' and ${table.acceptedAt} is null and ${table.revokedAt} is null`,
      ),
    foreignKey({
      columns: [table.memberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByMemberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    index("member_invitations_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "member_invitations_kind_check",
      sql`${table.kind} in ('invite', 'credential_reset')`,
    ),
    check(
      "member_invitations_email_check",
      sql`${table.normalizedEmail} = lower(trim(${table.normalizedEmail})) and length(${table.normalizedEmail}) between 3 and 320`,
    ),
    check(
      "member_invitations_target_check",
      sql`(${table.kind} = 'invite' and ${table.targetRole} is not null and ${table.targetRole} in ('administrator', 'editor', 'reviewer') and ${table.memberId} is null) or (${table.kind} = 'credential_reset' and ${table.targetRole} is null and ${table.memberId} is not null)`,
    ),
    check(
      "member_invitations_creator_check",
      sql`${table.createdByMemberId} is not null or (${table.kind} = 'invite' and ${table.targetRole} is not null and ${table.targetRole} = 'administrator' and ${table.memberId} is null) or (${table.kind} = 'credential_reset' and ${table.targetRole} is null and ${table.memberId} is not null)`,
    ),
    check(
      "member_invitations_digest_check",
      sql`length(${table.tokenDigest}) = 64 and ${table.tokenDigest} = lower(${table.tokenDigest}) and ${table.tokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "member_invitations_expiry_check",
      sql`(${table.kind} = 'invite' and ${table.expiresAt} = ${table.createdAt} + interval '48 hours') or (${table.kind} = 'credential_reset' and ${table.expiresAt} = ${table.createdAt} + interval '1 hour')`,
    ),
    check(
      "member_invitations_lifecycle_check",
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null) and (${table.acceptedAt} is null or (${table.acceptedAt} >= ${table.createdAt} and ${table.acceptedAt} <= ${table.expiresAt})) and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
    ),
  ],
);

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
    contentHash: text("content_hash"),
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

export const workspaceAuthoringMigrations = pgTable(
  "workspace_authoring_migrations",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    articleCount: integer("article_count").notNull(),
    projectionHash: text("projection_hash").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.version] }),
    check(
      "workspace_authoring_migrations_values_check",
      sql`${table.version} >= 1 and ${table.articleCount} >= 0 and length(${table.projectionHash}) = 64 and ${table.projectionHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const articleRevisions = pgTable(
  "article_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    articleId: text("article_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    categoryId: text("category_id").notNull(),
    categorySlug: text("category_slug").notNull(),
    categoryName: text("category_name").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    mdx: text("mdx").notNull(),
    isFaq: boolean("is_faq").notNull(),
    authorName: text("author_name").notNull(),
    position: integer("position").notNull(),
    revisionHash: text("revision_hash").notNull(),
    changeKind: text("change_kind", {
      enum: ["manual", "import", "rollback", "migration", "seed"],
    }).notNull(),
    createdByMemberId: text("created_by_member_id"),
    createdBySystemLabel: text("created_by_system_label"),
    changeSummary: text("change_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    restoredFromRevisionId: text("restored_from_revision_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByMemberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.workspaceId,
        table.articleId,
        table.restoredFromRevisionId,
      ],
      foreignColumns: [table.workspaceId, table.articleId, table.id],
    }).onDelete("cascade"),
    uniqueIndex("article_revisions_workspace_article_number_unique").on(
      table.workspaceId,
      table.articleId,
      table.revisionNumber,
    ),
    uniqueIndex("article_revisions_workspace_article_identity_unique").on(
      table.workspaceId,
      table.articleId,
      table.id,
      table.revisionNumber,
    ),
    uniqueIndex("article_revisions_workspace_identity_unique").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("article_revisions_workspace_article_id_unique").on(
      table.workspaceId,
      table.articleId,
      table.id,
    ),
    index("article_revisions_history_index").on(
      table.workspaceId,
      table.articleId,
      table.revisionNumber,
    ),
    check("article_revisions_number_check", sql`${table.revisionNumber} >= 1`),
    check(
      "article_revisions_snapshot_check",
      sql`length(${table.categoryId}) >= 1 and length(${table.categorySlug}) between 1 and 120 and length(${table.categoryName}) between 1 and 100 and length(${table.slug}) between 1 and 120 and length(${table.title}) between 1 and 160 and octet_length(${table.mdx}) <= 100000 and length(${table.authorName}) between 1 and 100 and ${table.position} between 0 and 10000`,
    ),
    check(
      "article_revisions_hash_check",
      sql`length(${table.revisionHash}) = 64 and ${table.revisionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "article_revisions_change_kind_check",
      sql`${table.changeKind} in ('manual', 'import', 'rollback', 'migration', 'seed')`,
    ),
    check(
      "article_revisions_actor_check",
      sql`(${table.changeKind} = 'migration' and ${table.createdByMemberId} is null and ${table.createdBySystemLabel} is not null and ${table.createdBySystemLabel} = 'OPAS migration') or (${table.changeKind} <> 'migration' and ${table.createdByMemberId} is not null and ${table.createdBySystemLabel} is null)`,
    ),
    check(
      "article_revisions_summary_check",
      sql`${table.changeSummary} is null or length(${table.changeSummary}) <= 500`,
    ),
    check(
      "article_revisions_restore_check",
      sql`(${table.changeKind} = 'rollback' and ${table.restoredFromRevisionId} is not null) or (${table.changeKind} <> 'rollback' and ${table.restoredFromRevisionId} is null)`,
    ),
  ],
);

export const articleRevisionAssets = pgTable(
  "article_revision_assets",
  {
    workspaceId: text("workspace_id").notNull(),
    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    assetId: text("asset_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.assetId] }),
    foreignKey({
      columns: [
        table.workspaceId,
        table.articleId,
        table.revisionId,
        table.revisionNumber,
      ],
      foreignColumns: [
        articleRevisions.workspaceId,
        articleRevisions.articleId,
        articleRevisions.id,
        articleRevisions.revisionNumber,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId, table.workspaceId],
      foreignColumns: [assets.id, assets.workspaceId],
    }).onDelete("cascade"),
    index("article_revision_assets_asset_index").on(
      table.workspaceId,
      table.assetId,
    ),
  ],
);

export const articleSlugClaims = pgTable(
  "article_slug_claims",
  {
    workspaceId: text("workspace_id").notNull(),
    normalizedSlug: text("normalized_slug").notNull(),
    articleId: text("article_id").notNull(),
    workingClaim: boolean("working_claim").notNull(),
    articleRowClaim: boolean("article_row_claim").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.normalizedSlug] }),
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("article_slug_claims_workspace_slug_article_unique").on(
      table.workspaceId,
      table.normalizedSlug,
      table.articleId,
    ),
    index("article_slug_claims_article_index").on(
      table.workspaceId,
      table.articleId,
    ),
    check(
      "article_slug_claims_slug_check",
      sql`${table.normalizedSlug} = lower(trim(${table.normalizedSlug})) and length(${table.normalizedSlug}) between 1 and 120`,
    ),
    check(
      "article_slug_claims_owner_check",
      sql`${table.workingClaim} or ${table.articleRowClaim}`,
    ),
  ],
);

export const articleHeads = pgTable(
  "article_heads",
  {
    articleId: text("article_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workingRevisionId: text("working_revision_id").notNull(),
    workingRevisionNumber: integer("working_revision_number").notNull(),
    workingSlug: text("working_slug").notNull(),
    publishedRevisionId: text("published_revision_id"),
    publishedRevisionNumber: integer("published_revision_number"),
    reviewState: text("review_state", {
      enum: ["editing", "in_review", "changes_requested", "approved", "published"],
    }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByMemberId: text("archived_by_member_id"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.workspaceId] }),
    foreignKey({
      columns: [table.articleId, table.workspaceId],
      foreignColumns: [articles.id, articles.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.workspaceId,
        table.articleId,
        table.workingRevisionId,
        table.workingRevisionNumber,
      ],
      foreignColumns: [
        articleRevisions.workspaceId,
        articleRevisions.articleId,
        articleRevisions.id,
        articleRevisions.revisionNumber,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.workspaceId,
        table.articleId,
        table.publishedRevisionId,
        table.publishedRevisionNumber,
      ],
      foreignColumns: [
        articleRevisions.workspaceId,
        articleRevisions.articleId,
        articleRevisions.id,
        articleRevisions.revisionNumber,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.workingSlug, table.articleId],
      foreignColumns: [
        articleSlugClaims.workspaceId,
        articleSlugClaims.normalizedSlug,
        articleSlugClaims.articleId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.archivedByMemberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    index("article_heads_workspace_state_index").on(
      table.workspaceId,
      table.reviewState,
      table.archivedAt,
    ),
    check("article_heads_working_number_check", sql`${table.workingRevisionNumber} >= 1`),
    check(
      "article_heads_published_pointer_check",
      sql`(${table.publishedRevisionId} is null and ${table.publishedRevisionNumber} is null) or (${table.publishedRevisionId} is not null and ${table.publishedRevisionNumber} is not null and ${table.publishedRevisionNumber} >= 1)`,
    ),
    check(
      "article_heads_archive_check",
      sql`(${table.archivedAt} is null and ${table.archivedByMemberId} is null) or (${table.archivedAt} is not null and ${table.archivedByMemberId} is not null)`,
    ),
    check(
      "article_heads_review_state_check",
      sql`${table.reviewState} in ('editing', 'in_review', 'changes_requested', 'approved', 'published')`,
    ),
    check(
      "article_heads_published_state_check",
      sql`${table.reviewState} <> 'published' or (${table.archivedAt} is null and ${table.publishedRevisionId} is not null and ${table.publishedRevisionNumber} is not null and ${table.publishedRevisionId} = ${table.workingRevisionId} and ${table.publishedRevisionNumber} = ${table.workingRevisionNumber})`,
    ),
  ],
);

export const articleReviewEvents = pgTable(
  "article_review_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    memberId: text("member_id").notNull(),
    action: text("action", {
      enum: [
        "submitted",
        "withdrawn",
        "changes_requested",
        "category_changed",
        "approved",
        "published",
        "unpublished",
        "archived",
        "restored",
        "emergency_published",
      ],
    }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.workspaceId,
        table.articleId,
        table.revisionId,
        table.revisionNumber,
      ],
      foreignColumns: [
        articleRevisions.workspaceId,
        articleRevisions.articleId,
        articleRevisions.id,
        articleRevisions.revisionNumber,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.memberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    index("article_review_events_history_index").on(
      table.workspaceId,
      table.articleId,
      table.createdAt,
    ),
    check(
      "article_review_events_action_check",
      sql`${table.action} in ('submitted', 'withdrawn', 'changes_requested', 'category_changed', 'approved', 'published', 'unpublished', 'archived', 'restored', 'emergency_published')`,
    ),
    check(
      "article_review_events_note_check",
      sql`${table.note} is null or length(${table.note}) <= 500`,
    ),
  ],
);

export const articlePreviewGrants = pgTable(
  "article_preview_grants",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    revisionId: text("revision_id").notNull(),
    createdByMemberId: text("created_by_member_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMemberId: text("revoked_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [articleRevisions.workspaceId, articleRevisions.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByMemberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.revokedByMemberId, table.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("article_preview_grants_active_revision_unique")
      .on(table.workspaceId, table.revisionId)
      .where(sql`${table.revokedAt} is null`),
    index("article_preview_grants_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "article_preview_grants_id_check",
      sql`length(${table.id}) = 43 and ${table.id} ~ '^[0-9A-Za-z_-]{43}$'`,
    ),
    check(
      "article_preview_grants_expiry_check",
      sql`${table.expiresAt} = ${table.createdAt} + interval '7 days'`,
    ),
    check(
      "article_preview_grants_revocation_check",
      sql`(${table.revokedAt} is null and ${table.revokedByMemberId} is null) or (${table.revokedAt} is not null and ${table.revokedByMemberId} is not null and ${table.revokedAt} >= ${table.createdAt})`,
    ),
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

export const workspaceInferenceStates = pgTable(
  "workspace_inference_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const answerInferenceLeases = pgTable(
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
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
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

export const supportHandoffs = pgTable(
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
    contact: jsonb("contact").notNull(),
    context: jsonb("context").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
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
      "support_handoffs_lifecycle_check",
      sql`(${table.status} = 'pending' and ${table.finishedAt} is null) or (${table.status} <> 'pending' and ${table.finishedAt} is not null)`,
    ),
  ],
);

export const conversationAnalytics = pgTable(
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
    conversation: jsonb("conversation").notNull(),
    retrievalTrace: jsonb("retrieval_trace").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    durationMilliseconds: integer("duration_milliseconds").notNull(),
    firstTokenMilliseconds: integer("first_token_milliseconds"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicrodollars: integer("cost_microdollars"),
    bucketDay: text("bucket_day").notNull(),
    bucketSlot: integer("bucket_slot").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
      sql`${table.reason} is null or octet_length(${table.reason}) <= 256`,
    ),
    check(
      "conversation_analytics_json_check",
      sql`jsonb_typeof(${table.conversation}) = 'array' and jsonb_typeof(${table.retrievalTrace}) = 'array' and octet_length(${table.conversation}::text) <= 16384 and octet_length(${table.retrievalTrace}::text) <= 8192`,
    ),
    check(
      "conversation_analytics_measurements_check",
      sql`${table.durationMilliseconds} between 0 and 300000 and (${table.firstTokenMilliseconds} is null or ${table.firstTokenMilliseconds} between 0 and ${table.durationMilliseconds}) and (${table.inputTokens} is null or ${table.inputTokens} between 0 and 1000000) and (${table.outputTokens} is null or ${table.outputTokens} between 0 and 1000000) and (${table.costMicrodollars} is null or ${table.costMicrodollars} between 0 and 2000000000)`,
    ),
    check(
      "conversation_analytics_bucket_check",
      sql`${table.bucketDay} ~ '^[0-9]{8}$' and ${table.bucketSlot} between 0 and 1023`,
    ),
    check(
      "conversation_analytics_lifecycle_check",
      sql`${table.updatedAt} >= ${table.startedAt} and ${table.expiresAt} > ${table.startedAt}`,
    ),
  ],
);

export const workspacePublicWriteStates = pgTable(
  "workspace_public_write_states",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const publicOutcomeWriteWindows = pgTable(
  "public_outcome_write_windows",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
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

export const publicWriteReservations = pgTable(
  "public_write_reservations",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspacePublicWriteStates.workspaceId, {
        onDelete: "cascade",
      }),
    kind: text("kind", { enum: ["handoff"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
