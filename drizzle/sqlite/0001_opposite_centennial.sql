-- ABOUTME: Enforces the supported OPAS article publication states in SQLite and D1.
-- ABOUTME: Rebuilds the articles table so raw writes retain the same dialect contract.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__article_feedback_backup` AS SELECT * FROM `article_feedback`;--> statement-breakpoint
CREATE TABLE `__article_views_backup` AS SELECT * FROM `article_views`;--> statement-breakpoint
CREATE TABLE `__new_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`category_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`mdx` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_faq` integer DEFAULT false NOT NULL,
	`author_name` text DEFAULT 'OPAS' NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "articles_status_check" CHECK("__new_articles"."status" in ('draft', 'published'))
);
--> statement-breakpoint
INSERT INTO `__new_articles`("id", "workspace_id", "category_id", "slug", "title", "mdx", "status", "is_faq", "author_name", "published_at", "created_at", "updated_at") SELECT "id", "workspace_id", "category_id", "slug", "title", "mdx", "status", "is_faq", "author_name", "published_at", "created_at", "updated_at" FROM `articles`;--> statement-breakpoint
DROP TABLE `articles`;--> statement-breakpoint
ALTER TABLE `__new_articles` RENAME TO `articles`;--> statement-breakpoint
INSERT INTO `article_feedback` SELECT * FROM `__article_feedback_backup`;--> statement-breakpoint
INSERT INTO `article_views` SELECT * FROM `__article_views_backup`;--> statement-breakpoint
DROP TABLE `__article_feedback_backup`;--> statement-breakpoint
DROP TABLE `__article_views_backup`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_workspace_slug_unique` ON `articles` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE INDEX `articles_category_status_index` ON `articles` (`category_id`,`status`);
