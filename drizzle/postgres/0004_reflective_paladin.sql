ALTER TABLE "articles" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "articles_workspace_status_content_hash_index" ON "articles" USING btree ("workspace_id","status","content_hash");--> statement-breakpoint
CREATE INDEX "embedding_generations_reconciliation_index" ON "embedding_generations" USING btree ("workspace_id","status","provider","model","dimension","configuration_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_jobs_generation_article_hash_unique" ON "embedding_jobs" USING btree ("workspace_id","article_id","article_content_hash","embedding_generation_id");--> statement-breakpoint
CREATE INDEX "embedding_jobs_generation_claim_index" ON "embedding_jobs" USING btree ("workspace_id","embedding_generation_id","status","available_at","lease_expires_at");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_content_hash_check" CHECK ("articles"."content_hash" is null or length("articles"."content_hash") = 64);