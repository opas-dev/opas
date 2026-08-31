CREATE TABLE `public_outcome_write_windows` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`write_count` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_outcome_write_windows_count_check" CHECK("public_outcome_write_windows"."write_count" between 1 and 300)
);
