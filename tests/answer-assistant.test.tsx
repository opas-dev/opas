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
import {
  answerSnapshotDisposition,
  blockingAnswerRequest,
  citationLinkAttributes,
  claimPageCloseOutcome,
  Search,
  sendAnswerOutcome,
} from "@/app/search";

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

test("sends public answer outcomes without browser credentials", async (context) => {
  const requests: Array<Readonly<{ input: RequestInfo | URL; init?: RequestInit }>> = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(null, { status: 202 });
    },
  );

  assert.equal(
    await sendAnswerOutcome(
      "123e4567-e89b-42d3-a456-426614174000",
      "abandoned",
      "page-closed",
    ),
    true,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "/api/answers/outcomes");
  assert.equal(requests[0]?.init?.credentials, "omit");
  assert.equal(requests[0]?.init?.cache, "no-store");
  assert.equal(requests[0]?.init?.keepalive, true);
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

test("opens embedded citations outside the isolated assistant frame", () => {
  assert.deepEqual(citationLinkAttributes("same-page"), {});
  assert.deepEqual(citationLinkAttributes("new-tab"), {
    rel: "noreferrer noopener",
    target: "_blank",
  });
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

test("remembers a pre-metadata stop by request identity until its conversation is issued", () => {
  const controller = new AbortController();
  const stoppedRequest = {
    controller,
    conversationId: null,
    id: 7,
    stopReported: false,
    stopRequested: true,
    terminalObserved: false,
  };
  const retryWithSameTurnId = {
    controller: new AbortController(),
    conversationId: null,
    id: 7,
    stopReported: false,
    stopRequested: false,
    terminalObserved: false,
  };
  const streaming = Object.freeze({
    abstention: null,
    blocks: [],
    conversationId: null,
    failure: null,
    finish: null,
    metadata: null,
    phase: "streaming" as const,
  });
  const issued = Object.freeze({
    ...streaming,
    conversationId: "123e4567-e89b-42d3-a456-426614174000",
  });
  const retryIssued = Object.freeze({
    ...streaming,
    conversationId: "223e4567-e89b-42d3-a456-426614174001",
  });

  assert.equal(
    answerSnapshotDisposition(stoppedRequest, retryWithSameTurnId, streaming),
    "ignore",
  );
  assert.equal(stoppedRequest.conversationId, null);
  assert.equal(
    answerSnapshotDisposition(stoppedRequest, retryWithSameTurnId, issued),
    "abandon",
  );
  assert.equal(
    stoppedRequest.conversationId,
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(stoppedRequest.stopReported, true);
  assert.equal(
    answerSnapshotDisposition(stoppedRequest, retryWithSameTurnId, issued),
    "ignore",
  );

  assert.equal(
    answerSnapshotDisposition(
      retryWithSameTurnId,
      retryWithSameTurnId,
      retryIssued,
    ),
    "publish",
  );
  assert.equal(
    retryWithSameTurnId.conversationId,
    "223e4567-e89b-42d3-a456-426614174001",
  );
  stoppedRequest.controller.abort();
  assert.equal(stoppedRequest.controller.signal.aborted, true);
  assert.equal(retryWithSameTurnId.controller.signal.aborted, false);

  assert.equal(blockingAnswerRequest(null), null);
  assert.equal(blockingAnswerRequest(stoppedRequest), null);
  assert.equal(
    blockingAnswerRequest(retryWithSameTurnId),
    retryWithSameTurnId,
  );

  const completed = Object.freeze({
    ...retryIssued,
    finish: Object.freeze({
      reason: "stop" as const,
      usage: Object.freeze({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    }),
    phase: "complete" as const,
  });
  assert.equal(
    answerSnapshotDisposition(
      retryWithSameTurnId,
      retryWithSameTurnId,
      completed,
    ),
    "publish",
  );
  assert.equal(retryWithSameTurnId.terminalObserved, true);
  assert.equal(blockingAnswerRequest(retryWithSameTurnId), null);
  assert.equal(claimPageCloseOutcome(retryWithSameTurnId), null);

  const closingRequest = {
    controller: new AbortController(),
    conversationId: "323e4567-e89b-42d3-a456-426614174002",
    id: 8,
    stopReported: false,
    stopRequested: false,
    terminalObserved: false,
  };
  assert.deepEqual(claimPageCloseOutcome(closingRequest), {
    conversationId: "323e4567-e89b-42d3-a456-426614174002",
    reason: "page-closed",
  });
  assert.equal(claimPageCloseOutcome(closingRequest), null);

  const stoppedBeforeClose = {
    controller: new AbortController(),
    conversationId: "423e4567-e89b-42d3-a456-426614174003",
    id: 9,
    stopReported: false,
    stopRequested: true,
    terminalObserved: false,
  };
  assert.deepEqual(claimPageCloseOutcome(stoppedBeforeClose), {
    conversationId: "423e4567-e89b-42d3-a456-426614174003",
    reason: "user-cancelled",
  });
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
  assert.match(source, /request\.conversationId = snapshot\.conversationId/u);
  assert.doesNotMatch(source, /conversationId: turn\.conversationId/u);
  assert.doesNotMatch(source, /conversationHistory\(safeCurrentPage/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|RuntimeMdx|<img\b/u);
});
