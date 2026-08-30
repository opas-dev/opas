// ABOUTME: Verifies the inline contact-support recovery flow shared by native and embedded answers.
// ABOUTME: Covers accessible form markup, safe browser requests, abstention emphasis, and narrow layouts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  prepareSupportHandoffContext,
  sendSupportHandoff,
  SupportHandoff,
  type SupportHandoffContext,
} from "@/app/support-handoff";

const context: SupportHandoffContext = Object.freeze({
  citations: Object.freeze([]),
  outcome: "abstained",
  pageUrl: "https://customer.example.com/account?token=secret#password",
  question: "How do I reset my password?",
  transcript: Object.freeze([
    Object.freeze({ content: "How do I reset my password?", role: "user" }),
    Object.freeze({ content: "I could not verify an answer.", role: "assistant" }),
  ]),
});

test("renders an emphasized, accessible inline support form without a modal", () => {
  const markup = renderToStaticMarkup(
    <SupportHandoff
      conversationId="123e4567-e89b-42d3-a456-426614174000"
      context={context}
      emphasized
      requestKey="abstention-1"
    />,
  );

  assert.match(markup, /<section[^>]+class="support-handoff"/u);
  assert.match(markup, /data-emphasized="true"/u);
  assert.match(markup, /<h4[^>]*>Contact support<\/h4>/u);
  assert.match(markup, /<form/u);
  assert.match(markup, /<label[^>]+for="support-name-abstention-1"/u);
  assert.match(markup, /autoComplete="name"/u);
  assert.match(markup, /type="email"/u);
  assert.match(markup, /autoComplete="email"/u);
  assert.match(markup, /required=""/u);
  assert.match(markup, /role="status"/u);
  assert.doesNotMatch(markup, /<dialog|dangerouslySetInnerHTML/u);
});

test("keeps contact support available as a quiet disclosure after a cited answer", () => {
  const markup = renderToStaticMarkup(
    <SupportHandoff
      conversationId="123e4567-e89b-42d3-a456-426614174000"
      context={{ ...context, outcome: "user-requested" }}
      emphasized={false}
      requestKey="answer-1"
    />,
  );

  assert.match(markup, /type="button"[^>]*>Contact support<\/button>/u);
  assert.doesNotMatch(markup, /<form/u);
});

test("posts only the bounded handoff context and contact with one idempotency key", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const result = await sendSupportHandoff(
    context,
    { email: "reader@example.com", name: "Reader" },
    "123e4567-e89b-42d3-a456-426614174000",
    {
      fetch: async (input, init) => {
        calls.push({ input, init });
        return Response.json(
          { status: "delivered" },
          { status: 201 },
        );
      },
    },
  );

  assert.equal(result, "delivered");
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "/api/handoff");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.redirect, "error");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(
    headers.get("idempotency-key"),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    ...context,
    contact: { email: "reader@example.com", name: "Reader" },
  });
  assert.equal("target" in JSON.parse(String(calls[0]?.init?.body)), false);
});

test("bounds long transcript context and deduplicates repeated citations", () => {
  const citation = Object.freeze({
    articleContentHash: "a".repeat(64),
    articleId: "article_password",
    canonicalUrl: "https://help.example.com/account/reset-password",
    contentHash: "b".repeat(64),
    headingPath: Object.freeze(["Account", "Password"]),
    id: "C1",
    sourceId: "chunk_password",
    sourceLineRange: Object.freeze({ end: 12, start: 4 }),
    title: "Reset your password",
  });
  const prepared = prepareSupportHandoffContext({
    ...context,
    citations: Object.freeze([
      citation,
      { ...citation, id: "C2" },
      { ...citation, id: "C3", sourceId: "chunk_account" },
    ]),
    transcript: Object.freeze(
      Array.from({ length: 10 }, (_, index) =>
        Object.freeze({
          content: `${index}:${"🙂".repeat(1_200)}`,
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        }),
      ),
    ),
  });
  const encoder = new TextEncoder();

  assert.equal(prepared.citations.length, 2);
  assert.deepEqual(
    prepared.citations.map(({ sourceId }) => sourceId),
    ["chunk_password", "chunk_account"],
  );
  assert.ok(prepared.transcript.length <= 8);
  assert.ok(
    prepared.transcript.every(
      ({ content }) => encoder.encode(content).byteLength <= 2_048,
    ),
  );
  assert.ok(
    prepared.transcript.reduce(
      (total, { content }) => total + encoder.encode(content).byteLength,
      0,
    ) <= 8_192,
  );
  assert.match(prepared.transcript.at(-1)?.content ?? "", /^9:/u);
  assert.doesNotMatch(
    prepared.transcript.map(({ content }) => content).join("\n"),
    /^0:/u,
  );
});

test("keeps a pending delivery unconfirmed in the browser", async () => {
  const status = await sendSupportHandoff(
    context,
    { email: "reader@example.com" },
    "123e4567-e89b-42d3-a456-426614174000",
    {
      fetch: async () => Response.json({ status: "pending" }),
    },
  );

  assert.equal(status, "pending");
});

test("rejects malformed success responses without reflecting server content", async () => {
  await assert.rejects(
    sendSupportHandoff(
      context,
      { email: "reader@example.com" },
      "123e4567-e89b-42d3-a456-426614174000",
      {
        fetch: async () =>
          Response.json({ status: "sent", detail: "private provider response" }),
      },
    ),
    /Support handoff request failed/u,
  );
});

test("native and embed surfaces promote recovery after abstention or negative feedback", async () => {
  const [search, embed, support, css] = await Promise.all([
    readFile(new URL("../src/app/search.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/embed/embed-assistant.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/support-handoff.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(search, /turn\.phase === "abstained"/u);
  assert.match(search, /rating === "unhelpful"[\s\S]*"low-rated"/u);
  assert.match(search, /<SupportHandoff/u);
  assert.match(search, /Was this answer helpful\?/u);
  assert.match(search, /aria-pressed/u);
  assert.match(embed, /handoffPageUrl/u);
  assert.match(css, /\.support-handoff/u);
  assert.match(css, /@media \(max-width: 40rem\)[\s\S]*\.support-handoff/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(search, /requestKey=/u);
  assert.match(support, /Check delivery/u);
  assert.match(support, /disabled=\{phase !== "idle"\}/u);
  assert.match(support, /contact details stay fixed/u);
  assert.match(support, /it will not send twice/u);
  assert.doesNotMatch(support, /Try again/u);
  assert.doesNotMatch(`${search}\n${embed}`, /dangerouslySetInnerHTML|<dialog/u);
});
