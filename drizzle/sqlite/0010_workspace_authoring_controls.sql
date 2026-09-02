CREATE TABLE `workspace_authoring_controls` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`writes_paused` integer DEFAULT false NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`changed_by_member_id` text,
	`changed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_authoring_controls_writes_paused_check" CHECK("workspace_authoring_controls"."writes_paused" in (0, 1)),
	CONSTRAINT "workspace_authoring_controls_generation_check" CHECK("workspace_authoring_controls"."generation" >= 0)
);
--> statement-breakpoint
INSERT INTO `workspace_authoring_controls` (
	`workspace_id`,
	`writes_paused`,
	`generation`,
	`changed_by_member_id`,
	`changed_at`
)
SELECT `id`, 0, 0, NULL, unixepoch() * 1000
FROM `workspaces`
WHERE 1
ON CONFLICT (`workspace_id`) DO NOTHING;
--> statement-breakpoint
CREATE VIEW `workspace_authoring_assertions` AS
SELECT `workspace_id`
FROM `workspace_authoring_controls`
WHERE 0;
--> statement-breakpoint
CREATE TRIGGER `workspace_authoring_assertions_insert_trigger`
INSTEAD OF INSERT ON `workspace_authoring_assertions`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `workspace_authoring_controls`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `writes_paused` = 0
	);
END;
--> statement-breakpoint
CREATE TRIGGER `workspaces_authoring_control_insert_trigger`
AFTER INSERT ON `workspaces`
FOR EACH ROW
BEGIN
	INSERT INTO `workspace_authoring_controls` (
		`workspace_id`,
		`writes_paused`,
		`generation`,
		`changed_by_member_id`,
		`changed_at`
	)
	VALUES (NEW.`id`, 0, 0, NULL, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `workspaces_authoring_control_delete_trigger`
BEFORE DELETE ON `workspaces`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `categories_authoring_control_insert_trigger`
BEFORE INSERT ON `categories`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `categories_authoring_control_update_trigger`
BEFORE UPDATE ON `categories`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `categories_authoring_control_delete_trigger`
BEFORE DELETE ON `categories`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `articles_authoring_control_insert_trigger`
BEFORE INSERT ON `articles`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `articles_authoring_control_update_trigger`
BEFORE UPDATE ON `articles`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `articles_authoring_control_delete_trigger`
BEFORE DELETE ON `articles`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `themes_authoring_control_insert_trigger`
BEFORE INSERT ON `themes`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `themes_authoring_control_update_trigger`
BEFORE UPDATE ON `themes`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `themes_authoring_control_delete_trigger`
BEFORE DELETE ON `themes`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifests_authoring_control_insert_trigger`
BEFORE INSERT ON `asset_manifests`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifests_authoring_control_update_trigger`
BEFORE UPDATE ON `asset_manifests`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifests_authoring_control_delete_trigger`
BEFORE DELETE ON `asset_manifests`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifest_items_authoring_control_insert_trigger`
BEFORE INSERT ON `asset_manifest_items`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifest_items_authoring_control_update_trigger`
BEFORE UPDATE ON `asset_manifest_items`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_manifest_items_authoring_control_delete_trigger`
BEFORE DELETE ON `asset_manifest_items`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_authoring_control_insert_trigger`
BEFORE INSERT ON `assets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_authoring_control_update_trigger`
BEFORE UPDATE ON `assets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_authoring_control_delete_trigger`
BEFORE DELETE ON `assets`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `article_assets_authoring_control_insert_trigger`
BEFORE INSERT ON `article_assets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `article_assets_authoring_control_update_trigger`
BEFORE UPDATE ON `article_assets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `article_assets_authoring_control_delete_trigger`
BEFORE DELETE ON `article_assets`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_index_states_authoring_control_insert_trigger`
BEFORE INSERT ON `workspace_index_states`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_index_states_authoring_control_update_trigger`
BEFORE UPDATE ON `workspace_index_states`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_index_states_authoring_control_delete_trigger`
BEFORE DELETE ON `workspace_index_states`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_chunks_authoring_control_insert_trigger`
BEFORE INSERT ON `evidence_chunks`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_chunks_authoring_control_update_trigger`
BEFORE UPDATE ON `evidence_chunks`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_chunks_authoring_control_delete_trigger`
BEFORE DELETE ON `evidence_chunks`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_generations_authoring_control_insert_trigger`
BEFORE INSERT ON `embedding_generations`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_generations_authoring_control_update_trigger`
BEFORE UPDATE ON `embedding_generations`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_generations_authoring_control_delete_trigger`
BEFORE DELETE ON `embedding_generations`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `chunk_embeddings_authoring_control_insert_trigger`
BEFORE INSERT ON `chunk_embeddings`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `chunk_embeddings_authoring_control_update_trigger`
BEFORE UPDATE ON `chunk_embeddings`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `chunk_embeddings_authoring_control_delete_trigger`
BEFORE DELETE ON `chunk_embeddings`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_jobs_authoring_control_insert_trigger`
BEFORE INSERT ON `embedding_jobs`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_jobs_authoring_control_update_trigger`
BEFORE UPDATE ON `embedding_jobs`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `embedding_jobs_authoring_control_delete_trigger`
BEFORE DELETE ON `embedding_jobs`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_question_sets_authoring_control_insert_trigger`
BEFORE INSERT ON `saved_question_sets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_question_sets_authoring_control_update_trigger`
BEFORE UPDATE ON `saved_question_sets`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `saved_question_sets_authoring_control_delete_trigger`
BEFORE DELETE ON `saved_question_sets`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evaluation_runs_authoring_control_insert_trigger`
BEFORE INSERT ON `evaluation_runs`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evaluation_runs_authoring_control_update_trigger`
BEFORE UPDATE ON `evaluation_runs`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
) OR NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
--> statement-breakpoint
CREATE TRIGGER `evaluation_runs_authoring_control_delete_trigger`
BEFORE DELETE ON `evaluation_runs`
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
	AND NOT EXISTS (
	SELECT 1
	FROM `workspace_authoring_controls`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `writes_paused` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'AUTHORING_PAUSED');
END;
