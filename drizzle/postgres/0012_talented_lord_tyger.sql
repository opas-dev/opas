-- ABOUTME: Adds submitter attribution and optimistic versions to authoring records.
-- ABOUTME: Requires every existing workspace paused before the PostgreSQL schema delta.
DO $$
BEGIN
	LOCK TABLE "workspaces" IN SHARE MODE;
	PERFORM 1
	FROM "workspace_authoring_controls"
	ORDER BY "workspace_id"
	FOR UPDATE;

	IF EXISTS (
		SELECT 1
		FROM "workspaces" AS "workspaces"
		LEFT JOIN "workspace_authoring_controls" AS "controls"
			ON "controls"."workspace_id" = "workspaces"."id"
		WHERE "controls"."workspace_id" IS NULL
			OR NOT "controls"."writes_paused"
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'AUTHORING_MIGRATION_REQUIRES_PAUSE',
			ERRCODE = 'P0001';
	END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "article_heads" ADD COLUMN "submitted_by_member_id" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_submitted_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("submitted_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_submitter_check" CHECK (("article_heads"."review_state" = 'in_review' and "article_heads"."submitted_by_member_id" is not null) or ("article_heads"."review_state" <> 'in_review' and "article_heads"."submitted_by_member_id" is null));
