// ABOUTME: Offers safe public-article copy, Markdown, and AI handoff actions.
// ABOUTME: Sends only the canonical published URL in fixed, encoded external prompts.
"use client";

import { useState } from "react";

type ArticleActionsProps = Readonly<{
  markdown: string;
  markdownUrl: string;
  pageUrl: string;
}>;

type ClipboardWriter = (value: string) => Promise<void>;

const publicArticlePathPattern =
  /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function canonicalArticleUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !publicArticlePathPattern.test(url.pathname)
  ) {
    throw new Error("Article actions require a canonical public article URL");
  }
  return url;
}

export function articleActionTargets(pageUrl: string, markdownUrl: string) {
  const page = canonicalArticleUrl(pageUrl);
  const markdown = new URL(markdownUrl);
  if (
    markdown.protocol !== page.protocol ||
    markdown.origin !== page.origin ||
    markdown.username !== "" ||
    markdown.password !== "" ||
    markdown.pathname !== `${page.pathname}.md` ||
    markdown.search !== "" ||
    markdown.hash !== ""
  ) {
    throw new Error("Article actions require the canonical Markdown URL");
  }

  const prompt =
    `Use this published help article in Markdown as the source and help me understand it: ${markdown.toString()}`;
  const chatGpt = new URL("https://chatgpt.com/");
  chatGpt.searchParams.set("q", prompt);
  const claude = new URL("https://claude.ai/new");
  claude.searchParams.set("q", prompt);

  return {
    chatGpt: chatGpt.toString(),
    claude: claude.toString(),
    markdown: markdown.toString(),
    page: page.toString(),
    prompt,
  };
}

export async function copyArticlePage(
  writeText: ClipboardWriter,
  markdown: string,
) {
  await writeText(markdown);
}

export function ArticleActions({
  markdown,
  markdownUrl,
  pageUrl,
}: ArticleActionsProps) {
  const targets = articleActionTargets(pageUrl, markdownUrl);
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");

  async function copyPage() {
    if (copyState === "copying") return;
    setCopyState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await copyArticlePage(
        (value) => navigator.clipboard.writeText(value),
        markdown,
      );
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="article-actions" role="group" aria-label="Article actions">
      <button
        type="button"
        disabled={copyState === "copying"}
        onClick={copyPage}
      >
        {copyState === "copying" ? "Copying…" : "Copy page"}
      </button>
      <a href={targets.markdown} target="_blank" rel="noreferrer noopener">
        View Markdown
      </a>
      <details className="article-action-menu">
        <summary>Use with AI</summary>
        <div>
          <a href={targets.chatGpt} target="_blank" rel="noreferrer noopener">
            Open in ChatGPT
          </a>
          <a href={targets.claude} target="_blank" rel="noreferrer noopener">
            Open in Claude
          </a>
        </div>
      </details>
      <span className="article-actions-status" role="status" aria-live="polite">
        {copyState === "copied" ? "Page Markdown copied." : null}
        {copyState === "failed" ? "Copy failed. Use View Markdown instead." : null}
      </span>
    </div>
  );
}
