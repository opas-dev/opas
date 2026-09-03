// ABOUTME: Verifies a committed D1 pause across independent Wrangler processes.
// ABOUTME: Confirms public reads and telemetry writes remain permitted after reconnect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const config = path.join(root, "tests/fixtures/demo-seed-d1/wrangler.jsonc");
const database = "opas-demo-seed-test";

function execute(persistTo: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      wrangler,
      "d1",
      ...args,
      "--local",
      "--config",
      config,
      "--persist-to",
      persistTo,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
}

test("committed D1 pause is enforced in a fresh process", { timeout: 180_000 }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opas-d1-process-fence-"));
  const state = path.join(directory, "state");
  try {
    const migrated = execute(state, ["migrations", "apply", database]);
    assert.equal(migrated.status, 0, `${migrated.stdout}${migrated.stderr}`);
    const setup = execute(state, [
      "execute",
      database,
      "--command",
      `insert into workspaces (id, slug, name) values ('workspace_process_fence', 'process-fence', 'Process fence');
       insert into workspace_members (id, workspace_id, normalized_email, display_name, role, status, password_salt, password_digest, password_iterations) values ('member_process_fence', 'workspace_process_fence', 'process@example.test', 'Process', 'administrator', 'active', '${"A".repeat(43)}', '${"B".repeat(43)}', 600000);
       insert into categories (id, workspace_id, slug, name, position, version) values ('category_process', 'workspace_process_fence', 'process', 'Process', 0, 1);
       insert into articles (id, workspace_id, category_id, slug, title, mdx, status, is_faq, author_name, position) values ('article_process_fence', 'workspace_process_fence', 'category_process', 'process', 'Process', '# Process', 'draft', 0, 'OPAS', 0);
       update workspace_authoring_controls set writes_paused = 1, generation = generation + 1 where workspace_id = 'workspace_process_fence';`,
    ]);
    assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);

    const allowed = execute(state, [
      "execute",
      database,
      "--command",
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at) values ('${"P".repeat(43)}', 'workspace_process_fence', 'member_process_fence', 1788436800000, 1788440400000);
       insert into article_feedback (id, article_id, helpful, comment, created_at) values ('feedback_process', 'article_process_fence', 1, 'paused', 1788436800000);
       insert into article_views (id, article_id, viewed_at) values ('view_process', 'article_process_fence', 1788436800000);
       insert into search_misses (id, workspace_id, query, created_at) values ('search_process', 'workspace_process_fence', 'paused query', 1788436800000);
       insert into conversation_analytics (id, workspace_id, outcome, reason, conversation, retrieval_trace, provider, model, duration_milliseconds, bucket_day, bucket_slot, started_at, updated_at, expires_at) values ('00000000-0000-4000-8000-000000000016', 'workspace_process_fence', 'answered', null, '[]', '[]', 'fixture', 'fixture', 1, '20260903', 17, 1788436800000, 1788436800000, 1788523200000);
       insert into public_outcome_write_windows (workspace_id, window_started_at, write_count) values ('workspace_process_fence', 1788436800000, 1);`,
    ]);
    assert.equal(allowed.status, 0, `${allowed.stdout}${allowed.stderr}`);

    const blocked = execute(state, [
      "execute",
      database,
      "--command",
      "insert into categories (id, workspace_id, slug, name, position, version) values ('category_process_blocked', 'workspace_process_fence', 'blocked', 'Blocked', 1, 1);",
    ]);
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /AUTHORING_PAUSED/u);

    const inspected = execute(state, [
      "execute",
      database,
      "--json",
      "--command",
      "select (select count(*) from articles where id = 'article_process_fence') as public_read, (select count(*) from categories where workspace_id = 'workspace_process_fence') as categories, (select count(*) from admin_sessions) as sessions, (select count(*) from article_feedback) as feedback, (select count(*) from article_views) as views, (select count(*) from search_misses) as searches, (select count(*) from conversation_analytics) as answers, (select count(*) from public_outcome_write_windows) as outcomes;",
    ]);
    assert.equal(inspected.status, 0, `${inspected.stdout}${inspected.stderr}`);
    const rows = JSON.parse(inspected.stdout) as Array<{ results: Array<Record<string, number>> }>;
    assert.deepEqual(rows[0]?.results[0], {
      answers: 1,
      categories: 1,
      feedback: 1,
      outcomes: 1,
      public_read: 1,
      searches: 1,
      sessions: 1,
      views: 1,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
