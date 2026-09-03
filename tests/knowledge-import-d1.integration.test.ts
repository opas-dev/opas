// ABOUTME: Verifies private import activation through Wrangler's native local D1 runtime.
// ABOUTME: Enforces the fixed 100-article statement budget, races, and draft isolation.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/knowledge-import-d1/wrangler.jsonc",
);
const databaseName = "opas-knowledge-import-test";

type ExerciseResult = Readonly<{
  error?: string;
  statementCount: number;
  sourcePublished: number;
  publicUnchanged: boolean;
  initialClaims: { articleSlugs: string[]; categorySlugs: string[] };
  budget: {
    articles: { count: number; published: number | null; materialized: number | null };
    categories: { count: number };
    revisions: { count: number; attributed: number | null };
    heads: { count: number; private_heads: number | null };
    publicAssets: { count: number };
    evidence: { count: number };
    jobs: { count: number };
    index: { count: number };
  };
  race: Array<{ status: string; code?: string }>;
  raceInventory: {
    articles: { count: number; published: number | null; materialized: number | null };
    categories: { count: number };
    revisions: { count: number; attributed: number | null };
    heads: { count: number; private_heads: number | null };
  };
}>;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function migrate(persistDirectory: string) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerEntry,
      "d1",
      "migrations",
      "apply",
      databaseName,
      "--local",
      "--config",
      fixtureConfig,
      "--persist-to",
      persistDirectory,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  assert.equal(
    result.status,
    0,
    `D1 migration failed.\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`Wrangler exited early.\n${output}`);
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

test(
  "native D1 keeps the frozen 100-article import private within the statement budget",
  { timeout: 180_000 },
  async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "opas-knowledge-import-d1-"));
    const persistDirectory = path.join(directory, "state");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      migrate(persistDirectory);
      worker = await startWorker(persistDirectory);
      const setup = await fetch(`${worker.origin}/setup`, { method: "POST" });
      assert.equal(setup.status, 200, `${await setup.text()}\n${worker.output()}`);
      const response = await fetch(`${worker.origin}/exercise`, { method: "POST" });
      const body = (await response.json()) as ExerciseResult;
      assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
      assert.deepEqual(body.initialClaims, { articleSlugs: [], categorySlugs: [] });
      assert.equal(body.sourcePublished, 50);
      assert.ok(body.statementCount <= 800, `D1 import used ${body.statementCount} statements`);
      context.diagnostic(`D1 statements/queries: ${body.statementCount}/800`);
      assert.deepEqual(body.budget.articles, {
        count: 100,
        published: 0,
        materialized: 0,
      });
      assert.deepEqual(body.budget.categories, { count: 2 });
      assert.deepEqual(body.budget.revisions, { count: 100, attributed: 100 });
      assert.deepEqual(body.budget.heads, { count: 100, private_heads: 100 });
      assert.deepEqual(body.budget.publicAssets, { count: 0 });
      assert.deepEqual(body.budget.evidence, { count: 0 });
      assert.deepEqual(body.budget.jobs, { count: 0 });
      assert.deepEqual(body.budget.index, { count: 0 });
      assert.equal(body.publicUnchanged, true);
      assert.equal(body.race.filter(({ status }) => status === "activated").length, 1);
      assert.deepEqual(
        body.race.filter(({ status }) => status === "rejected").map(({ code }) => code),
        ["ARTICLE_CONFLICT"],
      );
      assert.deepEqual(body.raceInventory.articles, {
        count: 1,
        published: 0,
        materialized: 0,
      });
      assert.deepEqual(body.raceInventory.categories, { count: 1 });
      assert.deepEqual(body.raceInventory.revisions, { count: 1, attributed: 1 });
      assert.deepEqual(body.raceInventory.heads, { count: 1, private_heads: 1 });
    } finally {
      if (worker) await stopWorker(worker.child);
      rmSync(directory, { force: true, recursive: true });
    }
  },
);
