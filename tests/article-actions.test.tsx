// ABOUTME: Verifies article actions copy canonical Markdown and expose safe AI targets.
// ABOUTME: Keeps external prompts encoded, fixed-host, and limited to published URLs.
import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  ArticleActions,
  articleActionTargets,
  copyArticlePage,
} from "@/app/[categorySlug]/[articleSlug]/article-actions";

const pageUrl = "https://docs.example.test/guides/reset-password";
const markdownUrl = `${pageUrl}.md`;
const markdown = "# Reset password\n\nUse the published recovery flow.\n";

test("article action targets encode a fixed prompt containing only the public Markdown URL", () => {
  const targets = articleActionTargets(pageUrl, markdownUrl);
  assert.equal(targets.page, pageUrl);
  assert.equal(targets.markdown, markdownUrl);
  assert.equal(new URL(targets.chatGpt).origin, "https://chatgpt.com");
  assert.equal(new URL(targets.claude).origin, "https://claude.ai");
  assert.equal(new URL(targets.chatGpt).searchParams.get("q"), targets.prompt);
  assert.equal(new URL(targets.claude).searchParams.get("q"), targets.prompt);
  assert.ok(targets.prompt.endsWith(markdownUrl));
  assert.doesNotMatch(targets.prompt, /Runtime MDX|unpublished body/u);
  assert.doesNotMatch(
    JSON.stringify(targets),
    /unpublished body|customer@example\.test/u,
  );
});

test("article action targets reject noncanonical and cross-origin Markdown URLs", () => {
  assert.throws(
    () => articleActionTargets(`${pageUrl}?draft=true`, markdownUrl),
    /canonical public article URL/u,
  );
  assert.throws(
    () => articleActionTargets(pageUrl, "https://foreign.example/reset-password.md"),
    /canonical Markdown URL/u,
  );
  assert.throws(
    () => articleActionTargets(pageUrl, `${pageUrl}/extra.md`),
    /canonical Markdown URL/u,
  );
});

test("Copy page writes exactly the published Markdown", async () => {
  const writes: string[] = [];
  await copyArticlePage(async (value) => {
    writes.push(value);
  }, markdown);
  assert.deepEqual(writes, [markdown]);
});

test("article actions render accessible safe links and clipboard feedback", () => {
  const html = renderToStaticMarkup(
    <ArticleActions
      markdown={markdown}
      pageUrl={pageUrl}
      markdownUrl={markdownUrl}
    />,
  );
  assert.match(html, /aria-label="Article actions"/u);
  assert.match(html, /role="group"/u);
  assert.match(html, />Copy page</u);
  assert.match(html, />View Markdown</u);
  assert.match(html, />Open in ChatGPT</u);
  assert.match(html, />Open in Claude</u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.equal((html.match(/target="_blank"/gu) ?? []).length, 3);
  assert.equal((html.match(/rel="noreferrer noopener"/gu) ?? []).length, 3);
});
