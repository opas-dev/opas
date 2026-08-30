CREATE TABLE `support_handoffs` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`contact` text NOT NULL,
	`context` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`id`, `workspace_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "support_handoffs_identity_check" CHECK(length("support_handoffs"."id") = 36 and length("support_handoffs"."payload_hash") = 64),
	CONSTRAINT "support_handoffs_status_check" CHECK("support_handoffs"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "support_handoffs_json_check" CHECK(json_valid("support_handoffs"."contact") and json_type("support_handoffs"."contact") = 'object' and json_valid("support_handoffs"."context") and json_type("support_handoffs"."context") = 'object'),
	CONSTRAINT "support_handoffs_lifecycle_check" CHECK(("support_handoffs"."status" = 'pending' and "support_handoffs"."finished_at" is null) or ("support_handoffs"."status" <> 'pending' and "support_handoffs"."finished_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `support_handoffs_workspace_status_created_index` ON `support_handoffs` (`workspace_id`,`status`,`created_at`);