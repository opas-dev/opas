// ABOUTME: Verifies deterministic public metadata, structured data, and agent-readable text.
// ABOUTME: Guards publication safety independently of the active database deployment dialect.
import assert from "node:assert/strict";
import test from "node:test";

import {
  articleDescription,
  articleJsonLd,
  articleMarkdownBody,
  articleMetadata,
  articlePlainText,
  categoryMetadata,
  faqJsonLd,
  homeMetadata,
  joinPublishedArticles,
  llmsFullText,
  llmsText,
  normalizeArticleMarkdown,
  serializeJsonLd,
} from "@/content/publication";
import type { Article, Category, PublishedArticle } from "@/db/repository";
import {
  absoluteSiteUrl,
  publicArticleMarkdownPath,
  publicArticlePath,
  publicCategoryPath,
  resolveSiteOrigin,
} from "@/site";

const workspaceId = "workspace_test";
const siteUrl = "https://help.example.test";
const createdAt = new Date("2026-01-31T00:00:00.000Z");
const publishedAt = new Date("2026-02-01T00:00:00.000Z");
const updatedAt = new Date("2026-02-03T00:00:00.000Z");

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "category_accounts",
    workspaceId,
    slug: "account-guides",
    name: "Account guides",
    description: "Manage security and access.",
    position: 1,
    ...overrides,
  };
}

function publishedArticle(
  overrides: Partial<PublishedArticle> = {},
): PublishedArticle {
  return {
    id: "article_reset",
    workspaceId,
    categoryId: "category_accounts",
    slug: "reset-password",
    title: "How do I reset my password?",
    mdx: `# How do I reset my password?

Open **Settings** and choose Security.`,
    isFaq: true,
    authorName: "Ada Lovelace",
    position: 0,
    publishedAt,
    createdAt,
    updatedAt,
    ...overrides,
  };
}

function publication(
  article = publishedArticle(),
  articleCategory = category(),
) {
  const [result] = joinPublishedArticles({
    workspaceId,
    articles: [article],
    categories: [articleCategory],
  });
  assert.ok(result);
  return result;
}

test("validates the deployment origin and builds only safe public URLs", () => {
  assert.equal(resolveSiteOrigin(""), "http://localhost:3000");
  assert.equal(resolveSiteOrigin("  https://help.example.test/  "), siteUrl);
  assert.equal(resolveSiteOrigin("http://localhost:4173"), "http://localhost:4173");

  for (const invalid of [
    "not a URL",
    "ftp://help.example.test",
    "https://user:secret@help.example.test",
    "https://help.example.test/docs",
    "https://help.example.test/?preview=1",
    "https://help.example.test/#top",
  ]) {
    assert.throws(() => resolveSiteOrigin(invalid), /OPAS_SITE_URL/);
  }

  assert.equal(publicCategoryPath("account-guides"), "/account-guides");
  assert.equal(
    publicArticlePath("account-guides", "reset-password"),
    "/account-guides/reset-password",
  );
  assert.equal(
    publicArticleMarkdownPath("account-guides", "reset-password"),
    "/account-guides/reset-password.md",
  );
  assert.equal(publicCategoryPath("../admin"), null);
  assert.equal(publicArticlePath("account-guides", "Reset Password"), null);
  assert.equal(absoluteSiteUrl("/account-guides/reset-password", siteUrl), `${siteUrl}/account-guides/reset-password`);
  assert.equal(absoluteSiteUrl("/", siteUrl), `${siteUrl}/`);
  assert.throws(() => absoluteSiteUrl("//evil.example/path", siteUrl), /safe root-relative/);
  assert.throws(() => absoluteSiteUrl("/../admin", siteUrl), /safe root-relative/);
  assert.throws(() => absoluteSiteUrl("/%2e%2e/admin", siteUrl), /configured origin and path/);
});

test("normalizes article Markdown and derives plain, concise publication text", () => {
  const source =
    "\uFEFF  # How do I reset my password?\r\n\r\nOpen **Settings** and choose [Security](/security).  \r\n";

  assert.equal(
    normalizeArticleMarkdown(source),
    "# How do I reset my password?\n\nOpen **Settings** and choose [Security](/security).\n",
  );
  assert.equal(
    articleMarkdownBody(source, "How do I reset my password?"),
    "Open **Settings** and choose [Security](/security).",
  );
  assert.equal(
    articlePlainText(source, "How do I reset my password?"),
    "Open Settings and choose Security.",
  );
  assert.equal(
    articleDescription(source, "How do I reset my password?"),
    "Open Settings and choose Security.",
  );

  const longBody = `# Long answer\n\n${"Continue carefully through account security settings. ".repeat(8)}`;
  const description = articleDescription(longBody, "Long answer");
  assert.ok(description.length <= 180);
  assert.ok(description.endsWith("…"));
  assert.doesNotMatch(description, /[*#]/);
});

test("keeps GFM table semantics intact in article and aggregate Markdown exports", () => {
  const source = `# Support matrix

| Channel | Available |
| :-- | --: |
| Email | Yes |
| Phone | No |`;
  const tableArticle = publication(
    publishedArticle({
      title: "Support matrix",
      slug: "support-matrix",
      mdx: source,
      isFaq: false,
    }),
  );

  assert.equal(tableArticle.markdown, `${source}\n`);
  assert.equal(
    tableArticle.bodyMarkdown,
    `| Channel | Available |
| :-- | --: |
| Email | Yes |
| Phone | No |`,
  );
  assert.equal(tableArticle.plainText, "Channel Available Email Yes Phone No");
  assert.equal(
    llmsFullText([tableArticle], siteUrl),
    `# Support matrix
Source: ${siteUrl}/account-guides/support-matrix

| Channel | Available |
| :-- | --: |
| Email | Yes |
| Phone | No |
`,
  );
});

test("joins only published safe records from the requested workspace in stable order", () => {
  const billingCategory = category({
    id: "category_billing",
    slug: "billing",
    name: "Billing",
    position: 0,
  });
  const draft: Article = {
    ...publishedArticle({ id: "article_draft", slug: "draft-answer" }),
    status: "draft",
    contentHash: null,
  };
  const publications = joinPublishedArticles({
    workspaceId,
    categories: [
      category(),
      billingCategory,
      category({
        id: "category_foreign",
        workspaceId: "workspace_other",
        slug: "foreign",
      }),
    ],
    articles: [
      publishedArticle({ position: 5 }),
      publishedArticle({
        id: "article_account_first",
        slug: "account-first",
        title: "Account first",
        mdx: "# Account first\n\nOrdered before the reset article.",
        position: 1,
      }),
      publishedArticle({
        id: "article_billing",
        categoryId: billingCategory.id,
        slug: "read-an-invoice",
        title: "Read an invoice",
        mdx: "# Read an invoice\n\nFind totals below the line items.",
        isFaq: false,
      }),
      draft,
      publishedArticle({ id: "article_unsafe", slug: "../admin" }),
      publishedArticle({ id: "article_orphan", categoryId: "category_missing" }),
      publishedArticle({
        id: "article_foreign",
        workspaceId: "workspace_other",
        categoryId: "category_foreign",
      }),
    ],
  });

  assert.deepEqual(
    publications.map(({ article, path, markdownPath }) => ({
      id: article.id,
      path,
      markdownPath,
    })),
    [
      {
        id: "article_billing",
        path: "/billing/read-an-invoice",
        markdownPath: "/billing/read-an-invoice.md",
      },
      {
        id: "article_account_first",
        path: "/account-guides/account-first",
        markdownPath: "/account-guides/account-first.md",
      },
      {
        id: "article_reset",
        path: "/account-guides/reset-password",
        markdownPath: "/account-guides/reset-password.md",
      },
    ],
  );
});

test("projects canonical metadata and complete Article and FAQPage JSON-LD", () => {
  const publicArticle = publication();

  assert.deepEqual(homeMetadata(siteUrl), {
    title: "OPAS Help Center",
    description: "A help center you can theme, deploy, and own.",
    alternates: { canonical: `${siteUrl}/` },
  });
  assert.deepEqual(categoryMetadata(category(), siteUrl), {
    title: "Account guides",
    description: "Manage security and access.",
    alternates: { canonical: `${siteUrl}/account-guides` },
  });
  assert.deepEqual(articleMetadata(publicArticle, siteUrl), {
    title: "How do I reset my password?",
    description: "Open Settings and choose Security.",
    alternates: { canonical: `${siteUrl}/account-guides/reset-password` },
  });
  assert.deepEqual(articleJsonLd(publicArticle, siteUrl), {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "How do I reset my password?",
    datePublished: "2026-02-01T00:00:00.000Z",
    dateModified: "2026-02-03T00:00:00.000Z",
    author: { "@type": "Person", name: "Ada Lovelace" },
    publisher: { "@type": "Organization", name: "OPAS" },
    mainEntityOfPage: `${siteUrl}/account-guides/reset-password`,
  });
  assert.deepEqual(faqJsonLd(publicArticle), {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How do I reset my password?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Open Settings and choose Security.",
        },
      },
    ],
  });

  const noPublishedDate = publication(publishedArticle({ publishedAt: null }));
  assert.equal(
    articleJsonLd(noPublishedDate, siteUrl).datePublished,
    "2026-01-31T00:00:00.000Z",
  );
  const regularArticle = publication(publishedArticle({ isFaq: false }));
  assert.equal(faqJsonLd(regularArticle), null);
});

test("serializes JSON-LD without permitting a closing script tag", () => {
  const dangerous = "</script><script>alert(1)</script>";
  const serialized = serializeJsonLd({ headline: dangerous });

  assert.doesNotMatch(serialized, /</u);
  assert.match(serialized, /\\u003c\/script>/u);
  assert.deepEqual(JSON.parse(serialized), { headline: dangerous });
});

test("generates deterministic llms index and full-content documents", () => {
  const accountPublication = publication();
  const billingCategory = category({
    id: "category_billing",
    slug: "billing",
    name: "Billing",
    description: "Understand invoices.",
    position: 0,
  });
  const billingPublication = publication(
    publishedArticle({
      id: "article_billing",
      categoryId: billingCategory.id,
      slug: "read-an-invoice",
      title: "Read an invoice",
      mdx: "# Read an invoice\n\nFind **totals** below the line items.",
      isFaq: false,
    }),
    billingCategory,
  );
  const reverseOrder = [accountPublication, billingPublication];

  assert.equal(
    llmsText(reverseOrder, siteUrl),
    `# OPAS Help Center

> A help center you can theme, deploy, and own.

## Billing

- [Read an invoice](${siteUrl}/billing/read-an-invoice.md): Find totals below the line items.

## Account guides

- [How do I reset my password?](${siteUrl}/account-guides/reset-password.md): Open Settings and choose Security.
`,
  );
  assert.equal(
    llmsFullText(reverseOrder, siteUrl),
    `# Read an invoice
Source: ${siteUrl}/billing/read-an-invoice

Find **totals** below the line items.

# How do I reset my password?
Source: ${siteUrl}/account-guides/reset-password

Open **Settings** and choose Security.
`,
  );
  assert.equal(
    llmsText([], siteUrl),
    "# OPAS Help Center\n\n> A help center you can theme, deploy, and own.\n",
  );
  assert.equal(llmsFullText([], siteUrl), "");
});
