// ABOUTME: Verifies immutable draft-save batches inside Wrangler's native local D1 runtime.
// ABOUTME: Proves D1 serializes stale-head and competing-slug writes to one winner.
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
  "tests/fixtures/article-drafts-d1/wrangler.jsonc",
);
const databaseName = "opas-article-drafts-test";

type DraftOutcome = Readonly<{
  status: "saved" | "unchanged" | "conflict" | "rejected";
  code?: string;
  revisionNumber?: number;
}>;

type ExerciseResult = Readonly<{
  initial: DraftOutcome;
  race: readonly DraftOutcome[];
  second: DraftOutcome;
  unchanged: DraftOutcome;
  invalidRevision: DraftOutcome;
  pausedCode: string | null;
  slugRace: readonly DraftOutcome[];
  revisionCount: number;
  head: { working_revision_number: number; working_slug: string };
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

test("native D1 draft batches admit one head and slug winner", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opas-article-drafts-d1-"));
  const persistDirectory = path.join(directory, "state");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    migrate(persistDirectory);
    worker = await startWorker(persistDirectory);
    const setup = await fetch(`${worker.origin}/setup`, { method: "POST" });
    assert.equal(setup.status, 200, `${await setup.text()}\n${worker.output()}`);
    const response = await fetch(`${worker.origin}/exercise`, { method: "POST" });
    const body = (await response.json()) as ExerciseResult & { error?: string };
    assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
    assert.equal(body.initial.status, "saved");
    assert.equal(body.race.filter((result) => result.status === "saved").length, 1);
    assert.equal(body.race.filter((result) => result.code === "STALE_REVISION").length, 11);
    assert.equal(body.second.status, "saved");
    assert.equal(body.second.revisionNumber, 3);
    assert.equal(body.unchanged.status, "unchanged");
    assert.deepEqual(body.invalidRevision, {
      status: "rejected",
      code: "INVALID_REVISION_NUMBER",
    });
    assert.equal(body.pausedCode, "AUTHORING_PAUSED");
    assert.equal(body.revisionCount, 3);
    assert.deepEqual(body.head, {
      working_revision_number: 3,
      working_slug: "d1-second",
    });
    assert.equal(body.slugRace.filter((result) => result.status === "saved").length, 1);
    assert.equal(body.slugRace.filter((result) => result.code === "SLUG_CONFLICT").length, 1);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(directory, { force: true, recursive: true });
  }
});
