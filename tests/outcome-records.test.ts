// ABOUTME: Verifies bounded analytics normalization and adversarial privacy redaction.
// ABOUTME: Covers retention configuration, credentials, network identifiers, and costs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationAnalyticsSlotsPerDay,
  createConversationAnalyticsPolicy,
  estimateConversationCostMicrodollars,
  maximumConversationAnalyticsMessageUtf8Bytes,
  maximumConversationAnalyticsMessages,
  maximumConversationAnalyticsUtf8Bytes,
  maximumRetrievalExcerptUtf8Bytes,
  maximumRetrievalTraceEntries,
  maximumRetrievalTraceUtf8Bytes,
  normalizeConversationAnalyticsId,
  prepareConversationAnalyticsRecord,
} from "@/outcomes/records";

const id = "123e4567-e89b-42d3-a456-426614174000";
const encoder = new TextEncoder();

function enabledPolicy(patterns = "[]") {
  const policy = createConversationAnalyticsPolicy({
    OPAS_ANALYTICS_REDACTION_PATTERNS: patterns,
  });
  assert.equal(policy.status, "enabled");
  if (policy.status !== "enabled") throw new Error("Expected enabled policy");
  return policy;
}

test("defaults to 30 days and allows only shorter retention or complete disablement", () => {
  assert.deepEqual(
    createConversationAnalyticsPolicy({
      OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "0",
    }),
    { status: "disabled" },
  );
  const defaultPolicy = createConversationAnalyticsPolicy({});
  const shorterPolicy = createConversationAnalyticsPolicy({
    OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "7",
  });
  assert.equal(defaultPolicy.status, "enabled");
  assert.equal(shorterPolicy.status, "enabled");
  if (defaultPolicy.status === "enabled") assert.equal(defaultPolicy.retentionDays, 30);
  if (shorterPolicy.status === "enabled") assert.equal(shorterPolicy.retentionDays, 7);

  for (const value of ["-1", "01", "31", " 7", "7 ", "Infinity", "1.5"]) {
    assert.deepEqual(
      createConversationAnalyticsPolicy({
        OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: value,
      }),
      { status: "unavailable" },
    );
  }
});

test("redacts every required sensitive shape including short credentials and compressed IPs", () => {
  const policy = enabledPolicy('["Customer Alpha","internal-ticket-7"]');
  const privateValues = [
    "a@b",
    "user@company",
    "reader@example.com",
    "+40 (712) 345-678",
    "password=x",
    'api_key="ab"',
    "client-secret=xyz",
    "Authorization: Bearer x",
    "Basic YTpi",
    "203.0.113.7",
    "::1",
    "2001:db8::1",
    "::ffff:192.0.2.1",
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "https://reader:pw@example.com/private",
    "Customer Alpha",
    "internal-ticket-7",
  ] as const;
  const redacted = policy.redact(privateValues.join(" | "));

  for (const privateValue of privateValues) {
    assert.equal(
      redacted.toLowerCase().includes(privateValue.toLowerCase()),
      false,
      `Sensitive value survived: ${privateValue}`,
    );
  }
  assert.match(redacted, /\[REDACTED\]/u);
  assert.equal(redacted.includes("::ffff:"), false);
});

test("configured literal validation is deterministic across repeated pattern entries", () => {
  const invalidPatterns = [
    '["valid","bad\\u0001"]',
    '["valid","bad\\u202e"]',
    JSON.stringify(Array.from({ length: 33 }, (_, index) => `value-${index}`)),
    JSON.stringify(["x".repeat(129)]),
    '[" leading"]',
  ];
  for (let repetition = 0; repetition < 4; repetition += 1) {
    for (const patterns of invalidPatterns) {
      assert.deepEqual(
        createConversationAnalyticsPolicy({
          OPAS_ANALYTICS_REDACTION_PATTERNS: patterns,
        }),
        { status: "unavailable" },
      );
    }
  }
});

test("prepares only bounded redacted conversation and server retrieval evidence", () => {
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const policy = enabledPolicy('["ClientProject"]');
  const record = prepareConversationAnalyticsRecord(
    {
      conversation: Array.from({ length: 14 }, (_, index) => ({
        content: `${index} reader@example.com ClientProject ${"🙂".repeat(2_000)}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      })),
      costMicrodollars: 12,
      durationMilliseconds: 500,
      firstTokenMilliseconds: 125,
      id,
      inputTokens: 100,
      model: "model-secret=abc",
      outcome: "answered",
      outputTokens: 50,
      provider: "provider",
      reason: "Basic YTpi",
      retrievalTrace: Array.from({ length: 8 }, (_, index) => ({
        articleContentHash: "a".repeat(64),
        articleId: `article-${index}`,
        canonicalUrl: `https://help.example.com/article-${index}`,
        contentHash: "b".repeat(64),
        excerpt: `Evidence reader@company ${"é".repeat(2_000)}`,
        headingPath: ["Account ClientProject"],
        indexGeneration: 1,
        mode: "hybrid" as const,
        ordinal: index,
        score: 0.9,
        sourceId: `source-${index}`,
        sourceLineRange: { end: 8, start: 3 },
        title: `Title ${index}`,
      })),
      startedAt,
      updatedAt: new Date("2026-08-30T12:00:00.500Z"),
      workspaceId: "workspace_demo",
    },
    policy,
  );

  assert.ok(record);
  assert.equal(record.expiresAt.toISOString(), "2026-09-29T12:00:00.000Z");
  assert.equal(record.bucketDay, "20260830");
  assert.equal(record.bucketSlot >= 0, true);
  assert.equal(record.bucketSlot < conversationAnalyticsSlotsPerDay, true);
  assert.equal(record.firstTokenMilliseconds, 125);
  assert.equal(record.conversation.length <= maximumConversationAnalyticsMessages, true);
  assert.equal(record.conversation.length > 0, true);
  assert.equal(
    record.conversation.every(
      ({ content }) =>
        encoder.encode(content).byteLength <= maximumConversationAnalyticsMessageUtf8Bytes,
    ),
    true,
  );
  assert.equal(
    record.conversation.reduce(
      (total, { content }) => total + encoder.encode(content).byteLength,
      0,
    ) <= maximumConversationAnalyticsUtf8Bytes,
    true,
  );
  assert.equal(record.retrievalTrace.length, maximumRetrievalTraceEntries);
  assert.equal(
    record.retrievalTrace.every(
      ({ excerpt }) => encoder.encode(excerpt).byteLength <= maximumRetrievalExcerptUtf8Bytes,
    ),
    true,
  );
  assert.equal(
    record.retrievalTrace.reduce(
      (total, entry) =>
        total +
        [
          entry.articleContentHash,
          entry.articleId,
          entry.canonicalUrl,
          entry.contentHash,
          entry.excerpt,
          ...entry.headingPath,
          entry.sourceId,
          entry.title,
        ]
          .reduce((sum, value) => sum + encoder.encode(value).byteLength, 0),
      0,
    ) <= maximumRetrievalTraceUtf8Bytes,
    true,
  );
  assert.doesNotMatch(JSON.stringify(record), /reader@|ClientProject|Basic YTpi/u);
  assert.equal("contact" in record, false);
  assert.equal("requesterIp" in record, false);
  assert.equal("userAgent" in record, false);
  assert.equal("cookies" in record, false);
});

test("rejects first-content-token latency outside the total request duration", () => {
  const policy = enabledPolicy();
  const base = {
    conversation: [{ content: "Question", role: "user" as const }],
    durationMilliseconds: 100,
    id,
    model: "model",
    outcome: "abandoned" as const,
    provider: "provider",
    retrievalTrace: [],
    startedAt: new Date("2026-08-30T12:00:00.000Z"),
    updatedAt: new Date("2026-08-30T12:00:00.100Z"),
    workspaceId: "workspace_demo",
  };
  assert.equal(
    prepareConversationAnalyticsRecord(
      { ...base, firstTokenMilliseconds: 101 },
      policy,
    ),
    null,
  );
  assert.equal(
    prepareConversationAnalyticsRecord(
      { ...base, firstTokenMilliseconds: -1 },
      policy,
    ),
    null,
  );
  assert.equal(
    prepareConversationAnalyticsRecord(
      { ...base, firstTokenMilliseconds: 50, outcome: "abstained" },
      policy,
    ),
    null,
  );
});

test("rejects caller IDs and arithmetic values outside the bounded contract", () => {
  assert.equal(normalizeConversationAnalyticsId(id), id);
  for (const value of ["", "123e4567-e89b-12d3-a456-426614174000", id.toUpperCase()]) {
    assert.equal(normalizeConversationAnalyticsId(value), null);
  }
  assert.equal(estimateConversationCostMicrodollars(1_000_000, 2_000_000, "3", "4"), 11);
  assert.equal(
    estimateConversationCostMicrodollars(
      Number.MAX_SAFE_INTEGER,
      1,
      String(Number.MAX_SAFE_INTEGER),
      "1",
    ),
    null,
  );
  assert.equal(estimateConversationCostMicrodollars(1, 1, "1.2", "1"), null);
});
