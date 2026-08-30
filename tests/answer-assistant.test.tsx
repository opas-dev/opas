// ABOUTME: Verifies the native assistant's safe stream parsing and accessible public markup.
// ABOUTME: Covers XSS rejection, bounded context, disconnect recovery, and responsive contracts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AnswerMarkdown } from "@/app/answer-markdown";
import {
  AnswerStreamError,
  consumeAnswerResponse,
  conversationHistory,
  describeAnswerFailure,
  type AnswerStreamSnapshot,
} from "@/app/answer-stream";
import { Search } from "@/app/search";

const articleHash = "a".repeat(64);
const chunkHash = "b".repeat(64);

function streamResponse(parts: readonly string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
  );
}

const metadata = JSON.stringify({
  conversationId: "123e4567-e89b-42d3-a456-426614174000",
  generation: {
    model: "fixture-answer-v1",
    provider: "openai-compatible",
    retentionDisclosure: "Fixture requests are not retained.",
  },
  type: "metadata",
});
const content = JSON.stringify({
  markdown: "Open **Account settings**.",
  type: "content",
});
const citation = JSON.stringify({
  citation: {
    articleContentHash: articleHash,
    articleId: "article-password-reset",
    canonicalUrl: "https://help.example.test/account/reset-password",
    contentHash: chunkHash,
    headingPath: ["Account", "Password"],
    id: "C1",
    sourceId: "chunk-password-reset",
    sourceLineRange: { end: 5, start: 3 },
    title: "Reset your password",
  },
  type: "citation",
});
const finish = JSON.stringify({
  reason: "stop",
  type: "finish",
  usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32 },
});

test("parses fragmented cited-answer records without exposing uncited content", async () => {
  const updates: AnswerStreamSnapshot[] = [];
  const payload = `${metadata}\n${content}\n${citation}\n${finish}\n`;
  const result = await consumeAnswerResponse(
    streamResponse([payload.slice(0, 19), payload.slice(19, 91), payload.slice(91)]),
    { onSnapshot: (snapshot) => updates.push(snapshot) },
  );

  assert.equal(result.phase, "complete");
  assert.equal(
    result.conversationId,
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0], {
    citation: JSON.parse(citation).citation,
    markdown: ["Open **Account settings**."],
  });
  assert.equal(
    updates.some((update) => update.blocks.length > 0 && update.phase === "streaming"),
    true,
  );
  assert.equal(
    updates.some(
      (update) =>
        update.blocks.length === 0 &&
        JSON.stringify(update).includes("Open **Account settings**."),
    ),
    false,
  );
});

test("rejects streamed and stored XSS instead of rendering model-owned links", async () => {
  const unsafeRecords = [
    { markdown: '<img src=x onerror="alert(1)">', type: "content" },
    { markdown: "[Open this](javascript:alert(1))", type: "content" },
    { markdown: "![tracking pixel](https://attacker.example/pixel.png)", type: "content" },
  ];

  for (const unsafe of unsafeRecords) {
    await assert.rejects(
      consumeAnswerResponse(
        streamResponse([`${metadata}\n${JSON.stringify(unsafe)}\n${citation}\n${finish}\n`]),
      ),
      (error: unknown) =>
        error instanceof AnswerStreamError && error.code === "invalid-response",
    );
  }

  assert.throws(
    () => renderToStaticMarkup(<AnswerMarkdown markdown={'<script>alert("stored")</script>'} />),
    /unsupported Markdown/u,
  );
  const escaped = renderToStaticMarkup(
    <AnswerMarkdown markdown={'Use `<img src=x onerror="stored()">` as an example.'} />,
  );
  assert.doesNotMatch(escaped, /<img\b|onerror="/u);
  assert.match(escaped, /&lt;img src=x onerror=&quot;stored\(\)&quot;&gt;/u);
});

test("requires canonical server-shaped citations and safe protocols", async () => {
  const unsafeCitation = {
    ...JSON.parse(citation),
    citation: {
      ...JSON.parse(citation).citation,
      canonicalUrl: "javascript:alert(1)",
    },
  };
  await assert.rejects(
    consumeAnswerResponse(
      streamResponse([
        `${metadata}\n${content}\n${JSON.stringify(unsafeCitation)}\n${finish}\n`,
      ]),
    ),
    (error: unknown) =>
      error instanceof AnswerStreamError && error.code === "invalid-response",
  );
});

test("treats a disconnected stream as retryable and never commits pending text", async () => {
  const updates: AnswerStreamSnapshot[] = [];
  await assert.rejects(
    consumeAnswerResponse(streamResponse([`${metadata}\n${content}\n`]), {
      onSnapshot: (snapshot) => updates.push(snapshot),
    }),
    (error: unknown) =>
      error instanceof AnswerStreamError && error.code === "disconnected",
  );
  assert.equal(updates.some((update) => update.blocks.length > 0), false);
  assert.deepEqual(describeAnswerFailure("disconnected"), {
    message: "The answer stream disconnected. Check your connection and try again.",
    retryable: true,
  });
});

test("builds bounded history only from completed turns while page context stays server-owned", () => {
  const history = conversationHistory(
    Array.from({ length: 8 }, (_, index) => ({
      answer: `Answer ${index} ${"x".repeat(3_000)}`,
      question: `Question ${index}?`,
    })),
  );

  assert.equal(history.length <= 8, true);
  assert.equal(history[0]?.role, "user");
  assert.doesNotMatch(history[0]?.content ?? "", /Current published page/u);
  assert.equal(
    new TextEncoder().encode(history.map(({ content }) => content).join("")).byteLength <=
      8_192,
    true,
  );
  assert.deepEqual(conversationHistory([]), []);
});

test("renders keyboard and screen-reader semantics at the shared search entry point", () => {
  const markup = renderToStaticMarkup(
    <Search
      currentPage={{
        articleId: "article-runtime-mdx",
        path: "/getting-started/runtime-mdx",
        title: "Runtime MDX in OPAS",
      }}
      suggestedQuestions={["What are the key points in Runtime MDX in OPAS?"]}
    />,
  );

  assert.match(markup, /role="search"/u);
  assert.match(markup, /<label[^>]+for="help-search"/u);
  assert.match(markup, /type="search"/u);
  assert.match(markup, /type="submit"[^>]*>Ask/u);
  assert.match(markup, /role="status"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /type="button"[^>]*>What are the key points/u);
  assert.match(markup, /Using this published page as context/u);
});

test("keeps narrow-layout and reduced-motion behavior explicit", async () => {
  const [css, source] = await Promise.all([
    readFile(new URL("../src/app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../src/app/search.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /@media \(max-width: 40rem\)[\s\S]*\.answer-actions/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /min-height: 2\.75rem/u);
  assert.match(source, /currentPagePath: safeCurrentPage\.path/u);
  assert.match(source, /activeAnswer\.current\.conversationId = snapshot\.conversationId/u);
  assert.doesNotMatch(source, /conversationId: turn\.conversationId/u);
  assert.doesNotMatch(source, /conversationHistory\(safeCurrentPage/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|RuntimeMdx|<img\b/u);
});
