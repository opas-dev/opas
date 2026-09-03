// ABOUTME: Probes a committed authoring fence from an isolated Postgres process.
// ABOUTME: Reports guarded rejection and permitted read and telemetry writes as bounded JSON.
import { Pool } from "pg";

const [connectionString, workspaceId, articleId, memberId] = process.argv.slice(2);
if (!connectionString || !workspaceId || !articleId || !memberId) {
  throw new Error("Usage: authoring-fence-process-probe.ts <url> <workspace> <article> <member>");
}
const target = new URL(connectionString);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
  throw new Error("The fence process probe accepts only a loopback Postgres target.");
}

async function main() {
  const pool = new Pool({ connectionString });
  const id = "P".repeat(43);
  const now = new Date("2026-09-03T12:00:00.000Z");
  const result: Record<string, unknown> = {};
  try {
    const publicRead = await pool.query(
      "select count(*) as count from articles where id = $1",
      [articleId],
    );
    result.publicRead = Number(publicRead.rows[0]?.count) === 1;
    await pool.query(
      "insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at) values ($1, $2, $3, $4, $5)",
      [id, workspaceId, memberId, now, new Date(now.getTime() + 3_600_000)],
    );
    await pool.query(
      "insert into article_feedback (id, article_id, helpful, comment, created_at) values ($1, $2, true, 'paused', $3)",
      ["feedback_process", articleId, now],
    );
    await pool.query(
      "insert into article_views (id, article_id, viewed_at) values ($1, $2, $3)",
      ["view_process", articleId, now],
    );
    await pool.query(
      "insert into search_misses (id, workspace_id, query, created_at) values ($1, $2, 'paused query', $3)",
      ["search_process", workspaceId, now],
    );
    await pool.query(
      `insert into conversation_analytics (id, workspace_id, outcome, reason, conversation, retrieval_trace, provider, model, duration_milliseconds, bucket_day, bucket_slot, started_at, updated_at, expires_at)
       values ($1, $2, 'answered', null, '[]', '[]', 'fixture', 'fixture', 1, '20260903', 17, $3, $3, $4)`,
      [
        "00000000-0000-4000-8000-000000000016",
        workspaceId,
        now,
        new Date(now.getTime() + 86_400_000),
      ],
    );
    await pool.query(
      "insert into public_outcome_write_windows (workspace_id, window_started_at, write_count) values ($1, $2, 1)",
      [workspaceId, now],
    );
    result.permittedWrites = true;
    try {
      await pool.query(
        "insert into categories (id, workspace_id, slug, name, position, version) values ('category_process_blocked', $1, 'blocked', 'Blocked', 1, 1)",
        [workspaceId],
      );
      result.guardedCode = null;
    } catch (error) {
      result.guardedCode =
        error instanceof Error && error.message.includes("AUTHORING_PAUSED")
          ? "AUTHORING_PAUSED"
          : String(error);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

void main();
