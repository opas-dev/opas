// ABOUTME: Verifies named-member plan mapping and manifest cleanup around atomic imports.
// ABOUTME: Keeps private revision attribution and activation failures deterministic.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Asset, AssetManifest } from "@/db/repository";
import type { KnowledgeImport } from "@/db/knowledge-import";
import { AuthoringPausedError } from "@/db/authoring-controls";
import {
  executeKnowledgeImport,
  ImportExecutionConflictError,
  ImportExecutionError,
} from "@/import/execute";
import type { KnowledgeImportPlan } from "@/import/planner";
import { completedImportReport } from "@/import/report";

const now = new Date("2026-08-30T09:00:00.000Z");
const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hash = createHash("sha256").update(content).digest("hex");
const actor = {
  memberId: "member_import_editor",
  sessionId: "S".repeat(43),
  workspaceId: "workspace_demo",
};

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

function repository(
  options: {
    activationConflict?: boolean;
    failStage?: boolean;
    failActivation?: boolean;
  } = {},
) {
  const discarded: string[] = [];
  let cleaned = 0;
  let manifests = 0;
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
      get cleaned() {
        return cleaned;
      },
      get manifests() {
        return manifests;
      },
      get activated() {
        return activated;
      },
    },
    adapter: {
      async cleanupAuthorizedExpiredAssets() {
        cleaned += 1;
      },
      async createAuthorizedAssetManifest() {
        manifests += 1;
        return manifest;
      },
      async stageAuthorizedAsset(): Promise<Asset> {
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
        if (options.activationConflict) {
          return { status: "conflict" as const, code: "ARTICLE_CONFLICT" as const };
        }
        activated = value;
        return { status: "activated" as const };
      },
      async discardAuthorizedAssetManifest(
        _request: typeof actor & { checkedAt: Date },
        manifestId: string,
      ) {
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
    actor,
    plan: plan(),
    clock: () => now,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });

  assert.equal(target.state.discarded.length, 0);
  assert.equal(target.state.activated?.categories[0].slug, "guides");
  assert.deepEqual(target.state.activated?.actor, actor);
  assert.equal(target.state.activated?.articles[0].categoryId, target.state.activated?.categories[0].id);
  assert.deepEqual(target.state.activated?.articles[0].assetHashes, [hash]);
  assert.equal(target.state.activated?.articles[0].categorySlug, "guides");
  assert.equal(target.state.activated?.articles[0].categoryName, "Guides");
  assert.equal(target.state.activated?.articles[0].revisionId.includes("revision_"), true);
  assert.match(target.state.activated?.articles[0].revisionHash ?? "", /^[a-f\d]{64}$/u);
  assert.equal("status" in target.state.activated!.articles[0], false);
  assert.equal("evidence" in target.state.activated!.articles[0], false);
});

test("discards the manifest after either staging or atomic activation fails", async () => {
  for (const options of [{ failStage: true }, { failActivation: true }]) {
    const target = repository(options);
    await assert.rejects(
      executeKnowledgeImport({
        repository: target.adapter,
        actor,
        plan: plan(),
        clock: () => now,
      }),
    );
    assert.deepEqual(target.state.discarded, [
      "asset_manifest_00000000-0000-4000-8000-000000000000",
    ]);
  }
});

test("preserves a paused stage failure without letting cleanup mask it", async () => {
  const target = repository();
  let cleanupCalls = 0;
  target.adapter.stageAuthorizedAsset = async () => {
    throw new AuthoringPausedError();
  };
  target.adapter.discardAuthorizedAssetManifest = async () => {
    cleanupCalls += 1;
    throw new Error("cleanup failed");
  };

  await assert.rejects(
    executeKnowledgeImport({
      repository: target.adapter,
      actor,
      plan: plan(),
      clock: () => now,
    }),
    (error: unknown) =>
      error instanceof AuthoringPausedError && error.code === "AUTHORING_PAUSED",
  );
  assert.equal(cleanupCalls, 0);

  const cleanupTarget = repository({ failStage: true });
  cleanupTarget.adapter.discardAuthorizedAssetManifest = async () => {
    cleanupCalls += 1;
    throw new AuthoringPausedError();
  };
  await assert.rejects(
    executeKnowledgeImport({
      repository: cleanupTarget.adapter,
      actor,
      plan: plan(),
      clock: () => now,
    }),
    (error: unknown) =>
      error instanceof AuthoringPausedError && error.code === "AUTHORING_PAUSED",
  );
  assert.equal(cleanupCalls, 1);
});

test("refuses a blocked plan before creating a manifest", async () => {
  const target = repository();
  const blocked = plan();
  blocked.ready = false;

  await assert.rejects(
    executeKnowledgeImport({
      repository: target.adapter,
      actor,
      plan: blocked,
      clock: () => now,
    }),
    ImportExecutionError,
  );
  assert.equal(target.state.activated, null);
  assert.equal(target.state.discarded.length, 0);
});

test("rejects empty, oversized, unused-category, and inconsistent-asset plans before writes", async () => {
  const base = plan();
  const invalidPlans: KnowledgeImportPlan[] = [
    { ...base, categories: [] },
    { ...base, articles: [] },
    {
      ...base,
      categories: [...base.categories, { name: "Unused", slug: "unused", position: 1 }],
    },
    {
      ...base,
      articles: Array.from({ length: 101 }, (_, index) => ({
        ...base.articles[0],
        sourcePath: `article-${index}.md`,
        slug: `article-${index}`,
      })),
    },
    {
      ...base,
      assets: [...base.assets, base.assets[0]],
    },
    {
      ...base,
      articles: [{ ...base.articles[0], assetHashes: [] }],
    },
  ];

  for (const invalidPlan of invalidPlans) {
    const target = repository();
    await assert.rejects(
      executeKnowledgeImport({
        repository: target.adapter,
        actor,
        plan: invalidPlan,
        clock: () => now,
      }),
    );
    assert.equal(target.state.cleaned, 0);
    assert.equal(target.state.manifests, 0);
    assert.equal(target.state.activated, null);
  }
});

test("surfaces typed create-only activation conflicts after authorized cleanup", async () => {
  const target = repository({ activationConflict: true });

  await assert.rejects(
    executeKnowledgeImport({
      repository: target.adapter,
      actor,
      plan: plan(),
      clock: () => now,
    }),
    (error: unknown) =>
      error instanceof ImportExecutionConflictError &&
      error.code === "ARTICLE_CONFLICT",
  );
  assert.deepEqual(target.state.discarded, [
    "asset_manifest_00000000-0000-4000-8000-000000000000",
  ]);
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
