CREATE TABLE `conversation_analytics` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`conversation` text NOT NULL,
	`retrieval_trace` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`duration_milliseconds` integer NOT NULL,
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
	CONSTRAINT "conversation_analytics_identity_check" CHECK(length("conversation_analytics"."id") = 36 and length("conversation_analytics"."provider") between 1 and 64 and length("conversation_analytics"."model") between 1 and 256),
	CONSTRAINT "conversation_analytics_outcome_check" CHECK("conversation_analytics"."outcome" in ('abandoned', 'abstained', 'answered', 'escalated', 'low-rated')),
	CONSTRAINT "conversation_analytics_reason_check" CHECK("conversation_analytics"."reason" is null or length(cast("conversation_analytics"."reason" as blob)) <= 256),
	CONSTRAINT "conversation_analytics_json_check" CHECK(json_valid("conversation_analytics"."conversation") and json_type("conversation_analytics"."conversation") = 'array' and json_valid("conversation_analytics"."retrieval_trace") and json_type("conversation_analytics"."retrieval_trace") = 'array' and length(cast("conversation_analytics"."conversation" as blob)) <= 16384 and length(cast("conversation_analytics"."retrieval_trace" as blob)) <= 8192),
	CONSTRAINT "conversation_analytics_measurements_check" CHECK("conversation_analytics"."duration_milliseconds" between 0 and 300000 and ("conversation_analytics"."input_tokens" is null or "conversation_analytics"."input_tokens" between 0 and 1000000) and ("conversation_analytics"."output_tokens" is null or "conversation_analytics"."output_tokens" between 0 and 1000000) and ("conversation_analytics"."cost_microdollars" is null or "conversation_analytics"."cost_microdollars" between 0 and 2000000000)),
	CONSTRAINT "conversation_analytics_bucket_check" CHECK(length("conversation_analytics"."bucket_day") = 8 and "conversation_analytics"."bucket_day" not glob '*[^0-9]*' and "conversation_analytics"."bucket_slot" between 0 and 1023),
	CONSTRAINT "conversation_analytics_lifecycle_check" CHECK("conversation_analytics"."updated_at" >= "conversation_analytics"."started_at" and "conversation_analytics"."expires_at" > "conversation_analytics"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_analytics_workspace_bucket_unique` ON `conversation_analytics` (`workspace_id`,`bucket_day`,`bucket_slot`);--> statement-breakpoint
CREATE INDEX `conversation_analytics_workspace_expiry_index` ON `conversation_analytics` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `conversation_analytics_workspace_started_index` ON `conversation_analytics` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `public_write_reservations` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`id`, `workspace_id`, `kind`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_public_write_states`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_write_reservations_identity_check" CHECK(length("public_write_reservations"."id") = 36 and "public_write_reservations"."kind" = 'handoff'),
	CONSTRAINT "public_write_reservations_lifecycle_check" CHECK("public_write_reservations"."expires_at" > "public_write_reservations"."created_at")
);
--> statement-breakpoint
CREATE INDEX `public_write_reservations_workspace_kind_created_index` ON `public_write_reservations` (`workspace_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_write_reservations_workspace_expiry_index` ON `public_write_reservations` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `workspace_public_write_states` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
