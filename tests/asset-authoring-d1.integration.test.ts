// ABOUTME: Verifies authorized asset lifecycle guarantees in Wrangler's native local D1 runtime.
// ABOUTME: Covers atomic rollback, authoring pause, named actors, cleanup, and revision retention.

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
  "tests/fixtures/asset-authoring-d1/wrangler.jsonc",
);
const databaseName = "opas-asset-authoring-test";

type ActorRejection = Readonly<{
  manifestRetained: boolean;
  rejected: number;
  unchanged: boolean;
}>;

type ExerciseResult = Readonly<{
  cleanupRemovedExpiredManifests: boolean;
  cleanupRemovedOrphan: boolean;
  cleanupRetainedRevisionAsset: boolean;
  createdManifest: boolean;
  disabled: ActorRejection;
  discardedAsset: boolean;
  discardedManifest: boolean;
  error?: string;
  invalidStageRejected: boolean;
  invalidStageRolledBack: boolean;
  pauseCodes: readonly string[];
  pausedManifestRetained: boolean;
  pausedUnchanged: boolean;
  reviewer: ActorRejection;
  revoked: ActorRejection;
  stagedAsset: boolean;
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

test("native D1 asset writes stay atomic, authorized, and revision-safe", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opas-asset-authoring-d1-"));
  const persistDirectory = path.join(directory, "state");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    migrate(persistDirectory);
    worker = await startWorker(persistDirectory);
    const response = await fetch(`${worker.origin}/exercise`, { method: "POST" });
    const body = (await response.json()) as ExerciseResult;
    assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
    assert.equal(body.createdManifest, true);
    assert.equal(body.stagedAsset, true);
    assert.equal(body.discardedManifest, true);
    assert.equal(body.discardedAsset, true);
    assert.equal(body.invalidStageRejected, true);
    assert.equal(body.invalidStageRolledBack, true);
    assert.deepEqual(body.pauseCodes, Array(4).fill("AUTHORING_PAUSED"));
    assert.equal(body.pausedUnchanged, true);
    assert.equal(body.pausedManifestRetained, true);
    for (const rejection of [body.disabled, body.revoked, body.reviewer]) {
      assert.deepEqual(rejection, {
        manifestRetained: true,
        rejected: 4,
        unchanged: true,
      });
    }
    assert.equal(body.cleanupRemovedExpiredManifests, true);
    assert.equal(body.cleanupRemovedOrphan, true);
    assert.equal(body.cleanupRetainedRevisionAsset, true);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(directory, { force: true, recursive: true });
  }
});
