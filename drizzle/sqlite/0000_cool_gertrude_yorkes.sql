-- ABOUTME: Creates the initial OPAS relational model for SQLite and Cloudflare D1.
-- ABOUTME: Keeps table and column names aligned with the Postgres migration path.
CREATE TABLE `article_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`helpful` integer NOT NULL,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_feedback_article_created_index` ON `article_feedback` (`article_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `article_views` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`viewed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_views_article_viewed_index` ON `article_views` (`article_id`,`viewed_at`);--> statement-breakpoint
CREATE TABLE `articles` (
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
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_workspace_slug_unique` ON `articles` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE INDEX `articles_category_status_index` ON `articles` (`category_id`,`status`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_workspace_slug_unique` ON `categories` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE INDEX `categories_workspace_position_index` ON `categories` (`workspace_id`,`position`);--> statement-breakpoint
CREATE TABLE `search_misses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`query` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_misses_workspace_created_index` ON `search_misses` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `themes_workspace_id_unique` ON `themes` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);
