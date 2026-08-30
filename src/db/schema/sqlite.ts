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
