// ABOUTME: Verifies atomic typed demo seeds through Wrangler's native local D1 runtime.
// ABOUTME: Covers bootstrap, exact BLOBs, no-write reruns, profiles, and every batch failure.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { crofusionDemoContent } from "@/db/demo-crofusion";
import { demoContent, demoMarkAssetHash } from "@/db/demo";
import { initialDemoSeedReason } from "@/db/demo-seed";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/demo-seed-d1/wrangler.jsonc",
);
const databaseName = "opas-demo-seed-test";

type Snapshot = Readonly<{
  counts: Readonly<Record<string, number>>;
  integrity: Readonly<{ publishedMaterializationFailures: number }>;
  rows: Readonly<{
    articles: readonly Record<string, unknown>[];
    assets: readonly Record<string, unknown>[];
    events: readonly Record<string, unknown>[];
    heads: readonly Record<string, unknown>[];
    revisions: readonly Record<string, unknown>[];
    themes: readonly Record<string, unknown>[];
  }>;
}>;

type SeedResponse = Readonly<{
  articleCount?: number;
  batchCount: number;
  code?: string | null;
  message?: string;
  revisionCount?: number;
  statementCount?: number;
  status?: "seeded" | "verified_existing";
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

async function post<T>(origin: string, pathname: string) {
  const response = await fetch(`${origin}${pathname}`, { method: "POST" });
  return { body: (await response.json()) as T, status: response.status };
}

async function d1Snapshot(origin: string) {
  const response = await post<Snapshot>(origin, "/snapshot");
  assert.equal(response.status, 200);
  return response.body;
}

function assertNoSeedRows(snapshot: Snapshot) {
  for (const [table, count] of Object.entries(snapshot.counts)) {
    assert.equal(count, 0, `${table} retained a partial seed row`);
  }
}

async function exerciseGenericProfile(origin: string, output: () => string) {
  const beforeBootstrap = await post<SeedResponse>(origin, "/seed");
  assert.equal(beforeBootstrap.status, 409, output());
  assert.equal(beforeBootstrap.body.code, "DEMO_SEED_REQUIRES_BOOTSTRAP");
  assert.equal(beforeBootstrap.body.batchCount, 0);
  assertNoSeedRows(await d1Snapshot(origin));

  assert.equal((await post(origin, "/bootstrap?profile=opas")).status, 200);
  const seeded = await post<SeedResponse>(origin, "/seed?profile=opas");
  assert.equal(seeded.status, 200, `${seeded.body.message ?? ""}\n${output()}`);
  assert.equal(seeded.body.status, "seeded");
  assert.equal(seeded.body.batchCount, 1);
  assert.ok((seeded.body.statementCount ?? 0) > 0);

  const complete = await d1Snapshot(origin);
  const publishedCount = demoContent.articles.filter(
    ({ status }) => status === "published",
  ).length;
  assert.equal(complete.counts.categories, demoContent.categories.length);
  assert.equal(complete.counts.themes, 1);
  assert.equal(complete.counts.articles, demoContent.articles.length);
  assert.equal(complete.counts.article_revisions, demoContent.articles.length);
  assert.equal(complete.counts.article_heads, demoContent.articles.length);
  assert.equal(complete.counts.article_slug_claims, demoContent.articles.length);
  assert.equal(complete.counts.article_review_events, publishedCount);
  assert.equal(complete.counts.embedding_jobs, publishedCount);
  assert.equal(complete.counts.evidence_chunks, 18);
  assert.equal(complete.counts.workspace_index_states, 1);
  assert.equal(complete.counts.assets, 1);
  assert.equal(complete.counts.article_assets, 1);
  assert.equal(complete.counts.article_revision_assets, 1);
  assert.equal(complete.integrity.publishedMaterializationFailures, 0);
  assert.equal(
    complete.rows.articles.filter(({ status }) => status === "published").length,
    publishedCount,
  );
  assert.equal(
    complete.rows.articles.filter(
      ({ contentHash, status }) => status === "draft" && contentHash === null,
    ).length,
    demoContent.articles.length - publishedCount,
  );
  assert.ok(
    complete.rows.revisions.every(
      (revision) =>
        revision.revisionNumber === 1 &&
        revision.changeKind === "seed" &&
        revision.memberId === "member_demo_seed_administrator",
    ),
  );
  assert.ok(
    complete.rows.events.every(
      (event) =>
        event.action === "emergency_published" &&
        event.note === initialDemoSeedReason &&
        event.memberId === "member_demo_seed_administrator",
    ),
  );
  const [asset] = complete.rows.assets;
  assert.equal(asset?.byteSize, 134);
  assert.equal(asset?.hash, demoMarkAssetHash);
  assert.equal(asset?.id, "asset_demo_mark");
  assert.equal(asset?.mediaType, "image/png");
  assert.equal(typeof asset?.contentHex, "string");
  const assetContent = Buffer.from(asset?.contentHex as string, "hex");
  assert.equal(assetContent.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(createHash("sha256").update(assetContent).digest("hex"), demoMarkAssetHash);

  assert.equal((await post(origin, "/mutate")).status, 200);
  assert.equal((await post(origin, "/edit")).status, 200);
  const changed = await d1Snapshot(origin);
  assert.equal(
    changed.counts.article_revisions,
    demoContent.articles.length + 1,
  );
  assert.equal(
    changed.rows.revisions.filter(
      ({ changeKind, revisionNumber }) =>
        changeKind === "manual" && revisionNumber === 2,
    ).length,
    1,
  );
  assert.equal(
    changed.rows.events.filter(({ action }) => action === "submitted").length,
    1,
  );
  assert.equal(
    changed.rows.heads.filter(
      ({ publishedRevisionNumber, reviewState, workingRevisionNumber }) =>
        publishedRevisionNumber === 1 &&
        reviewState === "in_review" &&
        workingRevisionNumber === 2,
    ).length,
    1,
  );
  const repeated = await post<SeedResponse>(origin, "/seed?profile=opas");
  assert.equal(repeated.status, 200, output());
  assert.equal(repeated.body.status, "verified_existing");
  assert.equal(repeated.body.batchCount, 0);
  assert.deepEqual(await d1Snapshot(origin), changed);

  assert.equal((await post(origin, "/corrupt")).status, 200);
  const corrupted = await d1Snapshot(origin);
  const rejected = await post<SeedResponse>(origin, "/seed?profile=opas");
  assert.equal(rejected.status, 409, output());
  assert.equal(rejected.body.code, "DEMO_SEED_VERIFICATION_FAILED");
  assert.equal(rejected.body.batchCount, 0);
  assert.deepEqual(await d1Snapshot(origin), corrupted);

  assert.equal((await post(origin, "/clear")).status, 200);
  assertNoSeedRows(await d1Snapshot(origin));
  for (let statement = 1; statement <= (seeded.body.statementCount ?? 0); statement += 1) {
    const failed = await post<SeedResponse>(
      origin,
      `/seed?profile=opas&failAfter=${statement}`,
    );
    assert.equal(failed.status, 409, `${JSON.stringify(failed.body)}\n${output()}`);
    assert.equal(failed.body.batchCount, 1);
    assertNoSeedRows(await d1Snapshot(origin));
  }
  const retried = await post<SeedResponse>(origin, "/seed?profile=opas");
  assert.equal(retried.status, 200, output());
  assert.equal(retried.body.status, "seeded");
  assert.equal(retried.body.batchCount, 1);

  assert.equal((await post(origin, "/clear")).status, 200);
  const concurrent = await Promise.all([
    post<SeedResponse>(origin, "/seed?profile=opas"),
    post<SeedResponse>(origin, "/seed?profile=opas"),
  ]);
  assert.ok(concurrent.every(({ status }) => status === 200), output());
  assert.deepEqual(
    concurrent.map(({ body }) => body.status).sort(),
    ["seeded", "verified_existing"],
  );
  assert.equal((await d1Snapshot(origin)).counts.articles, demoContent.articles.length);

  assert.equal((await post(origin, "/clear")).status, 200);
  assert.equal((await post(origin, "/pause")).status, 200);
  const paused = await post<SeedResponse>(origin, "/seed?profile=opas");
  assert.equal(paused.status, 409, output());
  assert.equal(paused.body.code, "AUTHORING_PAUSED");
  assert.equal(paused.body.batchCount, 0);
  assertNoSeedRows(await d1Snapshot(origin));
}

async function exerciseCrofusionProfile(origin: string, output: () => string) {
  assert.equal((await post(origin, "/bootstrap?profile=crofusion")).status, 200);
  const seeded = await post<SeedResponse>(origin, "/seed?profile=crofusion");
  assert.equal(seeded.status, 200, `${seeded.body.message ?? ""}\n${output()}`);
  assert.equal(seeded.body.status, "seeded");
  assert.equal(seeded.body.batchCount, 1);
  const complete = await d1Snapshot(origin);
  assert.equal(complete.counts.categories, crofusionDemoContent.categories.length);
  assert.equal(complete.counts.articles, crofusionDemoContent.articles.length);
  assert.equal(
    complete.counts.article_revisions,
    crofusionDemoContent.articles.length,
  );
  assert.equal(complete.counts.article_heads, crofusionDemoContent.articles.length);
  assert.equal(
    complete.counts.article_slug_claims,
    crofusionDemoContent.articles.length,
  );
  assert.equal(
    complete.counts.article_review_events,
    crofusionDemoContent.articles.length,
  );
  assert.equal(complete.counts.embedding_jobs, crofusionDemoContent.articles.length);
  assert.equal(complete.counts.evidence_chunks, 13);
  assert.equal(complete.counts.workspace_index_states, 1);
  assert.equal(complete.counts.themes, 1);
  assert.equal(complete.counts.assets, 0);
  assert.equal(complete.counts.article_assets, 0);
  assert.equal(complete.counts.article_revision_assets, 0);
  assert.equal(complete.integrity.publishedMaterializationFailures, 0);
  assert.ok(complete.rows.articles.every((article) => article.status === "published"));
  assert.ok(
    complete.rows.revisions.every(
      (revision) =>
        revision.revisionNumber === 1 &&
        revision.changeKind === "seed" &&
        revision.memberId === "member_demo_seed_administrator",
    ),
  );
  assert.ok(
    complete.rows.events.every(
      (event) =>
        event.action === "emergency_published" &&
        event.note === initialDemoSeedReason &&
        event.memberId === "member_demo_seed_administrator",
    ),
  );
  assert.ok(
    complete.rows.heads.every(
      (head) =>
        head.reviewState === "published" &&
        head.workingRevisionNumber === 1 &&
        head.publishedRevisionNumber === 1 &&
        head.workingRevisionId === head.publishedRevisionId,
    ),
  );
}

test("native D1 runs each fixed demo seed in one atomic batch", { timeout: 180_000 }, async () => {
  for (const profile of ["opas", "crofusion"] as const) {
    const directory = mkdtempSync(path.join(tmpdir(), `opas-demo-seed-${profile}-`));
    const persistDirectory = path.join(directory, "state");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      migrate(persistDirectory);
      worker = await startWorker(persistDirectory);
      if (profile === "opas") {
        await exerciseGenericProfile(worker.origin, worker.output);
      } else {
        await exerciseCrofusionProfile(worker.origin, worker.output);
      }
    } finally {
      if (worker) await stopWorker(worker.child);
      rmSync(directory, { force: true, recursive: true });
    }
  }
});
