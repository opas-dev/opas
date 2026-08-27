// ABOUTME: Defines the OPAS relational model for SQLite and Cloudflare D1 deployments.
// ABOUTME: Keeps table and column names aligned with the Postgres schema.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("articles_workspace_slug_unique").on(table.workspaceId, table.slug),
    index("articles_category_status_index").on(table.categoryId, table.status),
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
