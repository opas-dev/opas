// ABOUTME: Verifies a committed Postgres pause survives application process boundaries.
// ABOUTME: Confirms public reads and non-content writes remain available after reconnect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "@/db/schema/postgres";

test("committed Postgres pause is enforced in a fresh process", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString });
  const workspaceId = "workspace_process_fence";
  const memberId = "member_process_fence";
  const articleId = "article_process_fence";
  try {
    await migrate(drizzle(pool, { schema }), {
      migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
    });
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, 'process-fence', 'Process fence')",
      [workspaceId],
    );
    await pool.query(
      `insert into workspace_members (id, workspace_id, normalized_email, display_name, role, status, password_salt, password_digest, password_iterations)
       values ($1, $2, 'process@example.test', 'Process', 'administrator', 'active', $3, $4, 600000)`,
      [memberId, workspaceId, "A".repeat(43), "B".repeat(43)],
    );
    await pool.query(
      "insert into categories (id, workspace_id, slug, name, position, version) values ('category_process', $1, 'process', 'Process', 0, 1)",
      [workspaceId],
    );
    await pool.query(
      "insert into articles (id, workspace_id, category_id, slug, title, mdx, status, is_faq, author_name, position) values ($1, $2, 'category_process', 'process', 'Process', '# Process', 'draft', false, 'OPAS', 0)",
      [articleId, workspaceId],
    );
    await pool.query(
      "update workspace_authoring_controls set writes_paused = true, generation = generation + 1 where workspace_id = $1",
      [workspaceId],
    );
    const before = Number(
      (
        await pool.query(
          "select count(*) as count from categories where workspace_id = $1",
          [workspaceId],
        )
      ).rows[0]?.count,
    );

    const probe = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        path.join(process.cwd(), "scripts/authoring-fence-process-probe.ts"),
        connectionString,
        workspaceId,
        articleId,
        memberId,
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      guardedCode: "AUTHORING_PAUSED",
      permittedWrites: true,
      publicRead: true,
    });
    assert.equal(
      Number(
        (
          await pool.query(
            "select count(*) as count from categories where workspace_id = $1",
            [workspaceId],
          )
        ).rows[0]?.count,
      ),
      before,
    );
  } finally {
    await pool.end();
    await container.stop();
  }
});
