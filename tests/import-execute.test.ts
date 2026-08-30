// ABOUTME: Verifies plan-to-repository mapping and manifest cleanup around atomic imports.
// ABOUTME: Keeps staging failures, activation failures, and published timestamps deterministic.
import assert from "node:assert/strict";
import test from "node:test";

import type {
  Asset,
  AssetManifest,
  KnowledgeImport,
} from "@/db/repository";
import {
  executeKnowledgeImport,
  ImportExecutionError,
} from "@/import/execute";
import type { KnowledgeImportPlan } from "@/import/planner";
import { completedImportReport } from "@/import/report";

const now = new Date("2026-08-30T09:00:00.000Z");
const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hash = "a".repeat(64);

function plan(): KnowledgeImportPlan {
  return {
    ready: true,
    categories: [{ name: "Guides", slug: "guides", position: 0 }],
    articles: [
      {
        sourcePath: "guide.md",
        categorySlug: "guides",
        slug: "guide",
        title: "Guide",
        mdx: `# Guide\n\n![Screen](/api/assets/${hash})\n`,
        status: "published",
        isFaq: false,
        authorName: "OPAS",
        position: 0,
        assetHashes: [hash],
        canonicalUrl: "/guides/guide",
      },
    ],
    assets: [
      {
        sourcePaths: ["screen.png"],
        hash,
        mediaType: "image/png",
        byteSize: content.byteLength,
        content,
        canonicalUrl: `/api/assets/${hash}`,
      },
    ],
    redirects: [],
    report: {
      dryRun: { sourceFiles: 2, contentRoot: "", summaryPath: null },
      renames: [],
      conflicts: [],
      unknownFields: [],
      skippedContent: [],
      changes: [],
      completion: {
        status: "ready",
        categories: 1,
        articles: 1,
        assets: 1,
        redirects: 0,
      },
    },
  };
}

function repository(options: { failStage?: boolean; failActivation?: boolean } = {}) {
  const discarded: string[] = [];
  let activated: KnowledgeImport | null = null;
  const manifest: AssetManifest = {
    id: "asset_manifest_00000000-0000-4000-8000-000000000000",
    workspaceId: "workspace_demo",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  };

  return {
    state: {
      discarded,
      get activated() {
        return activated;
      },
    },
    adapter: {
      async cleanupExpiredAssets() {},
      async createAssetManifest() {
        return manifest;
      },
      async stageAsset(): Promise<Asset> {
        if (options.failStage) {
          throw new Error("stage failed");
        }
        return {
          workspaceId: manifest.workspaceId,
          hash,
          mediaType: "image/png",
          byteSize: content.byteLength,
          content,
          createdAt: now,
        };
      },
      async activateKnowledgeImport(value: KnowledgeImport) {
        if (options.failActivation) {
          throw new Error("activation failed");
        }
        activated = value;
      },
      async discardAssetManifest(_workspaceId: string, manifestId: string) {
        discarded.push(manifestId);
      },
    },
  };
}

test("maps one approved plan into a single staged atomic activation", async () => {
  const target = repository();
  let id = 0;

  await executeKnowledgeImport({
    repository: target.adapter,
    workspaceId: "workspace_demo",
    plan: plan(),
    now,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });

  assert.equal(target.state.discarded.length, 0);
  assert.equal(target.state.activated?.categories[0].slug, "guides");
  assert.equal(target.state.activated?.articles[0].categoryId, target.state.activated?.categories[0].id);
  assert.deepEqual(target.state.activated?.articles[0].assetHashes, [hash]);
  assert.equal(target.state.activated?.articles[0].publishedAt?.toISOString(), now.toISOString());
  assert.equal(target.state.activated?.articles[0].evidence?.categorySlug, "guides");
  assert.equal(
    target.state.activated?.articles[0].evidence?.job.availableAt.toISOString(),
    now.toISOString(),
  );
  assert.deepEqual(
    target.state.activated?.articles[0].evidence?.chunks.map(
      (chunk) => chunk.canonicalUrl,
    ),
    ["http://localhost:3000/guides/guide"],
  );
});

test("discards the manifest after either staging or atomic activation fails", async () => {
  for (const options of [{ failStage: true }, { failActivation: true }]) {
    const target = repository(options);
    await assert.rejects(
      executeKnowledgeImport({
        repository: target.adapter,
        workspaceId: "workspace_demo",
        plan: plan(),
        now,
      }),
    );
    assert.deepEqual(target.state.discarded, [
      "asset_manifest_00000000-0000-4000-8000-000000000000",
    ]);
  }
});

test("refuses a blocked plan before creating a manifest", async () => {
  const target = repository();
  const blocked = plan();
  blocked.ready = false;

  await assert.rejects(
    executeKnowledgeImport({
      repository: target.adapter,
      workspaceId: "workspace_demo",
      plan: blocked,
      now,
    }),
    ImportExecutionError,
  );
  assert.equal(target.state.activated, null);
  assert.equal(target.state.discarded.length, 0);
});

test("marks the activation report complete without mutating the approved plan", () => {
  const approved = plan();
  const completed = completedImportReport(approved.report);

  assert.equal(approved.report.completion.status, "ready");
  assert.equal(completed.completion.status, "complete");
  assert.deepEqual(
    { ...completed.completion, status: "ready" },
    approved.report.completion,
  );
});
