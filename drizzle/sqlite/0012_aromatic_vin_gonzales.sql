-- ABOUTME: Adds submitter attribution and optimistic versions to authoring records.
-- ABOUTME: Requires every existing workspace paused before the SQLite or D1 schema delta.
INSERT INTO `workspace_authoring_controls` (
	`workspace_id`,
	`writes_paused`,
	`generation`,
	`changed_by_member_id`,
	`changed_at`
)
SELECT `workspaces`.`id`, 1, -1, NULL, unixepoch() * 1000
FROM `workspaces`
LEFT JOIN `workspace_authoring_controls`
	ON `workspace_authoring_controls`.`workspace_id` = `workspaces`.`id`
WHERE `workspace_authoring_controls`.`workspace_id` IS NULL
	OR `workspace_authoring_controls`.`writes_paused` <> 1
ON CONFLICT (`workspace_id`) DO UPDATE SET `generation` = -1;
--> statement-breakpoint
DROP TRIGGER `team_authoring_backfill_assertions_insert_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `article_heads_authoring_control_insert_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `article_heads_authoring_control_update_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `article_heads_authoring_control_delete_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `article_heads_integrity_insert_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `article_heads_integrity_update_trigger`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_article_heads` (
	`article_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`working_revision_id` text NOT NULL,
	`working_revision_number` integer NOT NULL,
	`working_slug` text NOT NULL,
	`published_revision_id` text,
	`published_revision_number` integer,
	`review_state` text NOT NULL,
	`submitted_by_member_id` text,
	`archived_at` integer,
	`archived_by_member_id` text,
	PRIMARY KEY(`article_id`, `workspace_id`),
	FOREIGN KEY (`article_id`,`workspace_id`) REFERENCES `articles`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`article_id`,`working_revision_id`,`working_revision_number`) REFERENCES `article_revisions`(`workspace_id`,`article_id`,`id`,`revision_number`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`article_id`,`published_revision_id`,`published_revision_number`) REFERENCES `article_revisions`(`workspace_id`,`article_id`,`id`,`revision_number`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`working_slug`,`article_id`) REFERENCES `article_slug_claims`(`workspace_id`,`normalized_slug`,`article_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by_member_id`,`workspace_id`) REFERENCES `workspace_members`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`archived_by_member_id`,`workspace_id`) REFERENCES `workspace_members`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_heads_working_number_check" CHECK("__new_article_heads"."working_revision_number" >= 1),
	CONSTRAINT "article_heads_published_pointer_check" CHECK(("__new_article_heads"."published_revision_id" is null and "__new_article_heads"."published_revision_number" is null) or ("__new_article_heads"."published_revision_id" is not null and "__new_article_heads"."published_revision_number" is not null and "__new_article_heads"."published_revision_number" >= 1)),
	CONSTRAINT "article_heads_archive_check" CHECK(("__new_article_heads"."archived_at" is null and "__new_article_heads"."archived_by_member_id" is null) or ("__new_article_heads"."archived_at" is not null and "__new_article_heads"."archived_by_member_id" is not null)),
	CONSTRAINT "article_heads_review_state_check" CHECK("__new_article_heads"."review_state" in ('editing', 'in_review', 'changes_requested', 'approved', 'published')),
	CONSTRAINT "article_heads_submitter_check" CHECK(("__new_article_heads"."review_state" = 'in_review' and "__new_article_heads"."submitted_by_member_id" is not null) or ("__new_article_heads"."review_state" <> 'in_review' and "__new_article_heads"."submitted_by_member_id" is null)),
	CONSTRAINT "article_heads_published_state_check" CHECK("__new_article_heads"."review_state" <> 'published' or ("__new_article_heads"."archived_at" is null and "__new_article_heads"."published_revision_id" is not null and "__new_article_heads"."published_revision_number" is not null and "__new_article_heads"."published_revision_id" = "__new_article_heads"."working_revision_id" and "__new_article_heads"."published_revision_number" = "__new_article_heads"."working_revision_number"))
);
--> statement-breakpoint
INSERT INTO `__new_article_heads`("article_id", "workspace_id", "working_revision_id", "working_revision_number", "working_slug", "published_revision_id", "published_revision_number", "review_state", "submitted_by_member_id", "archived_at", "archived_by_member_id") SELECT "article_id", "workspace_id", "working_revision_id", "working_revision_number", "working_slug", "published_revision_id", "published_revision_number", "review_state", NULL, "archived_at", "archived_by_member_id" FROM `article_heads`;--> statement-breakpoint
DROP TABLE `article_heads`;--> statement-breakpoint
ALTER TABLE `__new_article_heads` RENAME TO `article_heads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `article_heads_workspace_state_index` ON `article_heads` (`workspace_id`,`review_state`,`archived_at`);--> statement-breakpoint
CREATE TRIGGER `article_heads_authoring_control_insert_trigger`
BEFORE INSERT ON `article_heads`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id` AND `writes_paused` = 0
)
AND (
	EXISTS (
		SELECT 1 FROM `workspace_authoring_migrations`
		WHERE `workspace_id` = NEW.`workspace_id` AND `version` = 1
	)
	OR NOT EXISTS (
		SELECT 1
		FROM `article_revisions` AS `revision`
		WHERE `revision`.`workspace_id` = NEW.`workspace_id`
			AND `revision`.`article_id` = NEW.`article_id`
			AND `revision`.`id` = NEW.`working_revision_id`
			AND `revision`.`revision_number` = NEW.`working_revision_number`
			AND `revision`.`change_kind` = 'migration'
			AND `revision`.`created_by_member_id` IS NULL
			AND `revision`.`created_by_system_label` = 'OPAS migration'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;--> statement-breakpoint
CREATE TRIGGER `article_heads_authoring_control_update_trigger`
BEFORE UPDATE ON `article_heads`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id` AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1 FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id` AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;--> statement-breakpoint
CREATE TRIGGER `article_heads_authoring_control_delete_trigger`
BEFORE DELETE ON `article_heads`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`
)
AND NOT EXISTS (
	SELECT 1 FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id` AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;--> statement-breakpoint
CREATE TRIGGER `article_heads_integrity_insert_trigger`
BEFORE INSERT ON `article_heads`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `articles` AS `article`
	INNER JOIN `article_revisions` AS `working`
		ON `working`.`workspace_id` = NEW.`workspace_id`
		AND `working`.`article_id` = NEW.`article_id`
		AND `working`.`id` = NEW.`working_revision_id`
		AND `working`.`revision_number` = NEW.`working_revision_number`
	INNER JOIN `article_slug_claims` AS `working_claim`
		ON `working_claim`.`workspace_id` = NEW.`workspace_id`
		AND `working_claim`.`normalized_slug` = NEW.`working_slug`
		AND `working_claim`.`article_id` = NEW.`article_id`
		AND `working_claim`.`working_claim` = 1
	INNER JOIN `article_slug_claims` AS `row_claim`
		ON `row_claim`.`workspace_id` = `article`.`workspace_id`
		AND `row_claim`.`normalized_slug` = `article`.`slug`
		AND `row_claim`.`article_id` = `article`.`id`
		AND `row_claim`.`article_row_claim` = 1
	WHERE `article`.`workspace_id` = NEW.`workspace_id`
		AND `article`.`id` = NEW.`article_id`
		AND `working`.`slug` = NEW.`working_slug`
		AND (NEW.`review_state` <> 'published' OR `article`.`status` = 'published')
		AND (
			`article`.`status` <> 'published'
			OR (NEW.`archived_at` IS NULL AND EXISTS (
				SELECT 1
				FROM `article_revisions` AS `published`
				WHERE `published`.`workspace_id` = NEW.`workspace_id`
					AND `published`.`article_id` = NEW.`article_id`
					AND `published`.`id` = NEW.`published_revision_id`
					AND `published`.`revision_number` = NEW.`published_revision_number`
					AND `published`.`category_id` = `article`.`category_id`
					AND `published`.`slug` = `article`.`slug`
					AND `published`.`title` = `article`.`title`
					AND `published`.`mdx` = `article`.`mdx`
					AND `published`.`is_faq` = `article`.`is_faq`
					AND `published`.`author_name` = `article`.`author_name`
					AND `published`.`position` = `article`.`position`
			))
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ARTICLE_HEAD_INVALID');
END;--> statement-breakpoint
CREATE TRIGGER `article_heads_integrity_update_trigger`
BEFORE UPDATE ON `article_heads`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `articles` AS `article`
	INNER JOIN `article_revisions` AS `working`
		ON `working`.`workspace_id` = NEW.`workspace_id`
		AND `working`.`article_id` = NEW.`article_id`
		AND `working`.`id` = NEW.`working_revision_id`
		AND `working`.`revision_number` = NEW.`working_revision_number`
	INNER JOIN `article_slug_claims` AS `working_claim`
		ON `working_claim`.`workspace_id` = NEW.`workspace_id`
		AND `working_claim`.`normalized_slug` = NEW.`working_slug`
		AND `working_claim`.`article_id` = NEW.`article_id`
		AND `working_claim`.`working_claim` = 1
	INNER JOIN `article_slug_claims` AS `row_claim`
		ON `row_claim`.`workspace_id` = `article`.`workspace_id`
		AND `row_claim`.`normalized_slug` = `article`.`slug`
		AND `row_claim`.`article_id` = `article`.`id`
		AND `row_claim`.`article_row_claim` = 1
	WHERE `article`.`workspace_id` = NEW.`workspace_id`
		AND `article`.`id` = NEW.`article_id`
		AND `working`.`slug` = NEW.`working_slug`
		AND (NEW.`review_state` <> 'published' OR `article`.`status` = 'published')
		AND (
			`article`.`status` <> 'published'
			OR (NEW.`archived_at` IS NULL AND EXISTS (
				SELECT 1
				FROM `article_revisions` AS `published`
				WHERE `published`.`workspace_id` = NEW.`workspace_id`
					AND `published`.`article_id` = NEW.`article_id`
					AND `published`.`id` = NEW.`published_revision_id`
					AND `published`.`revision_number` = NEW.`published_revision_number`
					AND `published`.`category_id` = `article`.`category_id`
					AND `published`.`slug` = `article`.`slug`
					AND `published`.`title` = `article`.`title`
					AND `published`.`mdx` = `article`.`mdx`
					AND `published`.`is_faq` = `article`.`is_faq`
					AND `published`.`author_name` = `article`.`author_name`
					AND `published`.`position` = `article`.`position`
			))
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ARTICLE_HEAD_INVALID');
END;--> statement-breakpoint
ALTER TABLE `categories` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `themes` ADD `version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `team_authoring_backfill_assertions_insert_trigger`
INSTEAD OF INSERT ON `team_authoring_backfill_assertions`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_BACKFILL_MISMATCH')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `articles` AS `article`
		INNER JOIN `categories` AS `category`
			ON `category`.`id` = `article`.`category_id`
			AND `category`.`workspace_id` = `article`.`workspace_id`
		INNER JOIN `article_revisions` AS `revision`
			ON `revision`.`workspace_id` = `article`.`workspace_id`
			AND `revision`.`article_id` = `article`.`id`
			AND `revision`.`id` = NEW.`revision_id`
			AND `revision`.`revision_number` = 1
		INNER JOIN `article_slug_claims` AS `claim`
			ON `claim`.`workspace_id` = `article`.`workspace_id`
			AND `claim`.`normalized_slug` = `article`.`slug`
			AND `claim`.`article_id` = `article`.`id`
			AND `claim`.`working_claim` = 1
			AND `claim`.`article_row_claim` = 1
		INNER JOIN `article_heads` AS `head`
			ON `head`.`workspace_id` = `article`.`workspace_id`
			AND `head`.`article_id` = `article`.`id`
		WHERE `article`.`workspace_id` = NEW.`workspace_id`
			AND `article`.`id` = NEW.`article_id`
			AND `revision`.`category_id` = `article`.`category_id`
			AND `revision`.`category_slug` = `category`.`slug`
			AND `revision`.`category_name` = `category`.`name`
			AND `revision`.`slug` = `article`.`slug`
			AND `revision`.`title` = `article`.`title`
			AND `revision`.`mdx` = `article`.`mdx`
			AND `revision`.`is_faq` = `article`.`is_faq`
			AND `revision`.`author_name` = `article`.`author_name`
			AND `revision`.`position` = `article`.`position`
			AND `revision`.`revision_hash` = NEW.`revision_hash`
			AND `revision`.`change_kind` = 'migration'
			AND `revision`.`created_by_member_id` IS NULL
			AND `revision`.`created_by_system_label` = 'OPAS migration'
			AND `revision`.`change_summary` IS NULL
			AND `revision`.`restored_from_revision_id` IS NULL
			AND `revision`.`created_at` = `article`.`updated_at`
			AND `head`.`working_revision_id` = NEW.`revision_id`
			AND `head`.`working_revision_number` = 1
			AND `head`.`working_slug` = `article`.`slug`
			AND `head`.`submitted_by_member_id` IS NULL
			AND `head`.`archived_at` IS NULL
			AND `head`.`archived_by_member_id` IS NULL
			AND (
				(`article`.`status` = 'published'
					AND `head`.`published_revision_id` = NEW.`revision_id`
					AND `head`.`published_revision_number` = 1
					AND `head`.`review_state` = 'published')
				OR
				(`article`.`status` = 'draft'
					AND `head`.`published_revision_id` IS NULL
					AND `head`.`published_revision_number` IS NULL
					AND `head`.`review_state` = 'editing')
			)
	);

	SELECT RAISE(ABORT, 'AUTHORING_BACKFILL_MISMATCH')
	WHERE EXISTS (
		SELECT `asset_id`
		FROM `article_revision_assets`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `article_id` = NEW.`article_id`
			AND `revision_id` = NEW.`revision_id`
			AND `revision_number` = 1
		EXCEPT
		SELECT `asset_id`
		FROM `article_assets`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `article_id` = NEW.`article_id`
	) OR EXISTS (
		SELECT `asset_id`
		FROM `article_assets`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `article_id` = NEW.`article_id`
		EXCEPT
		SELECT `asset_id`
		FROM `article_revision_assets`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `article_id` = NEW.`article_id`
			AND `revision_id` = NEW.`revision_id`
			AND `revision_number` = 1
	);
END;
