-- ABOUTME: Adds ordered articles and portable content-addressed assets to Postgres and Neon.
-- ABOUTME: Preserves v0.1 records while enforcing workspace-scoped staging and references.
CREATE TABLE "asset_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"hash" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_hash_length_check" CHECK (length("assets"."hash") = 64),
	CONSTRAINT "assets_media_type_check" CHECK ("assets"."media_type" in ('image/gif', 'image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "assets_byte_size_check" CHECK ("assets"."byte_size" between 1 and 1048576),
	CONSTRAINT "assets_content_size_check" CHECK (octet_length("assets"."content") = "assets"."byte_size")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_manifests_id_workspace_unique" ON "asset_manifests" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "asset_manifests_workspace_expires_index" ON "asset_manifests" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_workspace_hash_unique" ON "assets" USING btree ("workspace_id","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_id_workspace_unique" ON "assets" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_id_workspace_unique" ON "articles" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "asset_manifests" ADD CONSTRAINT "asset_manifests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "article_assets" (
	"article_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_assets_article_id_asset_id_pk" PRIMARY KEY("article_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "asset_manifest_items" (
	"manifest_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_manifest_items_manifest_id_asset_id_pk" PRIMARY KEY("manifest_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "article_assets" ADD CONSTRAINT "article_assets_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_assets" ADD CONSTRAINT "article_assets_asset_id_workspace_id_assets_id_workspace_id_fk" FOREIGN KEY ("asset_id","workspace_id") REFERENCES "public"."assets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_manifest_items" ADD CONSTRAINT "asset_manifest_items_manifest_id_workspace_id_asset_manifests_id_workspace_id_fk" FOREIGN KEY ("manifest_id","workspace_id") REFERENCES "public"."asset_manifests"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_manifest_items" ADD CONSTRAINT "asset_manifest_items_asset_id_workspace_id_assets_id_workspace_id_fk" FOREIGN KEY ("asset_id","workspace_id") REFERENCES "public"."assets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_assets_asset_index" ON "article_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_manifest_items_asset_index" ON "asset_manifest_items" USING btree ("asset_id");
