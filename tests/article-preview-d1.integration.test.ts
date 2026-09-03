// ABOUTME: Verifies signed preview grants through Wrangler's native local D1 runtime.
// ABOUTME: Covers collision rollback, concurrent rotation, scoped assets, and paused revocation.

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
  "tests/fixtures/article-preview-d1/wrangler.jsonc",
);
const databaseName = "opas-article-preview-test";

type ExerciseResult = Readonly<{
  activeId: string;
  archivedAsset: boolean;
  archivedDocument: boolean;
  collision: Readonly<{ code: string; outcome: string }>;
  concurrentRevocations: readonly string[];
  firstStillValidAfterCollision: boolean;
  managedActiveId: string | null;
  managedAfterExpiry: boolean;
  managedAfterRevocation: boolean;
  managedWrongRevision: boolean;
  managedWrongSession: boolean;
  pausedCode: string | null;
  resolutionCount: number;
  resolvedAssetHash: string | null;
  resolvedMdx: string | null;
  revoked: Readonly<{ outcome: string }>;
  rotations: readonly string[];
  storedBearer: boolean;
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

test("native D1 signed previews keep one exact active grant", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opas-article-preview-d1-"));
  const persistDirectory = path.join(directory, "state");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    migrate(persistDirectory);
    worker = await startWorker(persistDirectory);
    const setup = await fetch(`${worker.origin}/setup`, { method: "POST" });
    assert.equal(setup.status, 200, `${await setup.text()}\n${worker.output()}`);
    const issuedResponse = await fetch(`${worker.origin}/http/issue`, {
      method: "POST",
    });
    const issuedBody = await issuedResponse.text();
    assert.equal(
      issuedResponse.status,
      200,
      `${issuedBody}\n${worker.output()}`,
    );
    const issued = JSON.parse(issuedBody) as { url: string };
    const token = new URL(issued.url).hash.slice(1);
    assert.ok(token);
    const exchangeUrl = `${worker.origin}/preview/exchange`;
    const exchanged = await fetch(exchangeUrl, {
      body: JSON.stringify({ bearer: token }),
      headers: {
        "content-type": "application/json",
        origin: worker.origin,
        referer: `${worker.origin}/preview`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    const exchangeBody = await exchanged.text();
    assert.equal(exchanged.status, 200, `${exchangeBody}\n${worker.output()}`);
    assert.deepEqual(JSON.parse(exchangeBody), { outcome: "exchanged" });
    const setCookie = exchanged.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /Path=\/preview/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=lax/iu);
    assert.doesNotMatch(setCookie, /Domain=/iu);
    const cookie = setCookie.split(";", 1)[0];
    assert.ok(cookie);
    const session = await fetch(`${worker.origin}/preview/session`, {
      headers: {
        cookie,
        referer: `${worker.origin}/preview`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    });
    const sessionBody = await session.text();
    assert.equal(session.status, 200, `${sessionBody}\n${worker.output()}`);
    assert.deepEqual(JSON.parse(sessionBody), { outcome: "active" });
    const assetResponse = await fetch(
      `${worker.origin}/preview/assets/${"a".repeat(64)}`,
      { headers: { cookie, referer: `${worker.origin}/preview` } },
    );
    const assetBody = new Uint8Array(await assetResponse.arrayBuffer());
    assert.equal(
      assetResponse.status,
      200,
      `${new TextDecoder().decode(assetBody)}\n${worker.output()}`,
    );
    assert.equal(assetResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(assetResponse.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(assetResponse.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(
      assetBody,
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    assert.equal(exchangeUrl.includes(token), false);
    assert.equal(worker.output().includes(token), false);
    assert.equal(worker.output().includes(encodeURIComponent(token)), false);
    const response = await fetch(`${worker.origin}/exercise`, { method: "POST" });
    const body = (await response.json()) as ExerciseResult & { error?: string };
    assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
    assert.deepEqual(body.collision, {
      outcome: "rejected",
      code: "GRANT_ID_COLLISION_EXHAUSTED",
    });
    assert.equal(body.firstStillValidAfterCollision, true);
    assert.equal(body.managedActiveId, body.activeId);
    assert.equal(body.managedAfterExpiry, false);
    assert.equal(body.managedAfterRevocation, false);
    assert.equal(body.managedWrongRevision, false);
    assert.equal(body.managedWrongSession, false);
    assert.deepEqual(body.rotations, ["issued", "issued"]);
    assert.equal(
      body.concurrentRevocations.filter((outcome) => outcome === "revoked").length,
      1,
    );
    assert.equal(
      body.concurrentRevocations.filter((outcome) => outcome === "rejected").length,
      1,
    );
    assert.equal(body.resolutionCount, 1);
    assert.equal(body.resolvedAssetHash, "a".repeat(64));
    assert.match(body.resolvedMdx ?? "", /\/preview\/assets\//u);
    assert.equal(body.storedBearer, false);
    assert.equal(body.pausedCode, "AUTHORING_PAUSED");
    assert.deepEqual(body.revoked, { outcome: "revoked" });
    assert.equal(body.archivedDocument, false);
    assert.equal(body.archivedAsset, false);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(directory, { force: true, recursive: true });
  }
});
