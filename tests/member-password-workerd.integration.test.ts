// ABOUTME: Runs the fixed PBKDF2 cost gate in a native Wrangler-local workerd process.
// ABOUTME: Times one verification per request over five warmups and twenty measurements.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";

import { memberPasswordScheme } from "@/auth/member-password";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/member-password-workerd/wrangler.jsonc",
);

type BenchmarkResult = Readonly<{
  iterations: number;
  scheme: typeof memberPasswordScheme;
  verified: boolean;
}>;

const benchmarkToken = "local-workerd-benchmark-only";
const warmupCount = 5;
const measuredCount = 20;

function percentile95(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

async function measureVerification(origin: string) {
  const startedAt = performance.now();
  const response = await fetch(`${origin}/verify`, {
    headers: { Authorization: `Bearer ${benchmarkToken}` },
    method: "POST",
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  const body = (await response.json()) as BenchmarkResult;
  assert.equal(response.status, 200);
  assert.equal(body.iterations, 600_000);
  assert.deepEqual(body.scheme, memberPasswordScheme);
  assert.equal(body.verified, true);
  return elapsedMilliseconds;
}

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

async function startWorker() {
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
      "--var",
      "BENCHMARK_AUTH_TOKEN:local-workerd-benchmark-only",
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
  "native workerd verifies the fixed member-password cost below the release p95",
  { timeout: 120_000 },
  async () => {
    const worker = await startWorker();
    try {
      const unauthorized = await fetch(`${worker.origin}/verify`, {
        method: "POST",
      });
      assert.equal(unauthorized.status, 404);

      for (let index = 0; index < warmupCount; index += 1) {
        await measureVerification(worker.origin);
      }
      const samplesMilliseconds: number[] = [];
      for (let index = 0; index < measuredCount; index += 1) {
        samplesMilliseconds.push(await measureVerification(worker.origin));
      }
      const p95Milliseconds = percentile95(samplesMilliseconds);
      assert.ok(
        samplesMilliseconds.every(
          (sample) => Number.isFinite(sample) && sample >= 0,
        ),
      );
      assert.ok(
        p95Milliseconds <= 1_000,
        `workerd PBKDF2 p95 ${p95Milliseconds.toFixed(3)} ms exceeds 1,000 ms`,
      );
      console.info(
        `workerd PBKDF2 ${memberPasswordScheme.totalIterations.toLocaleString("en-US")} iterations: p95 ${p95Milliseconds.toFixed(3)} ms across ${measuredCount} measurements`,
      );
    } finally {
      await stopWorker(worker.child);
    }
  },
);
