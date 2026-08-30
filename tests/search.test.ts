// ABOUTME: Verifies published article search, result shaping, and snapshot-aware index rebuilding.
// ABOUTME: Guards Orama matching across titles, bodies, categories, and one-character typos.
import assert from "node:assert/strict";
import test from "node:test";

import type { Article, Category, PublishedArticle } from "@/db/repository";
import { searchPublishedArticles } from "@/search/articles";
import {
  constrainSearchInput,
  maximumSearchQueryLength,
  normalizeSearchQuery,
  searchQueryLength,
} from "@/search/query";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

test("normalizes and bounds queries by Unicode code point", () => {
  assert.equal(normalizeSearchQuery("  Runtıme\n\tMDX  "), "Runtıme MDX");
  assert.equal(searchQueryLength("🔎"), 1);
  assert.equal(
    searchQueryLength(constrainSearchInput("🔎".repeat(maximumSearchQueryLength + 1))),
    maximumSearchQueryLength,
  );
  assert.equal(
    searchQueryLength(constrainSearchInput("ﬃ".repeat(maximumSearchQueryLength))),
    maximumSearchQueryLength,
  );
  assert.equal(constrainSearchInput("  runtime   MDX "), "runtime MDX ");
});

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "category_guides",
    workspaceId: "workspace_test",
    slug: "account-guides",
    name: "Account guides",
    description: null,
    position: 0,
    ...overrides,
  };
}

function publishedArticle(
  overrides: Partial<PublishedArticle> = {},
): PublishedArticle {
  return {
    id: "article_password",
    workspaceId: "workspace_test",
    categoryId: "category_guides",
    slug: "reset-your-password",
    title: "Reset your password",
    mdx: `# Reset your password

Open account settings and choose **Security**. Follow the recovery link to continue.`,
    isFaq: false,
    authorName: "OPAS",
    position: 0,
    publishedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

test("searches published article titles, bodies, and category names", async () => {
  const articles = [publishedArticle()];
  const categories = [category()];

  for (const query of ["password", "recovery", "account guides"]) {
    const results = await searchPublishedArticles({ articles, categories, query });
    assert.equal(results.length, 1, query);
    assert.equal(results[0]?.articleId, "article_password");
  }
});

test("allows one-character typos but returns no unrelated results", async () => {
  const request = {
    articles: [publishedArticle()],
    categories: [category()],
  };

  assert.equal(
    (await searchPublishedArticles({ ...request, query: "pasword" }))[0]?.articleId,
    "article_password",
  );
  assert.deepEqual(
    await searchPublishedArticles({ ...request, query: "billing" }),
    [],
  );
  assert.deepEqual(
    await searchPublishedArticles({ ...request, query: "   " }),
    [],
  );
});

test("honors the result limit deterministically", async () => {
  const articles = [
    publishedArticle({ id: "article_a", slug: "security-a", title: "Security alpha" }),
    publishedArticle({ id: "article_b", slug: "security-b", title: "Security beta" }),
    publishedArticle({ id: "article_c", slug: "security-c", title: "Security gamma" }),
  ];

  const results = await searchPublishedArticles({
    articles,
    categories: [category()],
    query: "security",
    limit: 2,
  });

  assert.equal(results.length, 2);
});

test("returns safe public hrefs and concise plain-text excerpts", async () => {
  const results = await searchPublishedArticles({
    articles: [
      publishedArticle({
        mdx: `# Reset your password

Choose **Security**, then use [the recovery form](/recover). ${"Continue carefully. ".repeat(20)}`,
      }),
    ],
    categories: [category()],
    query: "recovery",
  });

  assert.deepEqual(
    {
      articleId: results[0]?.articleId,
      title: results[0]?.title,
      categoryName: results[0]?.categoryName,
      href: results[0]?.href,
    },
    {
      articleId: "article_password",
      title: "Reset your password",
      categoryName: "Account guides",
      href: "/account-guides/reset-your-password",
    },
  );
  assert.ok(results[0]?.excerpt.startsWith("Choose Security, then use the recovery form."));
  assert.ok(results[0]?.excerpt.endsWith("…"));
  assert.ok((results[0]?.excerpt.length ?? 0) <= 180);
  assert.doesNotMatch(results[0]?.excerpt ?? "", /[#*\[\]()]/);

  const unsafeRoute = await searchPublishedArticles({
    articles: [publishedArticle({ slug: "../admin" })],
    categories: [category()],
    query: "password",
  });
  assert.deepEqual(unsafeRoute, []);
});

test("excludes drafts and rebuilds when a publication snapshot changes", async () => {
  const draft: Article = {
    ...publishedArticle({
      id: "article_publish_change",
      slug: "publication-change",
      title: "Publication canary",
    }),
    status: "draft",
    contentHash: null,
    publishedAt: null,
  };
  const categories = [category()];

  assert.deepEqual(
    await searchPublishedArticles({ articles: [draft], categories, query: "canary" }),
    [],
  );

  const published: Article = {
    ...draft,
    status: "published",
    publishedAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
  assert.equal(
    (await searchPublishedArticles({ articles: [published], categories, query: "canary" }))[0]
      ?.articleId,
    "article_publish_change",
  );
});

test("rebuilds the cached index after article and category updates", async () => {
  const initialArticle = publishedArticle({
    id: "article_update",
    slug: "content-update",
    title: "Original answer",
    mdx: "# Original answer\n\nThe original body discusses apricots.",
  });
  const initialCategory = category({ name: "Original category" });

  assert.equal(
    (
      await searchPublishedArticles({
        articles: [initialArticle],
        categories: [initialCategory],
        query: "apricots",
      })
    )[0]?.articleId,
    "article_update",
  );

  const updatedArticle = publishedArticle({
    ...initialArticle,
    title: "Updated answer",
    mdx: "# Updated answer\n\nThe revised body discusses nectarines.",
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  });
  const updatedCategory = category({ ...initialCategory, name: "Orchard handbook" });

  assert.equal(
    (
      await searchPublishedArticles({
        articles: [updatedArticle],
        categories: [updatedCategory],
        query: "nectarines",
      })
    )[0]?.articleId,
    "article_update",
  );
  assert.equal(
    (
      await searchPublishedArticles({
        articles: [updatedArticle],
        categories: [updatedCategory],
        query: "orchard",
      })
    )[0]?.categoryName,
    "Orchard handbook",
  );
  assert.deepEqual(
    await searchPublishedArticles({
      articles: [updatedArticle],
      categories: [updatedCategory],
      query: "apricots",
    }),
    [],
  );
});
