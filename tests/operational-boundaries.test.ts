// ABOUTME: Enforces that runtime and operator commands cannot use obsolete unauthenticated authoring APIs.
// ABOUTME: Keeps the CROFusion corpus command write-free and stateless administrator tokens absent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [target] : [];
  });
}

test("runtime and operator commands do not call obsolete content or asset writes", () => {
  const forbidden = [
    "createArticle",
    "updateArticle",
    "deleteArticle",
    "createAssetManifest",
    "stageAsset",
    "discardAssetManifest",
    "cleanupExpiredAssets",
    "saveQuestionSet",
    "startEvaluationRun",
    "finishEvaluationRun",
    "updateEvaluationRunResults",
  ];
  const targets = [
    ...sourceFiles(path.join(root, "src/app")),
    ...sourceFiles(path.join(root, "src/quality")),
    ...sourceFiles(path.join(root, "scripts")),
  ];
  for (const file of targets) {
    const source = readFileSync(file, "utf8");
    for (const method of forbidden) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\.${method}\\s*\\(`, "u"),
        `${path.relative(root, file)} calls ${method}`,
      );
    }
  }

  const retrievalVerifier = readFileSync(
    path.join(root, "scripts/verify-retrieval-runtime.ts"),
    "utf8",
  );
  assert.match(
    retrievalVerifier,
    /type RetrievalVerificationRepository = Pick</u,
  );
  assert.doesNotMatch(retrievalVerifier, /repository:\s*Repository\b/u);
});

test("database repositories do not expose obsolete unauthenticated authoring methods", () => {
  const forbidden = [
    "createArticle",
    "updateArticle",
    "deleteArticle",
    "createAssetManifest",
    "stageAsset",
    "discardAssetManifest",
    "cleanupExpiredAssets",
    "saveQuestionSet",
    "startEvaluationRun",
    "finishEvaluationRun",
    "updateEvaluationRunResults",
  ];
  const targets = [
    "src/db/repository.ts",
    "src/db/postgres/repository.ts",
    "src/db/sqlite/repository.ts",
    "src/db/postgres/evidence-repository.ts",
    "src/db/sqlite/evidence-repository.ts",
  ];
  for (const target of targets) {
    const source = readFileSync(path.join(root, target), "utf8");
    for (const method of forbidden) {
      assert.doesNotMatch(
        source,
        new RegExp(`(?:async\\s+)?${method}\\s*\\(`, "u"),
        `${target} exposes ${method}`,
      );
    }
  }
});

test("the CROFusion archive command only produces a private import plan", () => {
  const commandPath = path.join(root, "scripts/import-crofusion-launch-partner.ts");
  const command = readFileSync(commandPath, "utf8");
  assert.match(command, /extractArchiveFiles/u);
  assert.match(command, /planKnowledgeImport/u);
  assert.match(command, /article\.status !== "draft"/u);
  for (const forbidden of [
    "fetch(",
    "ADMIN_SESSION_SECRET",
    "adminSessionCookie",
    "createAdminSessionToken",
    'value !== "activate"',
  ]) {
    assert.equal(command.includes(forbidden), false, forbidden);
  }
  assert.equal(existsSync(path.join(root, "src/auth/session.ts")), false);

  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", commandPath, "verify"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as Record<string, unknown>;
  const first = run();
  assert.deepEqual(run(), first);
  assert.equal(first.status, "ready");
  assert.equal(first.articles, 12);
  assert.equal(first.privateDrafts, 12);
  assert.equal(first.errors, 0);
  assert.match(String(first.archiveSha256), /^[a-f\d]{64}$/u);
});
