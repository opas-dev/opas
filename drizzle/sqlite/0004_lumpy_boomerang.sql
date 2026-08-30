ALTER TABLE `articles` ADD `content_hash` text CONSTRAINT `articles_content_hash_check` CHECK (`content_hash` is null or length(`content_hash`) = 64);--> statement-breakpoint
CREATE INDEX `articles_workspace_status_content_hash_index` ON `articles` (`workspace_id`,`status`,`content_hash`);--> statement-breakpoint
CREATE INDEX `embedding_generations_reconciliation_index` ON `embedding_generations` (`workspace_id`,`status`,`provider`,`model`,`dimension`,`configuration_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_jobs_generation_article_hash_unique` ON `embedding_jobs` (`workspace_id`,`article_id`,`article_content_hash`,`embedding_generation_id`);--> statement-breakpoint
CREATE INDEX `embedding_jobs_generation_claim_index` ON `embedding_jobs` (`workspace_id`,`embedding_generation_id`,`status`,`available_at`,`lease_expires_at`);
