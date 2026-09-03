// ABOUTME: Runs the preview-expiry operator mutation through a native local D1 Worker.
// ABOUTME: Verifies database expiry rejection and immutable-trigger restoration on workerd.

import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(
  repositoryRoot,
  "node_modules/wrangler/bin/wrangler.js",
);
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/preview-expiry-d1/wrangler.jsonc",
);
const databaseName = "opas-acceptance-expiry-d1-001";

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
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      wranglerEntry,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`Wrangler exited early.\n${output}`);
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return { child, origin, output: () => output };
      }
      await response.arrayBuffer();
    } catch {
      // Wrangler needs time to bundle the command and open the local D1 binding.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
  "native D1 expiry moves one grant and rejects its page and asset",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opas-preview-expiry-d1-"));
    const persistDirectory = path.join(directory, "state");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      migrate(persistDirectory);
      worker = await startWorker(persistDirectory);
      let response: Response;
      try {
        response = await fetch(`${worker.origin}/exercise`, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        assert.fail(
          `D1 exercise request failed: ${
            error instanceof Error ? error.message : String(error)
          }\n${worker.output()}`,
        );
      }
      const body = (await response.json()) as {
        assetStatus?: number;
        createdAt?: number;
        error?: string;
        expiredAt?: number;
        guardedAfter?: boolean;
        guardedBefore?: boolean;
        result?: Readonly<{
          expiredAt: string;
          grantId: string;
          outcome: string;
        }>;
        sessionStatus?: number;
        triggerCount?: number;
      };
      assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
      assert.equal(body.guardedBefore, true);
      assert.equal(body.guardedAfter, true);
      assert.equal(body.triggerCount, 1);
      assert.equal(body.expiredAt, Date.parse("2026-09-03T12:04:59.000Z"));
      assert.equal(
        (body.expiredAt ?? 0) - (body.createdAt ?? 0),
        7 * 24 * 60 * 60 * 1_000,
      );
      assert.deepEqual(body.result, {
        expiredAt: "2026-09-03T12:04:59.000Z",
        grantId: "A".repeat(43),
        outcome: "expired",
      });
      assert.equal(body.sessionStatus, 401);
      assert.equal(body.assetStatus, 404);
    } finally {
      if (worker) await stopWorker(worker.child);
      rmSync(directory, { force: true, recursive: true });
    }
  },
);
