PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_analytics` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`conversation` text NOT NULL,
	`retrieval_trace` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`duration_milliseconds` integer NOT NULL,
	`first_token_milliseconds` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_microdollars` integer,
	`bucket_day` text NOT NULL,
	`bucket_slot` integer NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`id`, `workspace_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_analytics_identity_check" CHECK(length("__new_conversation_analytics"."id") = 36 and length("__new_conversation_analytics"."provider") between 1 and 64 and length("__new_conversation_analytics"."model") between 1 and 256),
	CONSTRAINT "conversation_analytics_outcome_check" CHECK("__new_conversation_analytics"."outcome" in ('abandoned', 'abstained', 'answered', 'escalated', 'low-rated')),
	CONSTRAINT "conversation_analytics_reason_check" CHECK("__new_conversation_analytics"."reason" is null or length(cast("__new_conversation_analytics"."reason" as blob)) <= 256),
	CONSTRAINT "conversation_analytics_json_check" CHECK(json_valid("__new_conversation_analytics"."conversation") and json_type("__new_conversation_analytics"."conversation") = 'array' and json_valid("__new_conversation_analytics"."retrieval_trace") and json_type("__new_conversation_analytics"."retrieval_trace") = 'array' and length(cast("__new_conversation_analytics"."conversation" as blob)) <= 16384 and length(cast("__new_conversation_analytics"."retrieval_trace" as blob)) <= 8192),
	CONSTRAINT "conversation_analytics_measurements_check" CHECK("__new_conversation_analytics"."duration_milliseconds" between 0 and 300000 and ("__new_conversation_analytics"."first_token_milliseconds" is null or "__new_conversation_analytics"."first_token_milliseconds" between 0 and "__new_conversation_analytics"."duration_milliseconds") and ("__new_conversation_analytics"."input_tokens" is null or "__new_conversation_analytics"."input_tokens" between 0 and 1000000) and ("__new_conversation_analytics"."output_tokens" is null or "__new_conversation_analytics"."output_tokens" between 0 and 1000000) and ("__new_conversation_analytics"."cost_microdollars" is null or "__new_conversation_analytics"."cost_microdollars" between 0 and 2000000000)),
	CONSTRAINT "conversation_analytics_bucket_check" CHECK(length("__new_conversation_analytics"."bucket_day") = 8 and "__new_conversation_analytics"."bucket_day" not glob '*[^0-9]*' and "__new_conversation_analytics"."bucket_slot" between 0 and 1023),
	CONSTRAINT "conversation_analytics_lifecycle_check" CHECK("__new_conversation_analytics"."updated_at" >= "__new_conversation_analytics"."started_at" and "__new_conversation_analytics"."expires_at" > "__new_conversation_analytics"."started_at")
);
--> statement-breakpoint
INSERT INTO `__new_conversation_analytics`("id", "workspace_id", "outcome", "reason", "conversation", "retrieval_trace", "provider", "model", "duration_milliseconds", "first_token_milliseconds", "input_tokens", "output_tokens", "cost_microdollars", "bucket_day", "bucket_slot", "started_at", "updated_at", "expires_at") SELECT "id", "workspace_id", "outcome", "reason", "conversation", "retrieval_trace", "provider", "model", "duration_milliseconds", NULL, "input_tokens", "output_tokens", "cost_microdollars", "bucket_day", "bucket_slot", "started_at", "updated_at", "expires_at" FROM `conversation_analytics`;--> statement-breakpoint
DROP TABLE `conversation_analytics`;--> statement-breakpoint
ALTER TABLE `__new_conversation_analytics` RENAME TO `conversation_analytics`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_analytics_workspace_bucket_unique` ON `conversation_analytics` (`workspace_id`,`bucket_day`,`bucket_slot`);--> statement-breakpoint
CREATE INDEX `conversation_analytics_workspace_expiry_index` ON `conversation_analytics` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `conversation_analytics_workspace_started_index` ON `conversation_analytics` (`workspace_id`,`started_at`);
