-- ABOUTME: Adds ordered articles and portable content-addressed assets to SQLite and D1.
-- ABOUTME: Preserves v0.1 records while enforcing workspace-scoped staging and references.
ALTER TABLE `articles` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_id_workspace_unique` ON `articles` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `asset_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_manifests_id_workspace_unique` ON `asset_manifests` (`id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `asset_manifests_workspace_expires_index` ON `asset_manifests` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`hash` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_hash_length_check" CHECK(length("assets"."hash") = 64),
	CONSTRAINT "assets_media_type_check" CHECK("assets"."media_type" in ('image/gif', 'image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "assets_byte_size_check" CHECK("assets"."byte_size" between 1 and 1048576),
	CONSTRAINT "assets_content_size_check" CHECK(length("assets"."content") = "assets"."byte_size")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_workspace_hash_unique` ON `assets` (`workspace_id`,`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_id_workspace_unique` ON `assets` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `article_assets` (
	`article_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`article_id`, `asset_id`),
	FOREIGN KEY (`article_id`,`workspace_id`) REFERENCES `articles`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`,`workspace_id`) REFERENCES `assets`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_assets_asset_index` ON `article_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `asset_manifest_items` (
	`manifest_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`manifest_id`, `asset_id`),
	FOREIGN KEY (`manifest_id`,`workspace_id`) REFERENCES `asset_manifests`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`,`workspace_id`) REFERENCES `assets`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_manifest_items_asset_index` ON `asset_manifest_items` (`asset_id`);
