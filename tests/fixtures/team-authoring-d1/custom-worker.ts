// ABOUTME: Runs the application team-authoring backfill inside native workerd with a D1 binding.
// ABOUTME: Exposes deterministic interruption and completion results to the Wrangler integration test.

import type { AnyD1Database } from "drizzle-orm/d1";

import { createD1TeamAuthoringBackfillStore } from "../../../src/db/sqlite/d1-team-authoring-backfill";
import { runTeamAuthoringBackfill } from "../../../src/db/team-authoring-backfill";

type Environment = Readonly<{ DB: D1Database }>;

export default {
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    if (url.pathname === "/bootstrap") {
      const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
      await environment.DB.batch([
        environment.DB
          .prepare(
            `insert into workspaces (id, slug, name, created_at, updated_at)
             values ('workspace_d1', 'd1', 'D1', ?, ?)`,
          )
          .bind(timestamp, timestamp),
        environment.DB
          .prepare(
            `update workspace_authoring_controls
             set writes_paused = 1, generation = generation + 1, changed_at = ?
             where workspace_id = 'workspace_d1'`,
          )
          .bind(timestamp),
        environment.DB
          .prepare(
            `insert into workspace_members (
               id, workspace_id, normalized_email, display_name, role, status,
               password_salt, password_digest, password_iterations,
               created_by_member_id, created_at, updated_at
             ) values (
               'member_d1', 'workspace_d1', 'admin@d1.test', 'Admin',
               'administrator', 'active', ?, ?, 600000, null, ?, ?
             )`,
          )
          .bind("A".repeat(43), "a".repeat(43), timestamp, timestamp),
      ]);
      return Response.json({ bootstrapped: true });
    }
    const interruptAfterChunks = url.searchParams.get("interrupt") === "true" ? 1 : undefined;
    try {
      const result = await runTeamAuthoringBackfill(
        createD1TeamAuthoringBackfillStore(
          environment.DB as unknown as AnyD1Database,
        ),
        {
          clock: () => new Date("2026-09-03T12:00:00.000Z"),
          interruptAfterChunks,
        },
      );
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 409 },
      );
    }
  },
} satisfies ExportedHandler<Environment>;
