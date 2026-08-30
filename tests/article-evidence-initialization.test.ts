// ABOUTME: Verifies bounded provider-independent initialization of missing published evidence.
// ABOUTME: Ensures repeated batches converge without exposing article content in summaries.
import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeAllMissingArticleEvidence,
  initializeMissingArticleEvidence,
} from "@/content/article-evidence-initialization";
import type {
  ArticleEvidenceInitialization,
  UnindexedPublishedArticle,
} from "@/db/repository";

const initializedAt = new Date("2026-08-30T12:00:00.000Z");

function article(id: string, position: number): UnindexedPublishedArticle {
  return {
    id,
    workspaceId: "workspace_initialization",
    categoryId: "category_initialization",
    categorySlug: "guides",
    slug: `article-${position}`,
    title: `Article ${position}`,
    mdx: `# Article ${position}\n\nPrivate source body ${position}.`,
    status: "published",
    isFaq: false,
    authorName: "OPAS",
    position,
    publishedAt: initializedAt,
  };
}

test("missing evidence initialization is bounded and converges", async () => {
  const pending = Array.from({ length: 25 }, (_, index) =>
    article(`article_${index}`, index),
  );
  const committedIds: string[] = [];
  let observedLimit = 0;
  let idSequence = 0;
  const repository = {
    async listUnindexedPublishedArticles(_workspaceId: string, limit: number) {
      observedLimit = limit;
      return pending.slice(0, limit);
    },
    async initializeArticleEvidence(
      initialization: ArticleEvidenceInitialization,
    ) {
      assert.match(initialization.evidence.articleContentHash, /^[a-f0-9]{64}$/u);
      assert.ok(initialization.evidence.chunks.length > 0);
      committedIds.push(initialization.article.id);
      pending.splice(
        pending.findIndex((candidate) => candidate.id === initialization.article.id),
        1,
      );
      return true;
    },
  };

  const first = await initializeMissingArticleEvidence({
    configuredSiteUrl: "https://docs.example.test",
    createId: () => `initialization_${idSequence++}`,
    initializedAt,
    limit: 1,
    repository,
    workspaceId: "workspace_initialization",
  });
  assert.deepEqual(first, {
    examinedArticleCount: 1,
    initializedArticleCount: 1,
  });
  assert.equal(observedLimit, 1);

  const second = await initializeAllMissingArticleEvidence({
    configuredSiteUrl: "https://docs.example.test",
    createId: () => `initialization_${idSequence++}`,
    initializedAt,
    repository,
    workspaceId: "workspace_initialization",
  });
  assert.deepEqual(second, {
    examinedArticleCount: 24,
    initializedArticleCount: 24,
  });
  assert.equal(committedIds.length, 25);
  assert.deepEqual(committedIds, Array.from({ length: 25 }, (_, index) => `article_${index}`));

  assert.deepEqual(
    await initializeMissingArticleEvidence({
      configuredSiteUrl: "https://docs.example.test",
      initializedAt,
      repository,
      workspaceId: "workspace_initialization",
    }),
    { examinedArticleCount: 0, initializedArticleCount: 0 },
  );
});
