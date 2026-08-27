// ABOUTME: Verifies strict anonymous article-event requests and publication gating.
// ABOUTME: Guards request limits, bounded UTC-day slots, retention, and anonymous persistence.
import assert from "node:assert/strict";
import test from "node:test";

import {
  recordPublishedArticleFeedback,
  recordPublishedArticleView,
} from "@/analytics/events";
import {
  anonymousArticleEventRequesterKey,
  articleEventProcessLimits,
  articleEventRequesterLimits,
  articleEventWindowMilliseconds,
  createArticleEventGate,
} from "@/analytics/gate";
import {
  handleArticleFeedbackRequest,
  handleArticleViewRequest,
} from "@/analytics/handlers";
import {
  articleEventRetentionDays,
  articleEventRetentionStart,
  articleEventSlotsPerDay,
  createArticleFeedback,
  createArticleView,
} from "@/analytics/records";
import {
  maximumArticleEventBodyBytes,
  parseArticleFeedbackRequest,
  parseArticleViewRequest,
} from "@/analytics/requests";
import { demoIds } from "@/db/demo";
import type {
  Article,
  ArticleView,
  Feedback,
} from "@/db/repository";

const article: Article = {
  id: demoIds.publishedArticle,
  workspaceId: demoIds.workspace,
  categoryId: demoIds.gettingStartedCategory,
  slug: "runtime-mdx",
  title: "Runtime MDX in OPAS",
  mdx: "# Runtime MDX in OPAS",
  status: "published",
  isFaq: false,
  authorName: "OPAS",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const recordedAt = new Date("2026-08-27T12:34:56.000Z");
const recordOptions = {
  now: () => recordedAt,
  random: () => 0.5,
};

function jsonRequest(value: unknown) {
  return new Request("https://help.example.test/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(value),
  });
}

test("feedback requires a strict boolean and rejects extra fields", async () => {
  for (const helpful of ["true", 1, null, undefined]) {
    const result = await parseArticleFeedbackRequest(jsonRequest({ helpful }));
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 400);
    }
  }

  const forged = await parseArticleFeedbackRequest(
    jsonRequest({ helpful: true, articleId: "article_other" }),
  );
  assert.equal(forged.success, false);
  if (!forged.success) {
    assert.equal(forged.status, 400);
  }
});

test("feedback trims comments and stores empty, missing, and null comments as null", async () => {
  const trimmed = await parseArticleFeedbackRequest(
    jsonRequest({ helpful: false, comment: "  Needs an example.  " }),
  );
  assert.deepEqual(trimmed, {
    success: true,
    data: { helpful: false, comment: "Needs an example." },
  });

  for (const payload of [
    { helpful: true },
    { helpful: true, comment: null },
    { helpful: true, comment: "  \n\t " },
  ]) {
    assert.deepEqual(await parseArticleFeedbackRequest(jsonRequest(payload)), {
      success: true,
      data: { helpful: true, comment: null },
    });
  }
});

test("feedback bounds trimmed comments by Unicode code point", async () => {
  const accepted = await parseArticleFeedbackRequest(
    jsonRequest({ helpful: true, comment: "🔎".repeat(1_000) }),
  );
  assert.equal(accepted.success, true);

  const rejected = await parseArticleFeedbackRequest(
    jsonRequest({ helpful: true, comment: "🔎".repeat(1_001) }),
  );
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.equal(rejected.error, "Comments must be 1,000 characters or fewer.");
  }
});

test("feedback rejects missing content types and malformed JSON", async () => {
  const missingType = await parseArticleFeedbackRequest(
    new Request("https://help.example.test/api/event", {
      method: "POST",
      body: new TextEncoder().encode("true"),
    }),
  );
  assert.deepEqual(missingType, {
    success: false,
    status: 415,
    error: "Content-Type must be application/json.",
  });

  const wrongType = await parseArticleFeedbackRequest(
    new Request("https://help.example.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "true",
    }),
  );
  assert.deepEqual(wrongType, {
    success: false,
    status: 415,
    error: "Content-Type must be application/json.",
  });

  const malformed = await parseArticleFeedbackRequest(
    new Request("https://help.example.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
  );
  assert.deepEqual(malformed, {
    success: false,
    status: 400,
    error: "Request body must be valid JSON.",
  });
});

test("article event requests reject bodies larger than the byte limit", async () => {
  const oversized = await parseArticleFeedbackRequest(
    new Request("https://help.example.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(maximumArticleEventBodyBytes + 1),
    }),
  );
  assert.equal(oversized.success, false);
  if (!oversized.success) {
    assert.equal(oversized.status, 413);
  }

  const oversizedDeclaration = await parseArticleViewRequest(
    new Request("https://help.example.test/api/event", {
      method: "POST",
      headers: {
        "Content-Length": String(maximumArticleEventBodyBytes + 1),
      },
    }),
  );
  assert.equal(oversizedDeclaration.success, false);
  if (!oversizedDeclaration.success) {
    assert.equal(oversizedDeclaration.status, 413);
  }
});

test("view requests allow no body or an empty JSON object only", async () => {
  assert.deepEqual(
    await parseArticleViewRequest(
      new Request("https://help.example.test/api/event", { method: "POST" }),
    ),
    { success: true, data: {} },
  );
  assert.deepEqual(await parseArticleViewRequest(jsonRequest({})), {
    success: true,
    data: {},
  });

  const extraField = await parseArticleViewRequest(jsonRequest({ source: "browser" }));
  assert.equal(extraField.success, false);
  if (!extraField.success) {
    assert.equal(extraField.status, 400);
  }
});

test("article events have exactly 1,024 isolated UTC-day slots per article and kind", () => {
  const viewIds = new Set(
    Array.from({ length: articleEventSlotsPerDay }, (_, slot) =>
      createArticleView(article.id, {
        now: () => recordedAt,
        random: () => slot / articleEventSlotsPerDay,
      }).id,
    ),
  );
  assert.equal(articleEventSlotsPerDay, 1_024);
  assert.equal(viewIds.size, articleEventSlotsPerDay);

  const firstView = createArticleView(article.id, {
    now: () => recordedAt,
    random: () => 0,
  });
  const collidingView = createArticleView(article.id, {
    now: () => recordedAt,
    random: () => 0,
  });
  const otherArticleView = createArticleView("article_other", {
    now: () => recordedAt,
    random: () => 0,
  });
  const nextDayView = createArticleView(article.id, {
    now: () => new Date("2026-08-28T00:00:00.000Z"),
    random: () => 0,
  });
  const feedback = createArticleFeedback(
    article.id,
    { helpful: true, comment: null },
    { now: () => recordedAt, random: () => 0 },
  );

  assert.equal(firstView.id, collidingView.id);
  assert.notEqual(firstView.id, otherArticleView.id);
  assert.notEqual(firstView.id, nextDayView.id);
  assert.notEqual(firstView.id, feedback.id);
  assert.deepEqual(firstView, {
    id: `article_view_${article.id}_20260827_0000`,
    articleId: article.id,
    viewedAt: recordedAt,
  });
  assert.equal(feedback.createdAt, recordedAt);
});

test("article event retention starts exactly 30 days before the event", () => {
  assert.equal(articleEventRetentionDays, 30);
  assert.equal(
    articleEventRetentionStart(recordedAt).toISOString(),
    "2026-07-28T12:34:56.000Z",
  );
});

test("article event gate applies independent requester limits and resets each minute", async () => {
  const consume = createArticleEventGate(async (request) => {
    return request.headers.get("x-test-requester") ?? "unidentified";
  });
  const windowStart = Date.UTC(2026, 7, 28, 12, 0, 0);

  for (const kind of ["feedback", "view"] as const) {
    const firstRequester = new Request("https://help.example.test", {
      headers: { "x-test-requester": `${kind}-first` },
    });
    const secondRequester = new Request("https://help.example.test", {
      headers: { "x-test-requester": `${kind}-second` },
    });

    for (let index = 0; index < articleEventRequesterLimits[kind]; index += 1) {
      assert.deepEqual(await consume(kind, firstRequester, windowStart), {
        accepted: true,
      });
    }
    assert.deepEqual(await consume(kind, firstRequester, windowStart), {
      accepted: false,
      retryAfterSeconds: 60,
    });
    assert.deepEqual(await consume(kind, secondRequester, windowStart), {
      accepted: true,
    });
    assert.deepEqual(
      await consume(
        kind,
        firstRequester,
        windowStart + articleEventWindowMilliseconds,
      ),
      { accepted: true },
    );
  }
});

test("article event gate enforces the process ceiling across requesters", async () => {
  const consume = createArticleEventGate(async (request) => {
    return request.headers.get("x-test-requester") ?? "unidentified";
  });
  const windowStart = Date.UTC(2026, 7, 28, 12, 0, 0);

  for (let index = 0; index < articleEventProcessLimits.feedback; index += 1) {
    const requester = Math.floor(index / articleEventRequesterLimits.feedback);
    const request = new Request("https://help.example.test", {
      headers: { "x-test-requester": `requester-${requester}` },
    });
    assert.deepEqual(await consume("feedback", request, windowStart), {
      accepted: true,
    });
  }

  assert.deepEqual(
    await consume(
      "feedback",
      new Request("https://help.example.test", {
        headers: { "x-test-requester": "requester-after-process-limit" },
      }),
      windowStart,
    ),
    { accepted: false, retryAfterSeconds: 60 },
  );
});

test("Cloudflare requester keys are salted while untrusted deployments skip identity", async () => {
  const address = "203.0.113.42";
  const request = new Request("https://help.example.test", {
    headers: { "cf-connecting-ip": address },
  });
  const first = await anonymousArticleEventRequesterKey(request, "d1");
  const second = await anonymousArticleEventRequesterKey(request, "d1");
  const other = await anonymousArticleEventRequesterKey(
    new Request("https://help.example.test", {
      headers: { "cf-connecting-ip": "203.0.113.43" },
    }),
    "d1",
  );

  assert.ok(first);
  assert.ok(second);
  assert.ok(other);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(first.length, 64);
  assert.ok(!first.includes(address));
  assert.equal(await anonymousArticleEventRequesterKey(request, "postgres"), null);
  assert.equal(
    await anonymousArticleEventRequesterKey(
      new Request("https://help.example.test", {
        headers: { "x-forwarded-for": address },
      }),
      "d1",
    ),
    null,
  );
});

test("article event gate never resets an active window backward", async () => {
  let releasePrevious: (() => void) | undefined;
  let releaseCurrent: (() => void) | undefined;
  const previousReady = new Promise<void>((resolve) => {
    releasePrevious = resolve;
  });
  const currentReady = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const consume = createArticleEventGate(async (request) => {
    if (request.headers.get("x-window") === "previous") {
      await previousReady;
    } else if (request.headers.get("x-window") === "current") {
      await currentReady;
    }
    return "same-requester";
  });
  const previousWindow = Date.UTC(2026, 7, 28, 12, 0, 0);
  const currentWindow = previousWindow + articleEventWindowMilliseconds;
  const previousRequest = new Request("https://help.example.test", {
    headers: { "x-window": "previous" },
  });
  const currentRequest = new Request("https://help.example.test", {
    headers: { "x-window": "current" },
  });

  const previousResult = consume("feedback", previousRequest, previousWindow);
  const currentResult = consume("feedback", currentRequest, currentWindow);
  releaseCurrent?.();
  assert.deepEqual(await currentResult, { accepted: true });
  releasePrevious?.();
  assert.deepEqual(await previousResult, { accepted: true });

  for (let index = 2; index < articleEventRequesterLimits.feedback; index += 1) {
    assert.deepEqual(
      await consume("feedback", new Request("https://help.example.test"), currentWindow),
      { accepted: true },
    );
  }
  assert.deepEqual(
    await consume("feedback", new Request("https://help.example.test"), currentWindow),
    { accepted: false, retryAfterSeconds: 60 },
  );
});

test("article handlers reject exhausted requests before opening a repository", async () => {
  let repositoryCalls = 0;
  const response = await handleArticleFeedbackRequest(
    jsonRequest({ helpful: true }),
    article.id,
    {
      async consumeAllowance() {
        return { accepted: false, retryAfterSeconds: 17 };
      },
      async getRepository() {
        repositoryCalls += 1;
        throw new Error("The repository must not be opened.");
      },
    },
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "17");
  assert.deepEqual(await response.json(), {
    error: "Anonymous analytics are temporarily busy. Please try again shortly.",
  });
  assert.equal(repositoryCalls, 0);
});

test("article handlers return accepted responses after published persistence", async () => {
  const views: ArticleView[] = [];
  const feedbackRows: Feedback[] = [];
  const dependencies = {
    async consumeAllowance() {
      return { accepted: true as const };
    },
    async getRepository() {
      return {
        async getArticle() {
          return article;
        },
        async recordView(view: ArticleView) {
          views.push(view);
        },
        async createFeedback(feedback: Feedback) {
          feedbackRows.push(feedback);
        },
      };
    },
  };

  const viewResponse = await handleArticleViewRequest(
    jsonRequest({}),
    article.id,
    dependencies,
  );
  const feedbackResponse = await handleArticleFeedbackRequest(
    jsonRequest({ helpful: false, comment: "Needs one example." }),
    article.id,
    dependencies,
  );

  assert.equal(viewResponse.status, 200);
  assert.equal(feedbackResponse.status, 200);
  assert.deepEqual(await viewResponse.json(), { accepted: true });
  assert.deepEqual(await feedbackResponse.json(), { accepted: true });
  assert.equal(views.length, 1);
  assert.equal(feedbackRows.length, 1);
  assert.equal(feedbackRows[0].helpful, false);
  assert.equal(feedbackRows[0].comment, "Needs one example.");
});

test("view recording checks the demo workspace and current publication state", async () => {
  const views: ArticleView[] = [];
  const requestedWorkspaces: string[] = [];
  const repository = {
    async getArticle(workspaceId: string) {
      requestedWorkspaces.push(workspaceId);
      return article;
    },
    async recordView(view: ArticleView) {
      views.push(view);
    },
  };

  assert.equal(
    await recordPublishedArticleView(repository, article.id, recordOptions),
    true,
  );
  assert.deepEqual(requestedWorkspaces, [demoIds.workspace]);
  assert.deepEqual(views, [
    {
      id: `article_view_${article.id}_20260827_0512`,
      articleId: article.id,
      viewedAt: recordedAt,
    },
  ]);

  const blockedViews: ArticleView[] = [];
  const draftRepository = {
    async getArticle() {
      return { ...article, status: "draft" as const };
    },
    async recordView(view: ArticleView) {
      blockedViews.push(view);
    },
  };
  assert.equal(await recordPublishedArticleView(draftRepository, article.id), false);
  assert.deepEqual(blockedViews, []);
});

test("feedback recording uses a bounded server record and rejects missing articles", async () => {
  const feedbackRows: Feedback[] = [];
  const repository = {
    async getArticle() {
      return article;
    },
    async createFeedback(feedback: Feedback) {
      feedbackRows.push(feedback);
    },
  };

  assert.equal(
    await recordPublishedArticleFeedback(
      repository,
      article.id,
      { helpful: true, comment: null },
      recordOptions,
    ),
    true,
  );
  const expectedFeedbackRows: Feedback[] = [
    {
      id: `article_feedback_${article.id}_20260827_0512`,
      articleId: article.id,
      helpful: true,
      comment: null,
      createdAt: recordedAt,
    },
  ];
  assert.deepEqual(feedbackRows, expectedFeedbackRows);

  const missingRepository = {
    async getArticle() {
      return null;
    },
    async createFeedback(feedback: Feedback) {
      feedbackRows.push(feedback);
    },
  };
  assert.equal(
    await recordPublishedArticleFeedback(missingRepository, "article_missing", {
      helpful: false,
      comment: "Missing",
    }),
    false,
  );
  assert.equal(feedbackRows.length, 1);
});
