-- ABOUTME: Adds the paused-fence team-authoring identity, revision, workflow, and preview schema.
-- ABOUTME: Requires every existing workspace paused before any additive PostgreSQL delta.
DO $$
BEGIN
	LOCK TABLE "workspaces" IN SHARE MODE;
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

	PERFORM 1
	FROM "workspace_authoring_controls"
	ORDER BY "workspace_id"
	FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE TABLE "admin_login_windows" (
	"workspace_id" text NOT NULL,
	"dimension" text NOT NULL,
	"key_digest" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_login_windows_workspace_id_dimension_key_digest_window_started_at_pk" PRIMARY KEY("workspace_id","dimension","key_digest","window_started_at"),
	CONSTRAINT "admin_login_windows_dimension_check" CHECK ("admin_login_windows"."dimension" in ('source', 'source_principal', 'principal', 'workspace')),
	CONSTRAINT "admin_login_windows_digest_check" CHECK (length("admin_login_windows"."key_digest") = 64 and "admin_login_windows"."key_digest" = lower("admin_login_windows"."key_digest") and "admin_login_windows"."key_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_login_windows_count_check" CHECK ("admin_login_windows"."count" >= 0),
	CONSTRAINT "admin_login_windows_time_check" CHECK ("admin_login_windows"."expires_at" > "admin_login_windows"."window_started_at" and "admin_login_windows"."expires_at" <= "admin_login_windows"."window_started_at" + interval '24 hours' and ("admin_login_windows"."blocked_until" is null or ("admin_login_windows"."blocked_until" >= "admin_login_windows"."window_started_at" and "admin_login_windows"."blocked_until" <= "admin_login_windows"."expires_at")))
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_sessions_id_check" CHECK (length("admin_sessions"."id") = 43 and "admin_sessions"."id" ~ '^[0-9A-Za-z_-]{43}$'),
	CONSTRAINT "admin_sessions_time_check" CHECK ("admin_sessions"."expires_at" > "admin_sessions"."created_at" and "admin_sessions"."expires_at" <= "admin_sessions"."created_at" + interval '8 hours' and ("admin_sessions"."revoked_at" is null or "admin_sessions"."revoked_at" >= "admin_sessions"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "article_heads" (
	"article_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"working_revision_id" text NOT NULL,
	"working_revision_number" integer NOT NULL,
	"working_slug" text NOT NULL,
	"published_revision_id" text,
	"published_revision_number" integer,
	"review_state" text NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_member_id" text,
	CONSTRAINT "article_heads_article_id_workspace_id_pk" PRIMARY KEY("article_id","workspace_id"),
	CONSTRAINT "article_heads_working_number_check" CHECK ("article_heads"."working_revision_number" >= 1),
	CONSTRAINT "article_heads_published_pointer_check" CHECK (("article_heads"."published_revision_id" is null and "article_heads"."published_revision_number" is null) or ("article_heads"."published_revision_id" is not null and "article_heads"."published_revision_number" is not null and "article_heads"."published_revision_number" >= 1)),
	CONSTRAINT "article_heads_archive_check" CHECK (("article_heads"."archived_at" is null and "article_heads"."archived_by_member_id" is null) or ("article_heads"."archived_at" is not null and "article_heads"."archived_by_member_id" is not null)),
	CONSTRAINT "article_heads_review_state_check" CHECK ("article_heads"."review_state" in ('editing', 'in_review', 'changes_requested', 'approved', 'published')),
	CONSTRAINT "article_heads_published_state_check" CHECK ("article_heads"."review_state" <> 'published' or ("article_heads"."archived_at" is null and "article_heads"."published_revision_id" is not null and "article_heads"."published_revision_number" is not null and "article_heads"."published_revision_id" = "article_heads"."working_revision_id" and "article_heads"."published_revision_number" = "article_heads"."working_revision_number"))
);
--> statement-breakpoint
CREATE TABLE "article_preview_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_preview_grants_id_check" CHECK (length("article_preview_grants"."id") = 43 and "article_preview_grants"."id" ~ '^[0-9A-Za-z_-]{43}$'),
	CONSTRAINT "article_preview_grants_expiry_check" CHECK ("article_preview_grants"."expires_at" = "article_preview_grants"."created_at" + interval '7 days'),
	CONSTRAINT "article_preview_grants_revocation_check" CHECK (("article_preview_grants"."revoked_at" is null and "article_preview_grants"."revoked_by_member_id" is null) or ("article_preview_grants"."revoked_at" is not null and "article_preview_grants"."revoked_by_member_id" is not null and "article_preview_grants"."revoked_at" >= "article_preview_grants"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "article_review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"article_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"member_id" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_review_events_action_check" CHECK ("article_review_events"."action" in ('submitted', 'withdrawn', 'changes_requested', 'category_changed', 'approved', 'published', 'unpublished', 'archived', 'restored', 'emergency_published')),
	CONSTRAINT "article_review_events_note_check" CHECK ("article_review_events"."note" is null or length("article_review_events"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "article_revision_assets" (
	"workspace_id" text NOT NULL,
	"article_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"asset_id" text NOT NULL,
	CONSTRAINT "article_revision_assets_revision_id_asset_id_pk" PRIMARY KEY("revision_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "article_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"article_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"category_id" text NOT NULL,
	"category_slug" text NOT NULL,
	"category_name" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"mdx" text NOT NULL,
	"is_faq" boolean NOT NULL,
	"author_name" text NOT NULL,
	"position" integer NOT NULL,
	"revision_hash" text NOT NULL,
	"change_kind" text NOT NULL,
	"created_by_member_id" text,
	"created_by_system_label" text,
	"change_summary" text,
	"created_at" timestamp with time zone NOT NULL,
	"restored_from_revision_id" text,
	CONSTRAINT "article_revisions_number_check" CHECK ("article_revisions"."revision_number" >= 1),
	CONSTRAINT "article_revisions_snapshot_check" CHECK (length("article_revisions"."category_id") >= 1 and length("article_revisions"."category_slug") between 1 and 120 and length("article_revisions"."category_name") between 1 and 100 and length("article_revisions"."slug") between 1 and 120 and length("article_revisions"."title") between 1 and 160 and octet_length("article_revisions"."mdx") <= 100000 and length("article_revisions"."author_name") between 1 and 100 and "article_revisions"."position" between 0 and 10000),
	CONSTRAINT "article_revisions_hash_check" CHECK (length("article_revisions"."revision_hash") = 64 and "article_revisions"."revision_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "article_revisions_change_kind_check" CHECK ("article_revisions"."change_kind" in ('manual', 'import', 'rollback', 'migration', 'seed')),
	CONSTRAINT "article_revisions_actor_check" CHECK (("article_revisions"."change_kind" = 'migration' and "article_revisions"."created_by_member_id" is null and "article_revisions"."created_by_system_label" is not null and "article_revisions"."created_by_system_label" = 'OPAS migration') or ("article_revisions"."change_kind" <> 'migration' and "article_revisions"."created_by_member_id" is not null and "article_revisions"."created_by_system_label" is null)),
	CONSTRAINT "article_revisions_summary_check" CHECK ("article_revisions"."change_summary" is null or length("article_revisions"."change_summary") <= 500),
	CONSTRAINT "article_revisions_restore_check" CHECK (("article_revisions"."change_kind" = 'rollback' and "article_revisions"."restored_from_revision_id" is not null) or ("article_revisions"."change_kind" <> 'rollback' and "article_revisions"."restored_from_revision_id" is null))
);
--> statement-breakpoint
CREATE TABLE "article_slug_claims" (
	"workspace_id" text NOT NULL,
	"normalized_slug" text NOT NULL,
	"article_id" text NOT NULL,
	"working_claim" boolean NOT NULL,
	"article_row_claim" boolean NOT NULL,
	CONSTRAINT "article_slug_claims_workspace_id_normalized_slug_pk" PRIMARY KEY("workspace_id","normalized_slug"),
	CONSTRAINT "article_slug_claims_slug_check" CHECK ("article_slug_claims"."normalized_slug" = lower(trim("article_slug_claims"."normalized_slug")) and length("article_slug_claims"."normalized_slug") between 1 and 120),
	CONSTRAINT "article_slug_claims_owner_check" CHECK ("article_slug_claims"."working_claim" or "article_slug_claims"."article_row_claim")
);
--> statement-breakpoint
CREATE TABLE "member_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"normalized_email" text NOT NULL,
	"target_role" text,
	"member_id" text,
	"token_digest" text NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_invitations_kind_check" CHECK ("member_invitations"."kind" in ('invite', 'credential_reset')),
	CONSTRAINT "member_invitations_email_check" CHECK ("member_invitations"."normalized_email" = lower(trim("member_invitations"."normalized_email")) and length("member_invitations"."normalized_email") between 3 and 320),
	CONSTRAINT "member_invitations_target_check" CHECK (("member_invitations"."kind" = 'invite' and "member_invitations"."target_role" is not null and "member_invitations"."target_role" in ('administrator', 'editor', 'reviewer') and "member_invitations"."member_id" is null) or ("member_invitations"."kind" = 'credential_reset' and "member_invitations"."target_role" is null and "member_invitations"."member_id" is not null)),
	CONSTRAINT "member_invitations_creator_check" CHECK ("member_invitations"."created_by_member_id" is not null or ("member_invitations"."kind" = 'invite' and "member_invitations"."target_role" is not null and "member_invitations"."target_role" = 'administrator' and "member_invitations"."member_id" is null) or ("member_invitations"."kind" = 'credential_reset' and "member_invitations"."target_role" is null and "member_invitations"."member_id" is not null)),
	CONSTRAINT "member_invitations_digest_check" CHECK (length("member_invitations"."token_digest") = 64 and "member_invitations"."token_digest" = lower("member_invitations"."token_digest") and "member_invitations"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "member_invitations_expiry_check" CHECK (("member_invitations"."kind" = 'invite' and "member_invitations"."expires_at" = "member_invitations"."created_at" + interval '48 hours') or ("member_invitations"."kind" = 'credential_reset' and "member_invitations"."expires_at" = "member_invitations"."created_at" + interval '1 hour')),
	CONSTRAINT "member_invitations_lifecycle_check" CHECK (not ("member_invitations"."accepted_at" is not null and "member_invitations"."revoked_at" is not null) and ("member_invitations"."accepted_at" is null or ("member_invitations"."accepted_at" >= "member_invitations"."created_at" and "member_invitations"."accepted_at" <= "member_invitations"."expires_at")) and ("member_invitations"."revoked_at" is null or "member_invitations"."revoked_at" >= "member_invitations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_authoring_migrations" (
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"article_count" integer NOT NULL,
	"projection_hash" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_authoring_migrations_workspace_id_version_pk" PRIMARY KEY("workspace_id","version"),
	CONSTRAINT "workspace_authoring_migrations_values_check" CHECK ("workspace_authoring_migrations"."version" >= 1 and "workspace_authoring_migrations"."article_count" >= 0 and length("workspace_authoring_migrations"."projection_hash") = 64 and "workspace_authoring_migrations"."projection_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"password_salt" text NOT NULL,
	"password_digest" text NOT NULL,
	"password_iterations" integer NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "workspace_members_email_check" CHECK ("workspace_members"."normalized_email" = lower(trim("workspace_members"."normalized_email")) and length("workspace_members"."normalized_email") between 3 and 320),
	CONSTRAINT "workspace_members_display_name_check" CHECK (length("workspace_members"."display_name") between 1 and 100),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('administrator', 'editor', 'reviewer')),
	CONSTRAINT "workspace_members_status_check" CHECK ("workspace_members"."status" in ('active', 'disabled')),
	CONSTRAINT "workspace_members_password_check" CHECK (length("workspace_members"."password_salt") = 43 and length("workspace_members"."password_digest") = 43 and "workspace_members"."password_salt" ~ '^[0-9A-Za-z_-]{43}$' and "workspace_members"."password_digest" ~ '^[0-9A-Za-z_-]{43}$' and "workspace_members"."password_iterations" = 600000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "article_revisions_workspace_article_number_unique" ON "article_revisions" USING btree ("workspace_id","article_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "article_revisions_workspace_article_identity_unique" ON "article_revisions" USING btree ("workspace_id","article_id","id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "article_revisions_workspace_identity_unique" ON "article_revisions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_revisions_workspace_article_id_unique" ON "article_revisions" USING btree ("workspace_id","article_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_slug_claims_workspace_slug_article_unique" ON "article_slug_claims" USING btree ("workspace_id","normalized_slug","article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_id_workspace_unique" ON "workspace_members" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "admin_login_windows" ADD CONSTRAINT "admin_login_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_workspace_id_article_id_working_revision_id_working_revision_number_article_revisions_workspace_id_article_id_id_revision_number_fk" FOREIGN KEY ("workspace_id","article_id","working_revision_id","working_revision_number") REFERENCES "public"."article_revisions"("workspace_id","article_id","id","revision_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_workspace_id_article_id_published_revision_id_published_revision_number_article_revisions_workspace_id_article_id_id_revision_number_fk" FOREIGN KEY ("workspace_id","article_id","published_revision_id","published_revision_number") REFERENCES "public"."article_revisions"("workspace_id","article_id","id","revision_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_workspace_id_working_slug_article_id_article_slug_claims_workspace_id_normalized_slug_article_id_fk" FOREIGN KEY ("workspace_id","working_slug","article_id") REFERENCES "public"."article_slug_claims"("workspace_id","normalized_slug","article_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_heads" ADD CONSTRAINT "article_heads_archived_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("archived_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_preview_grants" ADD CONSTRAINT "article_preview_grants_workspace_id_revision_id_article_revisions_workspace_id_id_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "public"."article_revisions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_preview_grants" ADD CONSTRAINT "article_preview_grants_created_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("created_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_preview_grants" ADD CONSTRAINT "article_preview_grants_revoked_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("revoked_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_review_events" ADD CONSTRAINT "article_review_events_workspace_id_article_id_revision_id_revision_number_article_revisions_workspace_id_article_id_id_revision_number_fk" FOREIGN KEY ("workspace_id","article_id","revision_id","revision_number") REFERENCES "public"."article_revisions"("workspace_id","article_id","id","revision_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_review_events" ADD CONSTRAINT "article_review_events_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision_assets" ADD CONSTRAINT "article_revision_assets_workspace_id_article_id_revision_id_revision_number_article_revisions_workspace_id_article_id_id_revision_number_fk" FOREIGN KEY ("workspace_id","article_id","revision_id","revision_number") REFERENCES "public"."article_revisions"("workspace_id","article_id","id","revision_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision_assets" ADD CONSTRAINT "article_revision_assets_asset_id_workspace_id_assets_id_workspace_id_fk" FOREIGN KEY ("asset_id","workspace_id") REFERENCES "public"."assets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_created_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("created_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_workspace_id_article_id_restored_from_revision_id_article_revisions_workspace_id_article_id_id_fk" FOREIGN KEY ("workspace_id","article_id","restored_from_revision_id") REFERENCES "public"."article_revisions"("workspace_id","article_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_slug_claims" ADD CONSTRAINT "article_slug_claims_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_created_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("created_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_authoring_migrations" ADD CONSTRAINT "workspace_authoring_migrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_created_by_member_id_workspace_id_workspace_members_id_workspace_id_fk" FOREIGN KEY ("created_by_member_id","workspace_id") REFERENCES "public"."workspace_members"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_login_windows_workspace_expiry_index" ON "admin_login_windows" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_workspace_member_expiry_index" ON "admin_sessions" USING btree ("workspace_id","member_id","expires_at");--> statement-breakpoint
CREATE INDEX "article_heads_workspace_state_index" ON "article_heads" USING btree ("workspace_id","review_state","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "article_preview_grants_active_revision_unique" ON "article_preview_grants" USING btree ("workspace_id","revision_id") WHERE "article_preview_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "article_preview_grants_workspace_expiry_index" ON "article_preview_grants" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "article_review_events_history_index" ON "article_review_events" USING btree ("workspace_id","article_id","created_at");--> statement-breakpoint
CREATE INDEX "article_revision_assets_asset_index" ON "article_revision_assets" USING btree ("workspace_id","asset_id");--> statement-breakpoint
CREATE INDEX "article_revisions_history_index" ON "article_revisions" USING btree ("workspace_id","article_id","revision_number");--> statement-breakpoint
CREATE INDEX "article_slug_claims_article_index" ON "article_slug_claims" USING btree ("workspace_id","article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_token_digest_unique" ON "member_invitations" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_active_invite_unique" ON "member_invitations" USING btree ("workspace_id","normalized_email") WHERE "member_invitations"."kind" = 'invite' and "member_invitations"."accepted_at" is null and "member_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_active_reset_unique" ON "member_invitations" USING btree ("workspace_id","member_id") WHERE "member_invitations"."kind" = 'credential_reset' and "member_invitations"."accepted_at" is null and "member_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "member_invitations_workspace_expiry_index" ON "member_invitations" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_email_unique" ON "workspace_members" USING btree ("workspace_id","normalized_email");--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_status_role_index" ON "workspace_members" USING btree ("workspace_id","status","role");
--> statement-breakpoint
CREATE FUNCTION "opas_require_member_insert_safe"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM 1 FROM "workspaces" WHERE "id" = NEW."workspace_id" FOR UPDATE;
	IF NEW."created_by_member_id" IS NULL AND (
		NEW."role" <> 'administrator' OR NEW."status" <> 'active' OR EXISTS (
			SELECT 1 FROM "workspace_members" WHERE "workspace_id" = NEW."workspace_id"
		)
	) THEN
		RAISE EXCEPTION USING MESSAGE = 'MEMBER_BOOTSTRAP_INVALID', ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_members_insert_guard_trigger"
BEFORE INSERT ON "workspace_members"
FOR EACH ROW EXECUTE FUNCTION "opas_require_member_insert_safe"();
--> statement-breakpoint
CREATE FUNCTION "opas_require_operator_invitation_safe"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."created_by_member_id" IS NULL THEN
		PERFORM 1 FROM "workspaces" WHERE "id" = NEW."workspace_id" FOR UPDATE;
		IF NEW."kind" = 'invite' THEN
			IF NEW."target_role" IS DISTINCT FROM 'administrator' OR NEW."member_id" IS NOT NULL OR EXISTS (
				SELECT 1 FROM "workspace_members" WHERE "workspace_id" = NEW."workspace_id"
			) THEN
				RAISE EXCEPTION USING MESSAGE = 'OPERATOR_INVITATION_INVALID', ERRCODE = 'P0001';
			END IF;
		ELSIF NEW."kind" = 'credential_reset' THEN
			IF NOT EXISTS (
				SELECT 1
				FROM "workspace_members"
				WHERE "workspace_id" = NEW."workspace_id"
					AND "id" = NEW."member_id"
					AND "role" = 'administrator'
					AND "status" = 'active'
			) THEN
				RAISE EXCEPTION USING MESSAGE = 'OPERATOR_INVITATION_INVALID', ERRCODE = 'P0001';
			END IF;
		ELSE
			RAISE EXCEPTION USING MESSAGE = 'OPERATOR_INVITATION_INVALID', ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "member_invitations_operator_guard_trigger"
BEFORE INSERT ON "member_invitations"
FOR EACH ROW EXECUTE FUNCTION "opas_require_operator_invitation_safe"();
--> statement-breakpoint
CREATE FUNCTION "opas_require_member_update_safe"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."id" <> OLD."id" OR NEW."workspace_id" <> OLD."workspace_id" THEN
		RAISE EXCEPTION USING MESSAGE = 'MEMBER_IDENTITY_IMMUTABLE', ERRCODE = 'P0001';
	END IF;

	IF OLD."role" = 'administrator'
		AND OLD."status" = 'active'
		AND (NEW."role" <> 'administrator' OR NEW."status" <> 'active') THEN
		PERFORM 1 FROM "workspaces" WHERE "id" = OLD."workspace_id" FOR UPDATE;
		IF NOT EXISTS (
			SELECT 1
			FROM "workspace_members"
			WHERE "workspace_id" = OLD."workspace_id"
				AND "id" <> OLD."id"
				AND "role" = 'administrator'
				AND "status" = 'active'
		) THEN
			RAISE EXCEPTION USING MESSAGE = 'LAST_ACTIVE_ADMIN', ERRCODE = 'P0001';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_members_update_guard_trigger"
BEFORE UPDATE ON "workspace_members"
FOR EACH ROW EXECUTE FUNCTION "opas_require_member_update_safe"();
--> statement-breakpoint
CREATE FUNCTION "opas_reject_direct_member_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id") THEN
		RAISE EXCEPTION USING MESSAGE = 'MEMBER_DELETE_FORBIDDEN', ERRCODE = 'P0001';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_members_delete_guard_trigger"
BEFORE DELETE ON "workspace_members"
FOR EACH ROW EXECUTE FUNCTION "opas_reject_direct_member_delete"();
--> statement-breakpoint
CREATE FUNCTION "opas_validate_authoring_control_actor"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."changed_by_member_id" IS NOT NULL AND NOT EXISTS (
		SELECT 1
		FROM "workspace_members"
		WHERE "id" = NEW."changed_by_member_id"
			AND "workspace_id" = NEW."workspace_id"
	) THEN
		RAISE EXCEPTION USING MESSAGE = 'AUTHORING_CONTROL_MEMBER_INVALID', ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_authoring_controls_actor_trigger"
BEFORE INSERT OR UPDATE ON "workspace_authoring_controls"
FOR EACH ROW EXECUTE FUNCTION "opas_validate_authoring_control_actor"();
--> statement-breakpoint
CREATE FUNCTION "opas_assert_team_authoring_baseline"(
	"requested_workspace_id" text,
	"requested_article_id" text,
	"requested_revision_id" text,
	"requested_revision_hash" text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "articles" AS "article"
		INNER JOIN "categories" AS "category"
			ON "category"."id" = "article"."category_id"
			AND "category"."workspace_id" = "article"."workspace_id"
		INNER JOIN "article_revisions" AS "revision"
			ON "revision"."workspace_id" = "article"."workspace_id"
			AND "revision"."article_id" = "article"."id"
			AND "revision"."id" = "requested_revision_id"
			AND "revision"."revision_number" = 1
		INNER JOIN "article_slug_claims" AS "claim"
			ON "claim"."workspace_id" = "article"."workspace_id"
			AND "claim"."normalized_slug" = "article"."slug"
			AND "claim"."article_id" = "article"."id"
			AND "claim"."working_claim"
			AND "claim"."article_row_claim"
		INNER JOIN "article_heads" AS "head"
			ON "head"."workspace_id" = "article"."workspace_id"
			AND "head"."article_id" = "article"."id"
		WHERE "article"."workspace_id" = "requested_workspace_id"
			AND "article"."id" = "requested_article_id"
			AND "revision"."category_id" = "article"."category_id"
			AND "revision"."category_slug" = "category"."slug"
			AND "revision"."category_name" = "category"."name"
			AND "revision"."slug" = "article"."slug"
			AND "revision"."title" = "article"."title"
			AND "revision"."mdx" = "article"."mdx"
			AND "revision"."is_faq" = "article"."is_faq"
			AND "revision"."author_name" = "article"."author_name"
			AND "revision"."position" = "article"."position"
			AND "revision"."revision_hash" = "requested_revision_hash"
			AND "revision"."change_kind" = 'migration'
			AND "revision"."created_by_member_id" IS NULL
			AND "revision"."created_by_system_label" = 'OPAS migration'
			AND "revision"."change_summary" IS NULL
			AND "revision"."restored_from_revision_id" IS NULL
			AND "revision"."created_at" = "article"."updated_at"
			AND "head"."working_revision_id" = "requested_revision_id"
			AND "head"."working_revision_number" = 1
			AND "head"."working_slug" = "article"."slug"
			AND "head"."archived_at" IS NULL
			AND "head"."archived_by_member_id" IS NULL
			AND (
				("article"."status" = 'published'
					AND "head"."published_revision_id" = "requested_revision_id"
					AND "head"."published_revision_number" = 1
					AND "head"."review_state" = 'published')
				OR
				("article"."status" = 'draft'
					AND "head"."published_revision_id" IS NULL
					AND "head"."published_revision_number" IS NULL
					AND "head"."review_state" = 'editing')
			)
	) THEN
		RAISE EXCEPTION USING MESSAGE = 'AUTHORING_BACKFILL_MISMATCH', ERRCODE = 'P0001';
	END IF;

	IF EXISTS (
		SELECT "asset_id"
		FROM "article_revision_assets"
		WHERE "workspace_id" = "requested_workspace_id"
			AND "article_id" = "requested_article_id"
			AND "revision_id" = "requested_revision_id"
			AND "revision_number" = 1
		EXCEPT
		SELECT "asset_id"
		FROM "article_assets"
		WHERE "workspace_id" = "requested_workspace_id"
			AND "article_id" = "requested_article_id"
	) OR EXISTS (
		SELECT "asset_id"
		FROM "article_assets"
		WHERE "workspace_id" = "requested_workspace_id"
			AND "article_id" = "requested_article_id"
		EXCEPT
		SELECT "asset_id"
		FROM "article_revision_assets"
		WHERE "workspace_id" = "requested_workspace_id"
			AND "article_id" = "requested_article_id"
			AND "revision_id" = "requested_revision_id"
			AND "revision_number" = 1
	) THEN
		RAISE EXCEPTION USING MESSAGE = 'AUTHORING_BACKFILL_MISMATCH', ERRCODE = 'P0001';
	END IF;
END;
$$;
