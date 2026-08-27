-- ABOUTME: Enforces the supported OPAS article publication states in Postgres and Neon.
-- ABOUTME: Prevents raw database writes from bypassing the draft-or-published contract.
ALTER TABLE "articles" ADD CONSTRAINT "articles_status_check" CHECK ("articles"."status" in ('draft', 'published'));
