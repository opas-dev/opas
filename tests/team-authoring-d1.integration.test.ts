// ABOUTME: Verifies the application team-authoring backfill against native Wrangler-local D1.
// ABOUTME: Covers interruption, operator resume fencing, deterministic replay, guards, and teardown.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTeamAuthoringBaseline } from "@/db/team-authoring-backfill";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(
  repositoryRoot,
  "node_modules/wrangler/bin/wrangler.js",
);
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/team-authoring-d1/wrangler.jsonc",
);
const fixtureConfigRelative = path.relative(repositoryRoot, fixtureConfig);
const sqliteMigrationDirectory = path.join(repositoryRoot, "drizzle/sqlite");
const databaseName = "opas-mvp";
const fixedTime = 1_788_430_123_456;

type D1Execution = Readonly<{ results?: readonly Record<string, unknown>[] }>;

function run(
  executable: string,
  args: readonly string[],
  options: Readonly<{ allowFailure?: boolean }> = {},
) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!options.allowFailure && result.status !== 0) {
    assert.fail(
      `Command failed (${String(result.status)}): ${executable} ${args.join(" ")}\n${output}`,
    );
  }
  return { output, status: result.status };
}

function wrangler(
  persistDirectory: string,
  args: readonly string[],
  options: Readonly<{ allowFailure?: boolean }> = {},
) {
  return run(
    process.execPath,
    [
      wranglerEntry,
      ...args,
      "--config",
      fixtureConfig,
      "--persist-to",
      persistDirectory,
    ],
    options,
  );
}

function executeFile(
  persistDirectory: string,
  filename: string,
  options: Readonly<{ allowFailure?: boolean }> = {},
) {
  return wrangler(
    persistDirectory,
    [
      "d1",
      "execute",
      databaseName,
      "--local",
      "--yes",
      "--file",
      filename,
    ],
    options,
  );
}

function executeSql(
  persistDirectory: string,
  source: string,
  options: Readonly<{ allowFailure?: boolean }> = {},
) {
  return wrangler(
    persistDirectory,
    [
      "d1",
      "execute",
      databaseName,
      "--local",
      "--yes",
      "--command",
      source,
    ],
    options,
  );
}

function query(persistDirectory: string, source: string) {
  const result = wrangler(persistDirectory, [
    "d1",
    "execute",
    databaseName,
    "--local",
    "--yes",
    "--json",
    "--command",
    source,
  ]);
  const parsed = JSON.parse(result.output) as readonly D1Execution[];
  return parsed.flatMap((entry) => entry.results ?? []);
}

function resumeAuthoring(
  persistDirectory: string,
  expectedGeneration: number,
  options: Readonly<{ allowFailure?: boolean }> = {},
) {
  return run(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/authoring-control.ts",
      "resume",
      "--target",
      "cloudflare",
      "--workspace",
      "workspace_d1",
      "--expected-generation",
      String(expectedGeneration),
      "--config",
      fixtureConfigRelative,
      "--local",
      "--persist-to",
      persistDirectory,
    ],
    options,
  );
}

function migrationFiles() {
  return readdirSync(sqliteMigrationDirectory)
    .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
    .sort();
}

function writeMigrationBundle(
  directory: string,
  filename: string,
  predicate: (candidate: string) => boolean,
) {
  const source = migrationFiles()
    .filter(predicate)
    .map((candidate) =>
      readFileSync(path.join(sqliteMigrationDirectory, candidate), "utf8"),
    )
    .join("\n");
  const target = path.join(directory, filename);
  writeFileSync(target, source);
  return target;
}

function beforeTeamAuthoringMigration(filename: string) {
  return !filename.startsWith("0011_") && !filename.startsWith("0012_");
}

function teamAuthoringMigration(filename: string) {
  return filename.startsWith("0011_") || filename.startsWith("0012_");
}

function teamAuthoringSchemaMigration(filename: string) {
  return filename.startsWith("0011_");
}

function categoryThemeVersionMigration(filename: string) {
  return filename.startsWith("0012_");
}

function seedSource(articleCount: number) {
  const articles = Array.from({ length: articleCount }, (_, index) => {
    const published = index % 2 === 0;
    return `insert into articles (
      id, workspace_id, category_id, slug, title, mdx, content_hash, status,
      is_faq, author_name, position, published_at, created_at, updated_at
    ) values (
      'article_${String(index).padStart(3, "0")}', 'workspace_d1', 'category_d1',
      'article-${index}', 'Article ${index}', '# Article ${index}\n\nBody ${index}.',
      '${String(index).padStart(64, "0")}', '${published ? "published" : "draft"}',
      ${index % 3 === 0 ? 1 : 0}, 'OPAS', ${index},
      ${published ? fixedTime : "null"}, ${fixedTime}, ${fixedTime + index}
    );`;
  });
  const articleAssets = Array.from(
    { length: Math.min(articleCount, 3) },
    (_, index) =>
      `insert into article_assets (article_id, asset_id, workspace_id, created_at)
       values ('article_${String(index).padStart(3, "0")}', 'asset_d1', 'workspace_d1', ${fixedTime});`,
  );
  return [
    `insert into workspaces (id, slug, name, created_at, updated_at)
     values ('workspace_d1', 'd1', 'D1', ${fixedTime}, ${fixedTime});`,
    `insert into categories (
       id, workspace_id, slug, name, description, position, created_at, updated_at
     ) values (
       'category_d1', 'workspace_d1', 'guides', 'Guides', null, 0,
       ${fixedTime}, ${fixedTime}
     );`,
    `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
     values ('asset_d1', 'workspace_d1', '${"a".repeat(64)}', 'image/png', 1, x'01', ${fixedTime});`,
    ...articles,
    ...articleAssets,
    `update workspace_authoring_controls
     set writes_paused = 1, generation = generation + 1, changed_at = ${fixedTime + 10_000}
     where workspace_id = 'workspace_d1';`,
  ].join("\n");
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startWorker(persistDirectory: string) {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      wranglerEntry,
      "dev",
      "--local",
      "--port",
      String(port),
      "--config",
      fixtureConfig,
      "--persist-to",
      persistDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      assert.fail(`Wrangler exited before readiness.\n${output}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return { child, origin, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  assert.fail(`Wrangler did not become ready.\n${output}`);
}

async function stopWorker(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function publicProjection(persistDirectory: string) {
  return {
    articleAssets: query(
      persistDirectory,
      "select * from article_assets order by article_id, asset_id",
    ),
    articles: query(persistDirectory, "select * from articles order by id"),
    categories: query(
      persistDirectory,
      `select id, workspace_id, slug, name, description, position, created_at, updated_at
       from categories order by id`,
    ),
  };
}

test(
  "native D1 clean install backfills a zero-article bootstrap before resume",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opas-team-authoring-d1-clean-"));
    const persistDirectory = path.join(directory, "state");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let succeeded = false;
    try {
      const beforeMigration = writeMigrationBundle(
        directory,
        "before-team-authoring.sql",
        beforeTeamAuthoringMigration,
      );
      const teamMigration = writeMigrationBundle(
        directory,
        "team-authoring.sql",
        teamAuthoringMigration,
      );
      executeFile(persistDirectory, beforeMigration);
      executeFile(persistDirectory, teamMigration);
      worker = await startWorker(persistDirectory);

      const empty = await fetch(worker.origin);
      assert.equal(empty.status, 200, worker.output());
      assert.equal(((await empty.json()) as { articleCount: number }).articleCount, 0);
      const bootstrap = await fetch(`${worker.origin}/bootstrap`);
      assert.equal(bootstrap.status, 200, worker.output());
      assert.deepEqual(await bootstrap.json(), { bootstrapped: true });
      assert.deepEqual(
        query(
          persistDirectory,
          `select writes_paused, generation
           from workspace_authoring_controls where workspace_id = 'workspace_d1'`,
        ),
        [{ generation: 1, writes_paused: 1 }],
      );

      const blocked = resumeAuthoring(persistDirectory, 1, { allowFailure: true });
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.output, /AUTHORING_BACKFILL_INCOMPLETE/u);
      assert.deepEqual(
        query(
          persistDirectory,
          "select count(*) as count from workspace_authoring_migrations",
        ),
        [{ count: 0 }],
      );

      const completed = await fetch(worker.origin);
      assert.equal(completed.status, 200, worker.output());
      const result = (await completed.json()) as {
        alreadyCompleted: boolean;
        articleCount: number;
      };
      assert.equal(result.alreadyCompleted, false);
      assert.equal(result.articleCount, 0);
      assert.deepEqual(
        query(
          persistDirectory,
          `select article_count, version
           from workspace_authoring_migrations where workspace_id = 'workspace_d1'`,
        ),
        [{ article_count: 0, version: 1 }],
      );
      const repeated = await fetch(worker.origin);
      assert.equal(repeated.status, 200, worker.output());
      assert.equal(
        ((await repeated.json()) as { alreadyCompleted: boolean }).alreadyCompleted,
        true,
      );

      await stopWorker(worker.child);
      worker = undefined;
      executeSql(
        persistDirectory,
        "drop trigger assets_revision_history_delete_trigger",
      );
      const missingGuardResume = resumeAuthoring(persistDirectory, 1, {
        allowFailure: true,
      });
      assert.notEqual(missingGuardResume.status, 0);
      assert.match(missingGuardResume.output, /AUTHORING_BACKFILL_INCOMPLETE/u);
      const assetGuard = sqliteTeamAuthoringGuardStatements.find((statement) =>
        statement.includes("assets_revision_history_delete_trigger"),
      );
      assert.ok(assetGuard);
      const restoreGuard = path.join(directory, "restore-asset-guard.sql");
      writeFileSync(restoreGuard, assetGuard);
      executeFile(persistDirectory, restoreGuard);
      const resumed = resumeAuthoring(persistDirectory, 1);
      assert.match(resumed.output, /"writesPaused": false/u);
      assert.deepEqual(
        query(
          persistDirectory,
          `select writes_paused, generation
           from workspace_authoring_controls where workspace_id = 'workspace_d1'`,
        ),
        [{ generation: 2, writes_paused: 0 }],
      );
      executeSql(
        persistDirectory,
        `insert into categories (id, workspace_id, slug, name)
         values ('category_seed_ready', 'workspace_d1', 'ready', 'Ready')`,
      );
      succeeded = true;
    } finally {
      if (worker) await stopWorker(worker.child);
      if (succeeded) rmSync(directory, { force: true, recursive: true });
      else console.error(`Native D1 clean fixture retained at ${directory}`);
    }
  },
);

test(
  "native D1 Phase 16.3 DDL is atomic for unpaused and missing controls",
  { timeout: 120_000 },
  () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "opas-team-authoring-d1-precondition-"),
    );
    const persistDirectory = path.join(directory, "state");
    let succeeded = false;
    try {
      const beforeMigration = writeMigrationBundle(
        directory,
        "before-team-authoring.sql",
        beforeTeamAuthoringMigration,
      );
      const teamMigration = writeMigrationBundle(
        directory,
        "team-authoring.sql",
        teamAuthoringMigration,
      );
      executeFile(persistDirectory, beforeMigration);
      executeSql(
        persistDirectory,
        "insert into workspaces (id, slug, name) values ('unsafe', 'unsafe', 'Unsafe')",
      );
      const unpaused = executeFile(persistDirectory, teamMigration, {
        allowFailure: true,
      });
      assert.notEqual(unpaused.status, 0);
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from sqlite_master
           where type = 'table' and name = 'workspace_members'`,
        ),
        [{ count: 0 }],
      );

      executeSql(
        persistDirectory,
        "delete from workspace_authoring_controls where workspace_id = 'unsafe'",
      );
      const missing = executeFile(persistDirectory, teamMigration, {
        allowFailure: true,
      });
      assert.notEqual(missing.status, 0);
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from sqlite_master
           where type = 'table' and name = 'workspace_members'`,
        ),
        [{ count: 0 }],
      );
      assert.deepEqual(query(persistDirectory, "pragma foreign_key_check"), []);
      succeeded = true;
    } finally {
      if (succeeded) rmSync(directory, { force: true, recursive: true });
      else console.error(`Native D1 precondition fixture retained at ${directory}`);
    }
  },
);

test(
  "native D1 category and theme DDL is atomic for unpaused and missing controls",
  { timeout: 120_000 },
  () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "opas-category-theme-d1-precondition-"),
    );
    const persistDirectory = path.join(directory, "state");
    let succeeded = false;
    try {
      const beforeMigration = writeMigrationBundle(
        directory,
        "before-team-authoring.sql",
        beforeTeamAuthoringMigration,
      );
      const schemaMigration = writeMigrationBundle(
        directory,
        "team-authoring-schema.sql",
        teamAuthoringSchemaMigration,
      );
      const versionMigration = writeMigrationBundle(
        directory,
        "category-theme-version.sql",
        categoryThemeVersionMigration,
      );
      executeFile(persistDirectory, beforeMigration);
      executeSql(
        persistDirectory,
        "insert into workspaces (id, slug, name) values ('unsafe', 'unsafe', 'Unsafe')",
      );
      executeSql(
        persistDirectory,
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1
         where workspace_id = 'unsafe'`,
      );
      executeFile(persistDirectory, schemaMigration);

      executeSql(
        persistDirectory,
        `update workspace_authoring_controls
         set writes_paused = 0, generation = generation + 1
         where workspace_id = 'unsafe'`,
      );
      const unpaused = executeFile(persistDirectory, versionMigration, {
        allowFailure: true,
      });
      assert.notEqual(unpaused.status, 0);
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('categories')
           where name = 'version'`,
        ),
        [{ count: 0 }],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('article_heads')
           where name = 'submitted_by_member_id'`,
        ),
        [{ count: 0 }],
      );

      executeSql(
        persistDirectory,
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1
         where workspace_id = 'unsafe';
         insert into workspaces (id, slug, name)
         values ('missing', 'missing', 'Missing');
         delete from workspace_authoring_controls where workspace_id = 'missing';`,
      );
      const missing = executeFile(persistDirectory, versionMigration, {
        allowFailure: true,
      });
      assert.notEqual(missing.status, 0);
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('themes')
           where name = 'version'`,
        ),
        [{ count: 0 }],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('article_heads')
           where name = 'submitted_by_member_id'`,
        ),
        [{ count: 0 }],
      );

      executeSql(
        persistDirectory,
        `insert into workspace_authoring_controls (
           workspace_id, writes_paused, generation, changed_at
         ) values ('missing', 1, 0, ${fixedTime})`,
      );
      executeFile(persistDirectory, versionMigration);
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('categories')
           where name = 'version'`,
        ),
        [{ count: 1 }],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('themes')
           where name = 'version'`,
        ),
        [{ count: 1 }],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from pragma_table_info('article_heads')
           where name = 'submitted_by_member_id'`,
        ),
        [{ count: 1 }],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count from sqlite_master
           where type = 'trigger' and name in (
             'article_heads_authoring_control_insert_trigger',
             'article_heads_authoring_control_update_trigger',
             'article_heads_authoring_control_delete_trigger',
             'article_heads_integrity_insert_trigger',
             'article_heads_integrity_update_trigger'
           )`,
        ),
        [{ count: 5 }],
      );
      assert.deepEqual(query(persistDirectory, "pragma foreign_key_check"), []);
      succeeded = true;
    } finally {
      if (succeeded) rmSync(directory, { force: true, recursive: true });
      else console.error(`Native D1 category/theme fixture retained at ${directory}`);
    }
  },
);

test(
  "native Wrangler-local D1 resumes and audits the application backfill",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opas-team-authoring-d1-"));
    const persistDirectory = path.join(directory, "state");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let succeeded = false;
    try {
      const beforeMigration = writeMigrationBundle(
        directory,
        "before-team-authoring.sql",
        beforeTeamAuthoringMigration,
      );
      const teamMigration = writeMigrationBundle(
        directory,
        "team-authoring.sql",
        teamAuthoringMigration,
      );
      const seed = path.join(directory, "seed.sql");
      writeFileSync(seed, seedSource(26));
      executeFile(persistDirectory, beforeMigration);
      executeFile(persistDirectory, seed);
      const before = publicProjection(persistDirectory);
      executeFile(persistDirectory, teamMigration);

      worker = await startWorker(persistDirectory);
      const interrupted = await fetch(`${worker.origin}/?interrupt=true`);
      assert.equal(interrupted.status, 409);
      assert.deepEqual(await interrupted.json(), {
        error: "AUTHORING_BACKFILL_INTERRUPTED",
      });
      assert.deepEqual(query(persistDirectory, "select count(*) as count from article_revisions"), [
        { count: 25 },
      ]);
      assert.deepEqual(
        query(
          persistDirectory,
          "select count(*) as count from workspace_authoring_migrations",
        ),
        [{ count: 0 }],
      );

      const rejectedResume = resumeAuthoring(persistDirectory, 1, {
        allowFailure: true,
      });
      assert.notEqual(rejectedResume.status, 0);
      assert.match(rejectedResume.output, /AUTHORING_BACKFILL_INCOMPLETE/u);

      const completedResponse = await fetch(worker.origin);
      assert.equal(completedResponse.status, 200, worker.output());
      const completed = (await completedResponse.json()) as {
        alreadyCompleted: boolean;
        articleCount: number;
        chunkCount: number;
      };
      assert.equal(completed.alreadyCompleted, false);
      assert.equal(completed.articleCount, 26);
      assert.equal(completed.chunkCount, 2);
      assert.deepEqual(publicProjection(persistDirectory), before);

      const repeatedResponse = await fetch(worker.origin);
      assert.equal(repeatedResponse.status, 200, worker.output());
      const repeated = (await repeatedResponse.json()) as {
        alreadyCompleted: boolean;
        articleCount: number;
        chunkCount: number;
      };
      assert.equal(repeated.alreadyCompleted, true);
      assert.equal(repeated.articleCount, 26);
      assert.equal(repeated.chunkCount, 2);

      const baselineZero = await createTeamAuthoringBaseline({
        articleId: "article_000",
        assetIdsAndHashes: [{ hash: "a".repeat(64), id: "asset_d1" }],
        authorName: "OPAS",
        categoryId: "category_d1",
        categoryName: "Guides",
        categorySlug: "guides",
        isFaq: true,
        mdx: "# Article 0\n\nBody 0.",
        position: 0,
        slug: "article-0",
        status: "published",
        title: "Article 0",
        workspaceId: "workspace_d1",
      });
      assert.deepEqual(
        query(
          persistDirectory,
          `select revision.id, revision.revision_hash, revision.created_at,
                  head.review_state, head.published_revision_id
           from article_revisions revision
           inner join article_heads head
             on head.workspace_id = revision.workspace_id
             and head.article_id = revision.article_id
           where revision.article_id = 'article_000'`,
        ),
        [
          {
            created_at: fixedTime,
            id: baselineZero.revisionId,
            published_revision_id: baselineZero.revisionId,
            revision_hash: baselineZero.revisionHash,
            review_state: "published",
          },
        ],
      );
      assert.deepEqual(
        query(
          persistDirectory,
          `select count(*) as count
           from article_revisions revision
           inner join articles article
             on article.id = revision.article_id
             and article.workspace_id = revision.workspace_id
           where revision.created_at = article.updated_at`,
        ),
        [{ count: 26 }],
      );
      assert.deepEqual(query(persistDirectory, "pragma foreign_key_check"), []);

      executeSql(
        persistDirectory,
        `update workspace_authoring_controls set writes_paused = 0
         where workspace_id = 'workspace_d1';
         delete from article_heads
         where workspace_id = 'workspace_d1' and article_id = 'article_000';
         update workspace_authoring_controls set writes_paused = 1
         where workspace_id = 'workspace_d1';`,
      );
      const completedLedgerHeadInsert = executeSql(
        persistDirectory,
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, published_revision_id, published_revision_number,
           review_state, submitted_by_member_id, archived_at, archived_by_member_id
         ) values (
           'article_000', 'workspace_d1', '${baselineZero.revisionId}', 1,
           'article-0', '${baselineZero.revisionId}', 1, 'published', null, null, null
         )`,
        { allowFailure: true },
      );
      assert.notEqual(completedLedgerHeadInsert.status, 0);
      assert.match(completedLedgerHeadInsert.output, /AUTHORING_PAUSED/u);
      executeSql(
        persistDirectory,
        `update workspace_authoring_controls set writes_paused = 0
         where workspace_id = 'workspace_d1';
         insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, published_revision_id, published_revision_number,
           review_state, submitted_by_member_id, archived_at, archived_by_member_id
         ) values (
           'article_000', 'workspace_d1', '${baselineZero.revisionId}', 1,
           'article-0', '${baselineZero.revisionId}', 1, 'published', null, null, null
         );
         update workspace_authoring_controls set writes_paused = 1
         where workspace_id = 'workspace_d1';`,
      );

      const immutable = executeSql(
        persistDirectory,
        "update article_revisions set title = 'Changed' where article_id = 'article_000'",
        { allowFailure: true },
      );
      assert.notEqual(immutable.status, 0);
      assert.match(immutable.output, /ARTICLE_REVISION_IMMUTABLE/u);
      const paused = executeSql(
        persistDirectory,
        `insert into article_slug_claims
           (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
         values ('workspace_d1', 'blocked', 'article_000', 1, 0)`,
        { allowFailure: true },
      );
      assert.notEqual(paused.status, 0);
      assert.match(paused.output, /AUTHORING_PAUSED/u);
      const assetDelete = executeSql(
        persistDirectory,
        "delete from assets where id = 'asset_d1'",
        { allowFailure: true },
      );
      assert.notEqual(assetDelete.status, 0);
      assert.match(assetDelete.output, /ASSET_IN_REVISION/u);

      await stopWorker(worker.child);
      worker = undefined;
      const resumed = resumeAuthoring(persistDirectory, 1);
      assert.match(resumed.output, /"writesPaused": false/u);
      const wrongRevisionNumber = executeSql(
        persistDirectory,
        `update article_heads set working_revision_number = 2
         where article_id = 'article_001'`,
        { allowFailure: true },
      );
      assert.notEqual(wrongRevisionNumber.status, 0);
      assert.match(
        wrongRevisionNumber.output,
        /FOREIGN KEY constraint failed|ARTICLE_HEAD_INVALID/u,
      );
      const invalidArchive = executeSql(
        persistDirectory,
        `update article_heads set archived_at = ${fixedTime}
         where article_id = 'article_000'`,
        { allowFailure: true },
      );
      assert.notEqual(invalidArchive.status, 0);
      assert.match(invalidArchive.output, /ARTICLE_HEAD_INVALID/u);
      const invalidReview = executeSql(
        persistDirectory,
        `update article_heads set review_state = 'invalid'
         where article_id = 'article_001'`,
        { allowFailure: true },
      );
      assert.notEqual(invalidReview.status, 0);
      assert.match(invalidReview.output, /article_heads_review_state_check/u);
      const headlessPublished = executeSql(
        persistDirectory,
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values (
           'article_headless', 'workspace_d1', 'category_d1', 'headless',
           'Headless', '# Headless', 'published', 0, 'OPAS', 0,
           ${fixedTime}, ${fixedTime}
         )`,
        { allowFailure: true },
      );
      assert.notEqual(headlessPublished.status, 0);
      assert.match(headlessPublished.output, /ARTICLE_MATERIALIZATION_INVALID/u);
      executeSql(persistDirectory, "delete from workspaces where id = 'workspace_d1'");
      assert.deepEqual(query(persistDirectory, "pragma foreign_key_check"), []);
      assert.deepEqual(query(persistDirectory, "select count(*) as count from article_revisions"), [
        { count: 0 },
      ]);
      succeeded = true;
    } finally {
      if (worker) await stopWorker(worker.child);
      if (succeeded) rmSync(directory, { force: true, recursive: true });
      else console.error(`Native D1 fixture retained at ${directory}`);
    }
  },
);
