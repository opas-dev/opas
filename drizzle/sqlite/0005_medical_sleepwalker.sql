CREATE TABLE `answer_inference_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`maximum_output_tokens` integer NOT NULL,
	`reserved_microdollars` integer NOT NULL,
	`charged_microdollars` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`reconciled_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_inference_states`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "answer_inference_leases_identity_check" CHECK(length("answer_inference_leases"."provider") between 1 and 64 and length("answer_inference_leases"."model") between 1 and 256),
	CONSTRAINT "answer_inference_leases_amount_check" CHECK("answer_inference_leases"."maximum_output_tokens" between 1 and 8192 and "answer_inference_leases"."reserved_microdollars" between 1 and 2000000000 and ("answer_inference_leases"."charged_microdollars" is null or "answer_inference_leases"."charged_microdollars" between 0 and "answer_inference_leases"."reserved_microdollars")),
	CONSTRAINT "answer_inference_leases_usage_check" CHECK(("answer_inference_leases"."input_tokens" is null or "answer_inference_leases"."input_tokens" >= 0) and ("answer_inference_leases"."output_tokens" is null or "answer_inference_leases"."output_tokens" >= 0)),
	CONSTRAINT "answer_inference_leases_status_check" CHECK("answer_inference_leases"."status" in ('active', 'cancelled', 'completed', 'expired', 'failed', 'invalid-output', 'timeout')),
	CONSTRAINT "answer_inference_leases_lifecycle_check" CHECK(("answer_inference_leases"."status" = 'active' and "answer_inference_leases"."charged_microdollars" is null and "answer_inference_leases"."reconciled_at" is null) or ("answer_inference_leases"."status" <> 'active' and "answer_inference_leases"."charged_microdollars" is not null and "answer_inference_leases"."reconciled_at" is not null)),
	CONSTRAINT "answer_inference_leases_expiry_check" CHECK("answer_inference_leases"."expires_at" > "answer_inference_leases"."started_at" and ("answer_inference_leases"."status" <> 'expired' or "answer_inference_leases"."charged_microdollars" = "answer_inference_leases"."reserved_microdollars"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answer_inference_leases_id_workspace_unique` ON `answer_inference_leases` (`id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `answer_inference_leases_workspace_status_expires_index` ON `answer_inference_leases` (`workspace_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `answer_inference_leases_workspace_started_index` ON `answer_inference_leases` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workspace_inference_states` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
