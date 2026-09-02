CREATE TABLE "workspace_authoring_controls" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"writes_paused" boolean DEFAULT false NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"changed_by_member_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_authoring_controls_generation_check" CHECK ("workspace_authoring_controls"."generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_authoring_controls" ADD CONSTRAINT "workspace_authoring_controls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "opas_create_authoring_control"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO "workspace_authoring_controls" (
		"workspace_id",
		"writes_paused",
		"generation",
		"changed_by_member_id",
		"changed_at"
	)
	VALUES (NEW."id", false, 0, NULL, NEW."created_at");
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspaces_authoring_control_insert_trigger"
AFTER INSERT ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "opas_create_authoring_control"();
--> statement-breakpoint
INSERT INTO "workspace_authoring_controls" (
	"workspace_id",
	"writes_paused",
	"generation",
	"changed_by_member_id",
	"changed_at"
)
SELECT "id", false, 0, NULL, now()
FROM "workspaces"
ON CONFLICT ("workspace_id") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "opas_assert_authoring_open"("requested_workspace_id" text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	"control_paused" boolean;
BEGIN
	SELECT "writes_paused"
	INTO "control_paused"
	FROM "workspace_authoring_controls"
	WHERE "workspace_id" = "requested_workspace_id"
	FOR SHARE;

	IF NOT FOUND OR "control_paused" THEN
		RAISE EXCEPTION USING MESSAGE = 'AUTHORING_PAUSED', ERRCODE = 'P0001';
	END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "opas_require_workspace_delete_open"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM "opas_assert_authoring_open"(OLD."id");
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspaces_authoring_control_delete_trigger"
BEFORE DELETE ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "opas_require_workspace_delete_open"();
--> statement-breakpoint
CREATE FUNCTION "opas_require_authoring_open"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	"source_workspace_id" text;
	"target_workspace_id" text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		"source_workspace_id" := NEW."workspace_id";
		"target_workspace_id" := NEW."workspace_id";
	ELSIF TG_OP = 'DELETE' THEN
		"source_workspace_id" := OLD."workspace_id";
		"target_workspace_id" := OLD."workspace_id";
	ELSE
		"source_workspace_id" := OLD."workspace_id";
		"target_workspace_id" := NEW."workspace_id";
	END IF;

	IF TG_OP = 'DELETE' AND NOT EXISTS (
		SELECT 1 FROM "workspaces" WHERE "id" = "source_workspace_id"
	) THEN
		RETURN OLD;
	END IF;

	IF "source_workspace_id" <= "target_workspace_id" THEN
		PERFORM "opas_assert_authoring_open"("source_workspace_id");
		IF "source_workspace_id" <> "target_workspace_id" THEN
			PERFORM "opas_assert_authoring_open"("target_workspace_id");
		END IF;
	ELSE
		PERFORM "opas_assert_authoring_open"("target_workspace_id");
		PERFORM "opas_assert_authoring_open"("source_workspace_id");
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "categories_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "articles_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "articles"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "themes_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "themes"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "asset_manifests_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "asset_manifests"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "asset_manifest_items_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "asset_manifest_items"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "assets_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "assets"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "article_assets_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "article_assets"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "workspace_index_states_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "workspace_index_states"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "evidence_chunks_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "evidence_chunks"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "embedding_generations_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "embedding_generations"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "chunk_embeddings_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "chunk_embeddings"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "embedding_jobs_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "embedding_jobs"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "saved_question_sets_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "saved_question_sets"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
--> statement-breakpoint
CREATE TRIGGER "evaluation_runs_authoring_control_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "evaluation_runs"
FOR EACH ROW EXECUTE FUNCTION "opas_require_authoring_open"();
