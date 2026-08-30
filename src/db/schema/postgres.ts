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
