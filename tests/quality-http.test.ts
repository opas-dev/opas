// ABOUTME: Verifies administrator authorization, strict origins, bounded bodies, and safe exports.
// ABOUTME: Proves quality HTTP failures never reflect provider details or accept workspace input.
import assert from "node:assert/strict";
import test from "node:test";

import { createQualityEvaluationResults } from "@/quality/console";
import type { EvidenceChunkRecord, SavedQuestionSet } from "@/db/repository";
import {
  handleQuestionSetImportRequest,
  handleQualityExportRequest,
  handleQualityPlaygroundRequest,
  handleQualityReplayRequest,
  handleQualityRunRequest,
  maximumQuestionSetImportUtf8Bytes,
  maximumQualityRequestUtf8Bytes,
} from "@/quality/http";
import { QualityConsoleError } from "@/quality/runtime";
import {
  importSavedQuestionSet,
  QuestionSetImportError,
} from "@/quality/question-set-import";

const origin = "https://quality.example.test";
const sourceHash = "a".repeat(64);
const fixtureHash = "b".repeat(64);
const createdAt = new Date("2026-08-30T12:00:00.000Z");
const validResults = createQualityEvaluationResults([
  {
    actualOutcome: "abstain",
    answer: null,
    citations: [],
    claims: [],
    classification: "unsupported",
    costMicrodollars: 0,
    durationMilliseconds: 80,
    expectedOutcome: "abstain",
    firstTokenMilliseconds: null,
    generation: null,
    id: "question_one",
    inputTokens: 0,
    manualReview: null,
    outputTokens: 0,
    passed: true,
    provenanceValid: true,
    question: "Is a ticket inbox included?",
    reason: "insufficient-evidence",
    sourceHit: false,
    totalTokens: 0,
    trace: [],
  },
]);

const validQuestionSetFixture = Object.freeze({
  id: "question_set_release_v1",
  name: "Release questions",
  questions: Object.freeze([
    Object.freeze({
      acceptedSourceIds: Object.freeze(["chunk_setup"]),
      classification: "answerable",
      expectedOutcome: "answer",
      id: "question_setup",
      question: "How do I configure the workspace?",
      sourceContentHashes: Object.freeze([sourceHash]),
    }),
    Object.freeze({
      acceptedSourceIds: Object.freeze([]),
      classification: "unsupported",
      expectedOutcome: "abstain",
      id: "question_ticketing",
      question: "Does OPAS include a ticket inbox?",
      sourceContentHashes: Object.freeze([]),
    }),
  ]),
  schema: "opas.saved-question-set.v1",
  sourceContentHash: fixtureHash,
  version: 1,
});

const publishedEvidence = Object.freeze({
  articleContentHash: "c".repeat(64),
  articleId: "article_setup",
  canonicalUrl: "https://help.example.test/setup",
  contentHash: sourceHash,
  createdAt,
  embeddingInputHash: "d".repeat(64),
  embeddingText: "Configure the workspace.",
  evidenceText: "Configure the workspace.",
  headingPath: Object.freeze(["Setup"]),
  id: "chunk_setup",
  indexGeneration: 4,
  markdown: "Configure the workspace.",
  ordinal: 0,
  publicationState: "published",
  sourceLineRange: Object.freeze({ end: 2, start: 1 }),
  title: "Setup",
  updatedAt: createdAt,
  workspaceId: "workspace_current",
}) satisfies EvidenceChunkRecord;

function post(path: string, body: unknown, requestOrigin = origin) {
  return new Request(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json; charset=utf-8",
      host: new URL(origin).host,
      origin: requestOrigin,
    },
    method: "POST",
  });
}

test("imports a validated question set into only the server-selected workspace", async () => {
  const saved: SavedQuestionSet[] = [];
  const result = await importSavedQuestionSet(
    "workspace_current",
    validQuestionSetFixture,
    {
      async getQuestionSet(workspaceId, id) {
        assert.equal(workspaceId, "workspace_current");
        assert.equal(id, validQuestionSetFixture.id);
        return null;
      },
      async listEvidenceChunks(workspaceId) {
        assert.equal(workspaceId, "workspace_current");
        return [publishedEvidence];
      },
      async saveQuestionSet(questionSet) {
        saved.push(questionSet);
      },
    },
    () => createdAt,
  );

  assert.deepEqual(result, {
    id: validQuestionSetFixture.id,
    name: validQuestionSetFixture.name,
    questionCount: 2,
    version: 1,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.workspaceId, "workspace_current");
  assert.equal(saved[0]?.createdAt, createdAt);
  assert.deepEqual(saved[0]?.questions, validQuestionSetFixture.questions);
});

test("rejects malformed, cross-workspace, mismatched, and duplicate imports atomically", async () => {
  let saveCalls = 0;
  let existing: SavedQuestionSet | null = null;
  let evidence: EvidenceChunkRecord[] = [publishedEvidence];
  const repository = {
    async getQuestionSet() {
      return existing;
    },
    async listEvidenceChunks() {
      return evidence;
    },
    async saveQuestionSet() {
      saveCalls += 1;
    },
  };
  const invalidFixtures = [
    { ...validQuestionSetFixture, workspaceId: "workspace_other" },
    {
      ...validQuestionSetFixture,
      questions: [
        { ...validQuestionSetFixture.questions[0], classification: "invented" },
      ],
    },
    {
      ...validQuestionSetFixture,
      questions: [
        { ...validQuestionSetFixture.questions[0], expectedOutcome: "maybe" },
      ],
    },
    {
      ...validQuestionSetFixture,
      questions: [
        { ...validQuestionSetFixture.questions[0], sourceContentHashes: [] },
      ],
    },
    {
      ...validQuestionSetFixture,
      questions: Array.from({ length: 101 }, (_, index) => ({
        ...validQuestionSetFixture.questions[1],
        id: `question_${index}`,
      })),
    },
  ];
  for (const fixture of invalidFixtures) {
    await assert.rejects(
      importSavedQuestionSet("workspace_current", fixture, repository, () => createdAt),
      (error: unknown) =>
        error instanceof QuestionSetImportError && error.code === "invalid-request",
    );
  }

  await assert.rejects(
    importSavedQuestionSet(
      "workspace_current",
      {
        ...validQuestionSetFixture,
        questions: [
          {
            ...validQuestionSetFixture.questions[0],
            sourceContentHashes: ["e".repeat(64)],
          },
        ],
      },
      repository,
      () => createdAt,
    ),
    (error: unknown) =>
      error instanceof QuestionSetImportError && error.code === "source-mismatch",
  );

  evidence = [{ ...publishedEvidence, workspaceId: "workspace_other" }];
  await assert.rejects(
    importSavedQuestionSet(
      "workspace_current",
      validQuestionSetFixture,
      repository,
      () => createdAt,
    ),
    (error: unknown) =>
      error instanceof QuestionSetImportError && error.code === "source-mismatch",
  );

  evidence = [publishedEvidence];
  existing = {
    ...validQuestionSetFixture,
    createdAt,
    workspaceId: "workspace_current",
  } as SavedQuestionSet;
  await assert.rejects(
    importSavedQuestionSet(
      "workspace_current",
      validQuestionSetFixture,
      repository,
      () => createdAt,
    ),
    (error: unknown) =>
      error instanceof QuestionSetImportError && error.code === "already-exists",
  );
  assert.equal(saveCalls, 0);
});

test("question set import HTTP boundary authorizes first and enforces its byte limit", async () => {
  const unauthorized = new Error("redirect-to-login");
  let importCalls = 0;
  await assert.rejects(
    handleQuestionSetImportRequest(
      post("/admin/quality/import", validQuestionSetFixture),
      {
        authorize: async () => {
          throw unauthorized;
        },
        importQuestionSet: async () => {
          importCalls += 1;
          return { id: "set", name: "Set", questionCount: 1, version: 1 };
        },
      },
    ),
    (error: unknown) => error === unauthorized,
  );

  const accepted = await handleQuestionSetImportRequest(
    post("/admin/quality/import", validQuestionSetFixture),
    {
      authorize: async () => ({}),
      importQuestionSet: async (fixture) => {
        importCalls += 1;
        assert.deepEqual(fixture, validQuestionSetFixture);
        return { id: "set", name: "Set", questionCount: 2, version: 1 };
      },
    },
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), {
    questionSet: { id: "set", name: "Set", questionCount: 2, version: 1 },
  });

  const oversized = await handleQuestionSetImportRequest(
    new Request(`${origin}/admin/quality/import`, {
      body: JSON.stringify({ value: "x".repeat(maximumQuestionSetImportUtf8Bytes) }),
      headers: {
        "content-type": "application/json",
        host: new URL(origin).host,
        origin,
      },
      method: "POST",
    }),
    {
      authorize: async () => ({}),
      importQuestionSet: async () => {
        importCalls += 1;
        return { id: "set", name: "Set", questionCount: 1, version: 1 };
      },
    },
  );
  assert.equal(oversized.status, 413);
  assert.equal(importCalls, 1);

  for (const [code, status, body] of [
    ["invalid-request", 400, { error: "invalid-request" }],
    ["already-exists", 409, { error: "already-exists" }],
    ["source-mismatch", 422, { error: "source-mismatch" }],
  ] as const) {
    const rejected = await handleQuestionSetImportRequest(
      post("/admin/quality/import", validQuestionSetFixture),
      {
        authorize: async () => ({}),
        importQuestionSet: async () => {
          throw new QuestionSetImportError(code);
        },
      },
    );
    assert.equal(rejected.status, status);
    assert.deepEqual(await rejected.json(), body);
  }
});

test("authorization failures propagate before parsing or quality work", async () => {
  const unauthorized = new Error("redirect-to-login");
  let runCalls = 0;
  await assert.rejects(
    handleQualityRunRequest(post("/admin/quality/run", { questionSetId: "set" }), {
      authorize: async () => {
        throw unauthorized;
      },
      run: async () => {
        runCalls += 1;
        return { id: "run", results: validResults };
      },
    }),
    (error: unknown) => error === unauthorized,
  );
  assert.equal(runCalls, 0);
});

test("accepts only the exact serialized request origin", async () => {
  const hostileOrigins = [
    `${origin}/path`,
    `${origin}?workspace=other`,
    `${origin}#fragment`,
    "https://user@quality.example.test",
    "https://QUALITY.example.test",
    "null",
  ];
  let runCalls = 0;
  for (const requestOrigin of hostileOrigins) {
    const response = await handleQualityRunRequest(
      post("/admin/quality/run", { questionSetId: "question_set_one" }, requestOrigin),
      {
        authorize: async () => ({}),
        run: async () => {
          runCalls += 1;
          return { id: "run", results: validResults };
        },
      },
    );
    assert.equal(response.status, 403, requestOrigin);
    assert.deepEqual(await response.json(), { error: "invalid-request" });
  }
  assert.equal(runCalls, 0);

  const accepted = await handleQualityRunRequest(
    post("/admin/quality/run", { questionSetId: "question_set_one" }),
    {
      authorize: async () => ({}),
      run: async (id) => {
        assert.equal(id, "question_set_one");
        return { id: "run_one", results: validResults };
      },
    },
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { runId: "run_one" });
});

test("accepts the public host and protocol behind a reverse proxy", async () => {
  const publicOrigins: readonly Readonly<Record<string, string>>[] = [
    {
      host: "localhost:3300",
      origin: "http://localhost:3300",
    },
    {
      host: "preview.example.test",
      origin: "https://preview.example.test",
      "x-forwarded-proto": "https",
    },
  ];
  for (const headers of publicOrigins) {
    const response = await handleQualityRunRequest(
      new Request("http://0.0.0.0:3000/admin/quality/run", {
        body: JSON.stringify({ questionSetId: "question_set_one" }),
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...headers,
        },
        method: "POST",
      }),
      {
        authorize: async () => ({}),
        run: async () => ({ id: "run_one", results: validResults }),
      },
    );
    assert.equal(response.status, 201);
  }
});

test("rejects proxy origin metadata that does not match the public request", async () => {
  const inconsistentOrigins: readonly Readonly<Record<string, string>>[] = [
    {
      host: "preview.example.test",
      origin: "https://hostile.example.test",
      "x-forwarded-host": "hostile.example.test",
      "x-forwarded-proto": "https",
    },
    {
      host: "preview.example.test",
      origin: "http://preview.example.test",
      "x-forwarded-proto": "https",
    },
    {
      host: "preview.example.test",
      origin: "https://preview.example.test",
      "x-forwarded-proto": "https,http",
    },
  ];
  for (const headers of inconsistentOrigins) {
    const response = await handleQualityRunRequest(
      new Request("http://0.0.0.0:3000/admin/quality/run", {
        body: JSON.stringify({ questionSetId: "question_set_one" }),
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...headers,
        },
        method: "POST",
      }),
      {
        authorize: async () => ({}),
        run: async () => ({ id: "run_one", results: validResults }),
      },
    );
    assert.equal(response.status, 403);
  }
});

test("rejects extra workspace fields, oversized bodies, and exhausted allowance", async () => {
  let runCalls = 0;
  for (const request of [
    post("/admin/quality/run", {
      questionSetId: "question_set_one",
      workspaceId: "workspace_other",
    }),
    new Request(`${origin}/admin/quality/run`, {
      body: JSON.stringify({ questionSetId: "x".repeat(maximumQualityRequestUtf8Bytes) }),
      headers: {
        "content-type": "application/json",
        host: new URL(origin).host,
        origin,
      },
      method: "POST",
    }),
  ]) {
    const response = await handleQualityRunRequest(request, {
      authorize: async () => ({}),
      run: async () => {
        runCalls += 1;
        return { id: "run", results: validResults };
      },
    });
    assert.ok(response.status === 400 || response.status === 413);
  }

  const limited = await handleQualityRunRequest(
    post("/admin/quality/run", { questionSetId: "question_set_one" }),
    {
      authorize: async () => ({}),
      consumeAllowance: async () => ({
        accepted: false,
        retryAfterSeconds: 12,
      }),
      run: async () => {
        runCalls += 1;
        return { id: "run", results: validResults };
      },
    },
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "12");
  assert.equal(runCalls, 0);
});

test("playground returns explicit preflight fields and redacts runtime failures", async () => {
  const result = {
    answer: "Use settings.",
    citations: ["chunk_generation"],
    generation: { model: "answer-v1", provider: "openai-compatible" },
    outcome: "answer" as const,
    preflightTrace: [
      {
        articleContentHash: "a".repeat(64),
        articleId: "article_setup",
        canonicalUrl: "https://help.example.test/setup",
        contentHash: "b".repeat(64),
        excerpt: "Use settings.",
        headingPath: ["Setup"],
        indexGeneration: 4,
        mode: "lexical" as const,
        ordinal: 0,
        score: 0.91,
        sourceId: "chunk_preflight",
        sourceLineRange: { end: 2, start: 1 },
        title: "Setup",
      },
    ],
    question: "How do I configure it?",
    reason: null,
  };
  const response = await handleQualityPlaygroundRequest(
    post("/admin/quality/playground", { question: result.question }),
    {
      authorize: async () => ({}),
      run: async () => result,
    },
  );
  assert.deepEqual(await response.json(), { result });

  const failed = await handleQualityPlaygroundRequest(
    post("/admin/quality/playground", { question: result.question }),
    {
      authorize: async () => ({}),
      run: async () => {
        throw new Error("provider secret sk-private and raw response");
      },
    },
  );
  const body = await failed.text();
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(body), { error: "unavailable" });
  assert.doesNotMatch(body, /provider|secret|sk-private|raw response/u);
});

test("retained replay authorizes first and accepts only a server-scoped conversation ID", async () => {
  const conversationId = "123e4567-e89b-42d3-a456-426614174000";
  const result = {
    answer: "Use the retained excerpt.",
    citations: [{ id: "C1", sourceId: "chunk_setup" }],
    generation: { model: "answer-v1", provider: "openai-compatible" },
    outcome: "answer" as const,
    question: "How do I configure it?",
    reason: null,
  };
  const unauthorized = new Error("redirect-to-login");
  let runCalls = 0;
  await assert.rejects(
    handleQualityReplayRequest(
      post("/admin/quality/replay", { conversationId }),
      {
        authorize: async () => {
          throw unauthorized;
        },
        run: async () => {
          runCalls += 1;
          return result;
        },
      },
    ),
    (error: unknown) => error === unauthorized,
  );

  const response = await handleQualityReplayRequest(
    post("/admin/quality/replay", { conversationId }),
    {
      authorize: async () => ({}),
      run: async (id) => {
        runCalls += 1;
        assert.equal(id, conversationId);
        return result;
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result });

  for (const request of [
    post("/admin/quality/replay", {
      conversationId,
      workspaceId: "workspace_other",
    }),
    post("/admin/quality/replay", { conversationId }, "https://hostile.test"),
  ]) {
    const rejected = await handleQualityReplayRequest(request, {
      authorize: async () => ({}),
      run: async () => {
        runCalls += 1;
        return result;
      },
    });
    assert.ok(rejected.status === 400 || rejected.status === 403);
  }
  assert.equal(runCalls, 1);
});

test("retained replay maps expired, insufficient, and provider failures without details", async () => {
  const conversationId = "123e4567-e89b-42d3-a456-426614174000";
  for (const [code, status] of [
    ["not-found", 404],
    ["not-ready", 409],
    ["unavailable", 503],
  ] as const) {
    const response = await handleQualityReplayRequest(
      post("/admin/quality/replay", { conversationId }),
      {
        authorize: async () => ({}),
        run: async () => {
          throw new QualityConsoleError(code);
        },
      },
    );
    const body = await response.text();
    assert.equal(response.status, status);
    assert.doesNotMatch(body, /provider|credential|workspace_current/u);
  }
});

test("exports only server-selected kinds with safe attachment headers", async () => {
  const calls: string[] = [];
  const response = await handleQualityExportRequest(
    new Request(`${origin}/admin/quality/export?kind=conversations`),
    {
      authorize: async () => ({}),
      exportCsv: async (kind) => {
        calls.push(kind);
        return '"conversation_id"\r\n';
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["conversations"]);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="opas-redacted-conversations.csv"',
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

  const rejected = await handleQualityExportRequest(
    new Request(`${origin}/admin/quality/export?kind=conversations&workspace=other`),
    {
      authorize: async () => ({}),
      exportCsv: async () => "safe",
    },
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid-request" });
});
