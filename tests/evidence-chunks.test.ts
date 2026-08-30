// ABOUTME: Verifies deterministic heading-aware evidence chunks from safe published Markdown.
// ABOUTME: Locks source ranges, Unicode-safe boundaries, stable identities, and embedding limits.
import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkPublishedArticle,
  evidenceEmbeddingMaximumUtf8Bytes,
  EvidenceChunkingError,
  type PublishedEvidenceArticle,
} from "@/content/evidence-chunks";
import {
  prepareArticleEvidence,
  publishedArticleContentHash,
} from "@/content/article-evidence";
import { ArticleMdxValidationError } from "@/content/mdx-safety";
import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

const encoder = new TextEncoder();

type MarkdownNode = {
  children?: MarkdownNode[];
  type: string;
  url?: string;
  value?: string;
};

function markdownNodes(markdown: string, type: string) {
  const matches: MarkdownNode[] = [];

  function visit(node: MarkdownNode) {
    if (node.type === type) {
      matches.push(node);
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(parseArticleMarkdown(markdown) as MarkdownNode);
  return matches;
}

function markdownNodeText(node: MarkdownNode): string {
  if (typeof node.value === "string") {
    return node.value;
  }

  return (node.children ?? []).map(markdownNodeText).join(" ").trim();
}

function article(
  overrides: Partial<PublishedEvidenceArticle> = {},
): PublishedEvidenceArticle {
  return {
    id: "article_reset",
    workspaceId: "workspace_test",
    title: "Reset your password",
    status: "published",
    canonicalUrl: "https://opas.dev/account/reset-your-password",
    mdx: `# Reset your password

Use the recovery flow.
`,
    ...overrides,
  };
}

test("prepares one deterministic published revision and provider-free pending job", async () => {
  const availableAt = new Date("2026-08-30T12:00:00.000Z");
  const savedArticle = {
    id: "article_reset",
    workspaceId: "workspace_test",
    categoryId: "category_account",
    slug: "reset-your-password",
    title: "Reset your password",
    mdx: "# Reset your password\n\nUse the recovery flow.\n",
    status: "published" as const,
    isFaq: false,
    authorName: "OPAS",
    publishedAt: availableAt,
  };
  const prepared = await prepareArticleEvidence(savedArticle, "account", {
    availableAt,
    configuredSiteUrl: "https://opas.dev",
    createId: () => "00000000-0000-4000-8000-000000000001",
  });

  assert.ok(prepared);
  assert.equal(prepared.categorySlug, "account");
  assert.equal(prepared.job.embeddingGenerationId, null);
  assert.equal(prepared.job.availableAt, availableAt);
  assert.equal(
    prepared.articleContentHash,
    await publishedArticleContentHash(savedArticle, "/account/reset-your-password"),
  );
  assert.deepEqual(
    prepared.chunks.map((chunk) => chunk.canonicalUrl),
    ["https://opas.dev/account/reset-your-password"],
  );
  assert.ok(
    prepared.chunks.every((chunk) =>
      /^[a-f0-9]{64}$/u.test(chunk.embeddingInputHash),
    ),
  );

  const moved = await prepareArticleEvidence(savedArticle, "security", {
    availableAt,
    configuredSiteUrl: "https://opas.dev",
  });
  assert.ok(moved);
  assert.notEqual(moved.articleContentHash, prepared.articleContentHash);
});

test("drafts prepare no evidence or embedding job", async () => {
  const prepared = await prepareArticleEvidence(
    {
      id: "article_draft",
      workspaceId: "workspace_test",
      categoryId: "category_account",
      slug: "draft",
      title: "Draft",
      mdx: "# Draft",
      status: "draft",
      isFaq: false,
      authorName: "OPAS",
      publishedAt: null,
    },
    "account",
  );

  assert.equal(prepared, null);
});

test("tracks heading paths, canonical metadata, Markdown, and source lines", async () => {
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

Start with account settings.

## Recovery

Request a recovery link.

### Expired links

Request another link.

## Contact support

Include the account email.
`,
    }),
  );

  assert.deepEqual(
    chunks.map((chunk) => ({
      ordinal: chunk.ordinal,
      headingPath: chunk.headingPath,
      sourceLineRange: chunk.sourceLineRange,
    })),
    [
      { ordinal: 0, headingPath: [], sourceLineRange: { start: 3, end: 3 } },
      {
        ordinal: 1,
        headingPath: ["Recovery"],
        sourceLineRange: { start: 5, end: 7 },
      },
      {
        ordinal: 2,
        headingPath: ["Recovery", "Expired links"],
        sourceLineRange: { start: 9, end: 11 },
      },
      {
        ordinal: 3,
        headingPath: ["Contact support"],
        sourceLineRange: { start: 13, end: 15 },
      },
    ],
  );
  assert.equal(chunks[1]?.markdown, "## Recovery\n\nRequest a recovery link.");
  assert.equal(chunks[1]?.evidenceText, "Recovery\nRequest a recovery link.");
  assert.equal(
    chunks[1]?.canonicalUrl,
    "https://opas.dev/account/reset-your-password",
  );
  assert.equal(chunks[1]?.workspaceId, "workspace_test");
  assert.equal(chunks[1]?.articleId, "article_reset");
  assert.equal(chunks[1]?.title, "Reset your password");
  assert.match(chunks[1]?.id ?? "", /^[a-f0-9]{64}$/u);
  assert.match(chunks[1]?.contentHash ?? "", /^[a-f0-9]{64}$/u);
});

test("preserves tables, lists, and fenced code as plain evidence", async () => {
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Recovery channels

| Channel | Available |
| --- | --- |
| Email | Yes |
| Phone | No |

- Open settings
- Choose Security

\`\`\`ts
const canRecover = true;
\`\`\`
`,
    }),
  );
  const markdown = chunks.map((chunk) => chunk.markdown).join("\n");
  const plainText = chunks.map((chunk) => chunk.evidenceText).join("\n");

  assert.match(markdown, /\| Channel \| Available \|/u);
  assert.match(markdown, /- Choose Security/u);
  assert.match(markdown, /```ts/u);
  assert.match(plainText, /Channel \| Available\nEmail \| Yes\nPhone \| No/u);
  assert.match(plainText, /Open settings\nChoose Security/u);
  assert.match(plainText, /const canRecover = true;/u);
});

test("splits oversized fenced code into complete deterministic fences", async () => {
  const codeLines = Array.from(
    { length: 32 },
    (_, index) => `const recoveryStep${index} = "step-${index}";`,
  );
  const input = article({
    mdx: `# Reset your password

## Recovery script

\`\`\`ts
${codeLines.join("\n")}
\`\`\`
`,
  });
  const first = await chunkPublishedArticle(input);
  const second = await chunkPublishedArticle(input);
  const codeChunks = first.filter(
    (chunk) => chunk.headingPath[0] === "Recovery script",
  );

  assert.deepEqual(second, first);
  assert.ok(codeChunks.length > 1);
  assert.deepEqual(
    codeChunks.flatMap((chunk) => {
      const nodes = markdownNodes(chunk.markdown, "code");
      assert.equal(nodes.length, 1);
      return (nodes[0]?.value ?? "").split("\n");
    }),
    codeLines,
  );
  assert.ok(codeChunks.every((chunk) => /```ts\n[\s\S]+\n```$/u.test(chunk.markdown)));
});

test("splits oversized tables by rows while keeping each fragment a table", async () => {
  const rows = Array.from(
    { length: 24 },
    (_, index) => `| ${index} | Recovery step ${index} |`,
  );
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Recovery matrix

| Order | Action |
| ---: | --- |
${rows.join("\n")}
`,
    }),
  );
  const tableChunks = chunks.filter(
    (chunk) => chunk.headingPath[0] === "Recovery matrix",
  );

  assert.ok(tableChunks.length > 1);
  assert.ok(
    tableChunks.every((chunk) => markdownNodes(chunk.markdown, "table").length === 1),
  );
  assert.deepEqual(
    tableChunks.flatMap((chunk) =>
      markdownNodes(chunk.markdown, "table").flatMap((table) =>
        (table.children ?? []).slice(1).map(markdownNodeText),
      ),
    ),
    Array.from(
      { length: rows.length },
      (_, index) => `${index} Recovery step ${index}`,
    ),
  );
});

test("splits oversized lists between complete list items", async () => {
  const items = Array.from(
    { length: 32 },
    (_, index) => `- Complete recovery action ${index}`,
  );
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Recovery checklist

${items.join("\n")}
`,
    }),
  );
  const listChunks = chunks.filter(
    (chunk) => chunk.headingPath[0] === "Recovery checklist",
  );

  assert.ok(listChunks.length > 1);
  assert.ok(
    listChunks.every((chunk) => markdownNodes(chunk.markdown, "list").length === 1),
  );
  assert.deepEqual(
    listChunks.flatMap((chunk) =>
      markdownNodes(chunk.markdown, "listItem").map(markdownNodeText),
    ),
    Array.from(
      { length: items.length },
      (_, index) => `Complete recovery action ${index}`,
    ),
  );
});

test("keeps an oversized link atomic while splitting adjacent links", async () => {
  const longLabel = "International account recovery route ".repeat(10).trim();
  const longUrl = `https://opas.dev/recovery/${"international/".repeat(12)}start`;
  const links = [
    `[${longLabel}](${longUrl})`,
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `[Recovery route ${index}](https://opas.dev/recovery/routes/${index})`,
    ),
  ];
  const input = article({
    mdx: `# Reset your password

## Recovery routes

${links.join(" ")}
`,
  });
  const chunks = await chunkPublishedArticle(input);
  const linkChunks = chunks.filter(
    (chunk) => chunk.headingPath[0] === "Recovery routes",
  );
  const linkNodes = linkChunks.flatMap((chunk) =>
    markdownNodes(chunk.markdown, "link"),
  );

  assert.ok(linkChunks.length > 1);
  assert.equal(linkNodes.length, links.length);
  assert.deepEqual(
    linkNodes.map((node) => node.url),
    [
      longUrl,
      ...Array.from(
        { length: links.length - 1 },
        (_, index) => `https://opas.dev/recovery/routes/${index}`,
      ),
    ],
  );
  assert.equal(markdownNodeText(linkNodes[0] as MarkdownNode), longLabel);
  assert.ok(linkNodes.every((node) => node.children?.length === 1));
});

test("splits at blocks, then sentences and words without exceeding the embedding bound", async () => {
  const firstBlock = "Alpha guidance ".repeat(10).trim();
  const secondBlock = "Beta guidance ".repeat(10).trim();
  const sentences = "Use the international recovery option. ".repeat(20).trim();
  const words = "naïve ".repeat(100).trim();
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Blocks

${firstBlock}

${secondBlock}

## Sentences

${sentences}

## Words

${words}
`,
    }),
  );

  for (const chunk of chunks) {
    assert.ok(
      encoder.encode(chunk.embeddingText).byteLength <=
        evidenceEmbeddingMaximumUtf8Bytes,
    );
    assert.doesNotMatch(chunk.markdown, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.doesNotMatch(chunk.markdown, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }

  const blockChunks = chunks.filter((chunk) => chunk.headingPath[0] === "Blocks");
  assert.ok(blockChunks.length >= 2);
  assert.ok(blockChunks.every((chunk) => !(/Alpha/u.test(chunk.markdown) && /Beta/u.test(chunk.markdown))));

  const sentenceChunks = chunks.filter(
    (chunk) => chunk.headingPath[0] === "Sentences",
  );
  assert.ok(sentenceChunks.length > 1);
  assert.ok(
    sentenceChunks.slice(0, -1).every((chunk) => chunk.markdown.endsWith(".")),
  );

  const wordEvidence = chunks
    .filter((chunk) => chunk.headingPath[0] === "Words")
    .flatMap((chunk) => chunk.evidenceText.split(/\s+/u))
    .filter((word) => word !== "Words");
  assert.equal(wordEvidence.length, 100);
  assert.ok(wordEvidence.every((word) => word === "naïve"));
});

test("hard boundaries keep astral Unicode code points intact", async () => {
  const chunks = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Compass

${"🧭".repeat(100)}
`,
    }),
  );
  const evidence = chunks
    .map((chunk) => chunk.evidenceText)
    .join("")
    .replace("Compass", "")
    .replace(/\s/gu, "");

  assert.equal(Array.from(evidence).length, 100);
  assert.equal(evidence, "🧭".repeat(100));
});

test("retains an unchanged section ID when an unrelated section moves its source lines", async () => {
  const before = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Alpha

Short alpha answer.

## Beta

Stable beta answer.
`,
    }),
  );
  const after = await chunkPublishedArticle(
    article({
      mdx: `# Reset your password

## Alpha

Changed alpha answer.

This additional paragraph moves later source lines.

## Beta

Stable beta answer.
`,
    }),
  );
  const beforeBeta = before.find((chunk) => chunk.headingPath[0] === "Beta");
  const afterBeta = after.find((chunk) => chunk.headingPath[0] === "Beta");

  assert.ok(beforeBeta);
  assert.ok(afterBeta);
  assert.equal(afterBeta.id, beforeBeta.id);
  assert.equal(afterBeta.contentHash, beforeBeta.contentHash);
  assert.notDeepEqual(afterBeta.sourceLineRange, beforeBeta.sourceLineRange);
});

test("keeps duplicate chunks distinct while producing deterministic output", async () => {
  const input = article({
    mdx: `# Reset your password

## Repeat

Use the same answer.

## Repeat

Use the same answer.
`,
  });
  const first = await chunkPublishedArticle(input);
  const second = await chunkPublishedArticle(input);

  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.notEqual(first[0]?.id, first[1]?.id);
  assert.equal(first[0]?.contentHash, first[1]?.contentHash);
});

test("rejects drafts, executable MDX, title mismatches, and unsafe canonical URLs", async () => {
  await assert.rejects(
    chunkPublishedArticle(article({ status: "draft" })),
    (error: unknown) => {
      assert.ok(error instanceof EvidenceChunkingError);
      assert.match(error.message, /Only published articles/u);
      return true;
    },
  );
  await assert.rejects(
    chunkPublishedArticle(
      article({ mdx: "# Reset your password\n\n{globalThis.process}" }),
    ),
    ArticleMdxValidationError,
  );
  await assert.rejects(
    chunkPublishedArticle(article({ mdx: "# Another title\n\nAnswer." })),
    ArticleMdxValidationError,
  );
  await assert.rejects(
    chunkPublishedArticle(article({ canonicalUrl: "javascript:alert(1)" })),
    EvidenceChunkingError,
  );
});
