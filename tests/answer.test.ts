// ABOUTME: Verifies grounded answer decisions, citation authority, and bounded streaming output.
// ABOUTME: Proves weak, conflicting, malformed, and unsafe provider responses fail closed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AnswerError,
  createAnswerService,
  maximumAnswerHistoryMessages,
  maximumAnswerQuestionCodePoints,
  type AnswerEvent,
  type AnswerRetriever,
} from "@/answers/answer";
import {
  AnswerAdmissionError,
  type AnswerInferenceAdmission,
  type AnswerInferenceOutcome,
} from "@/answers/admission";
import {
  createGenerationFallbackAdapter,
  GenerationError,
  type GenerationAdapter,
  type GenerationEvent,
  type GenerationRequest,
} from "@/ai/generation";
import type { EvidenceRetrievalResult } from "@/search/evidence";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function evidence(
  overrides: Partial<EvidenceRetrievalResult> = {},
): EvidenceRetrievalResult {
  return {
    articleContentHash: hashA,
    articleId: "article-password",
    canonicalUrl: "https://help.example.test/account/reset-password",
    chunkId: "chunk-password-reset",
    contentHash: hashB,
    evidenceText: "Open Account settings and choose Reset password.",
    headingPath: ["Account", "Password"],
    indexGeneration: 7,
    markdown: "## Password\n\nOpen Account settings and choose Reset password.",
    mode: "hybrid",
    ordinal: 1,
    score: 0.91,
    sourceId: "chunk-password-reset",
    sourceLineRange: { end: 8, start: 5 },
    title: "Reset your password",
    workspaceId: "workspace-demo",
    ...overrides,
  };
}

function generator(
  run: (request: GenerationRequest) => AsyncIterable<GenerationEvent>,
): GenerationAdapter {
  return {
    limits: {
      maximumInputUtf8Bytes: 65_536,
      maximumMessages: 16,
      maximumOutputTokens: 1_024,
      maximumOutputUtf8Bytes: 65_536,
      timeoutMilliseconds: 30_000,
    },
    metadata: {
      model: "fixture-answer-model",
      provider: "openai-compatible",
      retentionDisclosure: "Fixture requests are not retained.",
    },
    stream: run,
  };
}

async function* providerEvents(
  textParts: readonly string[],
): AsyncIterable<GenerationEvent> {
  for (const text of textParts) {
    yield { text, type: "text" };
  }
  yield {
    reason: "stop",
    type: "finish",
    usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
  };
}

async function collect(stream: AsyncIterable<AnswerEvent>) {
  const events: AnswerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function answerService(
  results: readonly EvidenceRetrievalResult[],
  run: (request: GenerationRequest) => AsyncIterable<GenerationEvent>,
  onRetrieve?: (request: Parameters<AnswerRetriever>[0]) => void,
  admission?: AnswerInferenceAdmission,
) {
  const retriever: AnswerRetriever = async (request) => {
    onRetrieve?.(request);
    return results;
  };
  return createAnswerService({
    admission,
    evidencePolicy: {
      minimumScore: 0.7,
      minimumScoreGapAcrossArticles: 0.05,
    },
    generation: generator(run),
    retriever,
  });
}

function admissionFixture() {
  const reservations: Array<{
    maximumOutputTokens: number;
    model: string;
    provider: string;
    workspaceId: string;
  }> = [];
  const settlements: Array<{
    outcome: AnswerInferenceOutcome;
    usage?: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
  }> = [];
  const admission: AnswerInferenceAdmission = {
    async reserve(request) {
      reservations.push(request);
      return {
        lease: {
          id: "answer-lease-stream",
          workspaceId: request.workspaceId,
          provider: request.provider,
          model: request.model,
          maximumOutputTokens: request.maximumOutputTokens,
          reservedMicrodollars: 100,
          chargedMicrodollars: null,
          status: "active",
          inputTokens: null,
          outputTokens: null,
          startedAt: new Date("2026-08-30T12:00:00.000Z"),
          expiresAt: new Date("2026-08-30T12:01:00.000Z"),
          reconciledAt: null,
        },
        async reconcile(settlement) {
          settlements.push(settlement);
          return {
            id: "answer-lease-stream",
            workspaceId: request.workspaceId,
            provider: request.provider,
            model: request.model,
            maximumOutputTokens: request.maximumOutputTokens,
            reservedMicrodollars: 100,
            chargedMicrodollars: 10,
            status: settlement.outcome,
            inputTokens: settlement.usage?.inputTokens ?? null,
            outputTokens: settlement.usage?.outputTokens ?? null,
            startedAt: new Date("2026-08-30T12:00:00.000Z"),
            expiresAt: new Date("2026-08-30T12:01:00.000Z"),
            reconciledAt: new Date("2026-08-30T12:00:01.000Z"),
          };
        },
      };
    },
  };
  return { admission, reservations, settlements };
}

test("streams safe answer blocks and maps opaque IDs to canonical retrieved metadata", async () => {
  const retrieved = evidence();
  const controller = new AbortController();
  const generationRequests: GenerationRequest[] = [];
  const retrievalRequests: Parameters<AnswerRetriever>[0][] = [];
  const service = answerService(
    [retrieved],
    (request) => {
      generationRequests.push(request);
      return providerEvents([
        '{"type":"content","markdown":"Open **Account settings**."}\n{"type":"cita',
        'tion","id":"C1"}\n',
      ]);
    },
    (request) => retrievalRequests.push(request),
  );

  const events = await collect(
    service.stream({
      history: [
        { content: "I cannot sign in.", role: "user" },
        { content: "I can help with account access.", role: "assistant" },
      ],
      maximumOutputTokens: 256,
      question: "How do I reset my password?",
      signal: controller.signal,
      workspaceId: "workspace-demo",
    }),
  );

  assert.deepEqual(retrievalRequests, [
    {
      query: "How do I reset my password?",
      signal: controller.signal,
      topK: 5,
      workspaceId: "workspace-demo",
    },
  ]);
  assert.equal(generationRequests.length, 1);
  assert.equal(generationRequests[0]?.signal, controller.signal);
  assert.equal(generationRequests[0]?.maximumOutputTokens, 256);
  const prompt = generationRequests[0]?.messages
    .map(({ content }) => content)
    .join("\n") ?? "";
  assert.match(prompt, /"citationId":"C1"/u);
  assert.match(prompt, /Reset password/u);
  assert.match(prompt, /exactly one supplied citation/u);
  assert.match(prompt, /"type":"abstention"/u);
  assert.match(prompt, /"reason":"insufficient-evidence"/u);
  assert.match(prompt, /Never put citation IDs/u);
  assert.doesNotMatch(prompt, /help\.example\.test/u);
  assert.doesNotMatch(prompt, /chunk-password-reset/u);
  assert.doesNotMatch(prompt, new RegExp(hashA, "u"));
  assert.deepEqual(events, [
    { markdown: "Open **Account settings**.", type: "content" },
    {
      citation: {
        articleContentHash: hashA,
        articleId: "article-password",
        canonicalUrl: "https://help.example.test/account/reset-password",
        contentHash: hashB,
        headingPath: ["Account", "Password"],
        id: "C1",
        sourceId: "chunk-password-reset",
        sourceLineRange: { end: 8, start: 5 },
        title: "Reset your password",
      },
      type: "citation",
    },
    {
      reason: "stop",
      type: "finish",
      usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
    },
  ]);
  assert.ok(events.every(Object.isFrozen));
  assert.ok(Object.isFrozen(events[1]?.type === "citation" && events[1].citation));
});

test("returns a provider-usage-bearing abstention when evidence cannot answer", async () => {
  const fixture = admissionFixture();
  const service = answerService(
    [evidence()],
    () =>
      providerEvents([
        '{"type":"abstention","reason":"insufficient-evidence"}\n',
      ]),
    undefined,
    fixture.admission,
  );

  assert.deepEqual(
    await collect(
      service.stream({
        question: "Is telephone support available on weekends?",
        workspaceId: "workspace-demo",
      }),
    ),
    [
      {
        message: "I couldn’t find enough published information to answer that.",
        reason: "insufficient-evidence",
        type: "abstention",
        usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
      },
    ],
  );
  assert.deepEqual(fixture.settlements, [
    {
      outcome: "completed",
      usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
    },
  ]);
});

test("rejects malformed generated abstentions without exposing partial output", async (context) => {
  for (const output of [
    '{"type":"abstention","reason":"unsafe-request"}\n',
    '{"type":"abstention","reason":"insufficient-evidence"}\n{"type":"content","markdown":"Trailing output."}\n',
    '{"type":"content","markdown":"Partial answer."}\n{"type":"abstention","reason":"insufficient-evidence"}\n',
  ]) {
    await context.test(output.slice(0, 48), async () => {
      const emitted: AnswerEvent[] = [];
      const service = answerService([evidence()], () => providerEvents([output]));
      await assert.rejects(async () => {
        for await (const event of service.stream({
          question: "Is telephone support available on weekends?",
          workspaceId: "workspace-demo",
        })) {
          emitted.push(event);
        }
      });
      assert.deepEqual(emitted, []);
    });
  }
});

test("frames adjacent complete JSON objects from Workers AI without weakening validation", async () => {
  const output =
    JSON.stringify({
      markdown: 'Use `{account}` and say "done".',
      type: "content",
    }) + JSON.stringify({ id: "C1", type: "citation" });
  const service = answerService([evidence()], () =>
    providerEvents([output.slice(0, 47), output.slice(47)]),
  );

  assert.deepEqual(
    await collect(
      service.stream({
        question: "How do I reset my password?",
        workspaceId: "workspace-demo",
      }),
    ),
    [
      { markdown: 'Use `{account}` and say "done".', type: "content" },
      {
        citation: {
          articleContentHash: hashA,
          articleId: "article-password",
          canonicalUrl: "https://help.example.test/account/reset-password",
          contentHash: hashB,
          headingPath: ["Account", "Password"],
          id: "C1",
          sourceId: "chunk-password-reset",
          sourceLineRange: { end: 8, start: 5 },
          title: "Reset your password",
        },
        type: "citation",
      },
      {
        reason: "stop",
        type: "finish",
        usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
      },
    ],
  );
});

test("abstains before generation when retrieved evidence is weak", async () => {
  const fixture = admissionFixture();
  let providerCalls = 0;
  const service = answerService(
    [evidence({ score: 0.69 })],
    () => {
      providerCalls += 1;
      return providerEvents([]);
    },
    undefined,
    fixture.admission,
  );

  assert.deepEqual(
    await collect(
      service.stream({
        question: "Where is the billing export?",
        workspaceId: "workspace-demo",
      }),
    ),
    [
      {
        message: "I couldn’t find enough published information to answer that.",
        reason: "insufficient-evidence",
        type: "abstention",
      },
    ],
  );
  assert.equal(providerCalls, 0);
  assert.equal(fixture.reservations.length, 0);
});

test("abstains before generation when distinct current articles compete inside the calibrated gap", async () => {
  let providerCalls = 0;
  const service = answerService(
    [
      evidence({ articleId: "article-current-a", score: 0.91 }),
      evidence({
        articleContentHash: hashC,
        articleId: "article-current-b",
        canonicalUrl: "https://help.example.test/security/password-policy",
        chunkId: "chunk-password-conflict",
        contentHash: hashC,
        score: 0.88,
        sourceId: "chunk-password-conflict",
      }),
    ],
    () => {
      providerCalls += 1;
      return providerEvents([]);
    },
  );

  assert.deepEqual(
    await collect(
      service.stream({
        question: "Which password policy applies?",
        workspaceId: "workspace-demo",
      }),
    ),
    [
      {
        message:
          "The published information is conflicting, so I can’t give a reliable answer.",
        reason: "conflicting-evidence",
        type: "abstention",
      },
    ],
  );
  assert.equal(providerCalls, 0);
});

test("does not mistake multiple supporting chunks in one current article for a conflict", async () => {
  let providerCalls = 0;
  const service = answerService(
    [
      evidence({ score: 0.91 }),
      evidence({
        chunkId: "chunk-password-confirmation",
        contentHash: hashC,
        ordinal: 2,
        score: 0.9,
        sourceId: "chunk-password-confirmation",
      }),
    ],
    () => {
      providerCalls += 1;
      return providerEvents([
        '{"type":"content","markdown":"Use Account settings."}\n',
        '{"type":"citation","id":"C1"}\n',
      ]);
    },
  );

  await collect(
    service.stream({
      question: "How do I reset my password?",
      workspaceId: "workspace-demo",
    }),
  );
  assert.equal(providerCalls, 1);
});

test("rejects unknown citation IDs instead of turning them into displayed sources", async () => {
  const service = answerService([evidence()], () =>
    providerEvents([
      '{"type":"content","markdown":"Use Account settings."}\n',
      '{"type":"citation","id":"invented-source"}\n',
    ]),
  );
  const emitted: AnswerEvent[] = [];

  await assert.rejects(
    async () => {
      for await (const event of service.stream({
        question: "How do I reset my password?",
        workspaceId: "workspace-demo",
      })) {
        emitted.push(event);
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof AnswerError);
      assert.equal(error.category, "invalid-output");
      return true;
    },
  );
  assert.deepEqual(emitted, []);
});

for (const [name, unsafeMarkdown] of [
  ["raw HTML", '<img src=x onerror="alert(1)">'],
  ["a JavaScript link", "[open](javascript:alert(1))"],
  ["an HTTPS model-owned link", "[untrusted](https://evil.example.test)"],
  ["an image", "![tracking](https://evil.example.test/pixel.png)"],
] as const) {
  test(`rejects ${name} in streamed model content`, async () => {
    const service = answerService([evidence()], () =>
      providerEvents([
        `${JSON.stringify({ markdown: unsafeMarkdown, type: "content" })}\n`,
        '{"type":"citation","id":"C1"}\n',
      ]),
    );

    await assert.rejects(
      () =>
        collect(
          service.stream({
            question: "How do I reset my password?",
            workspaceId: "workspace-demo",
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AnswerError);
        assert.equal(error.category, "unsafe-output");
        return true;
      },
    );
  });
}

test("rejects malformed records, extra model-owned fields, and answers without citations", async (context) => {
  const cases = [
    "not json\n",
    '{"type":"citation","id":"C1","url":"https://evil.example.test"}\n',
    '{"type":"content","markdown":"No citation follows."}\n',
  ];
  for (const output of cases) {
    await context.test(output.slice(0, 32), async () => {
      const service = answerService([evidence()], () => providerEvents([output]));
      await assert.rejects(
        () =>
          collect(
            service.stream({
              question: "How do I reset my password?",
              workspaceId: "workspace-demo",
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof AnswerError);
          assert.equal(error.category, "invalid-output");
          return true;
        },
      );
    });
  }
});

test("does not expose uncited content when the provider finishes without a citation", async () => {
  const service = answerService([evidence()], () =>
    providerEvents([
      '{"type":"content","markdown":"This must remain buffered."}\n',
    ]),
  );
  const emitted: AnswerEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of service.stream({
      question: "How do I reset my password?",
      workspaceId: "workspace-demo",
    })) {
      emitted.push(event);
    }
  });
  assert.deepEqual(emitted, []);
});

test("enforces question and history bounds before retrieval or generation", async (context) => {
  let retrievalCalls = 0;
  let providerCalls = 0;
  const service = answerService(
    [evidence()],
    () => {
      providerCalls += 1;
      return providerEvents([]);
    },
    () => {
      retrievalCalls += 1;
    },
  );
  const cases = [
    {
      history: undefined,
      question: "q".repeat(maximumAnswerQuestionCodePoints + 1),
    },
    {
      history: Array.from(
        { length: maximumAnswerHistoryMessages + 1 },
        (_, index) => ({ content: `Question ${index}`, role: "user" as const }),
      ),
      question: "Reset password",
    },
    {
      history: [{ content: "h".repeat(2_049), role: "user" as const }],
      question: "Reset password",
    },
    {
      history: undefined,
      maximumOutputTokens: 1_025,
      question: "Reset password",
    },
  ];

  for (const request of cases) {
    await context.test(String(request.question.length), async () => {
      await assert.rejects(
        () =>
          collect(
            service.stream({
              ...request,
              workspaceId: "workspace-demo",
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof AnswerError);
          assert.equal(error.category, "invalid-input");
          return true;
        },
      );
    });
  }
  assert.equal(retrievalCalls, 0);
  assert.equal(providerCalls, 0);
});

test("fails closed on invalid canonical evidence before provider invocation", async () => {
  let providerCalls = 0;
  const service = answerService(
    [evidence({ canonicalUrl: "javascript:alert(1)" })],
    () => {
      providerCalls += 1;
      return providerEvents([]);
    },
  );

  await assert.rejects(
    () =>
      collect(
        service.stream({
          question: "How do I reset my password?",
          workspaceId: "workspace-demo",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AnswerError);
      assert.equal(error.category, "invalid-evidence");
      return true;
    },
  );
  assert.equal(providerCalls, 0);
});

test("bounds retrieved context and streamed provider output", async (context) => {
  await context.test("oversized evidence", async () => {
    let providerCalls = 0;
    const service = answerService(
      [evidence({ evidenceText: "e".repeat(4_097) })],
      () => {
        providerCalls += 1;
        return providerEvents([]);
      },
    );
    await assert.rejects(
      () =>
        collect(
          service.stream({
            question: "How do I reset my password?",
            workspaceId: "workspace-demo",
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AnswerError);
        assert.equal(error.category, "invalid-evidence");
        return true;
      },
    );
    assert.equal(providerCalls, 0);
  });

  await context.test("oversized generation stream", async () => {
    const service = answerService([evidence()], () =>
      providerEvents(["x".repeat(32_769)]),
    );
    await assert.rejects(
      () =>
        collect(
          service.stream({
            question: "How do I reset my password?",
            workspaceId: "workspace-demo",
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AnswerError);
        assert.equal(error.category, "output-limit");
        return true;
      },
    );
  });
});

test("preserves the caller signal and exact provider failure", async () => {
  const failure = new GenerationError(
    "provider-unavailable",
    "Generation provider request failed",
  );
  const controller = new AbortController();
  const service = answerService([evidence()], async function* (request) {
    assert.equal(request.signal, controller.signal);
    throw failure;
  });

  await assert.rejects(
    () =>
      collect(
        service.stream({
          question: "How do I reset my password?",
          signal: controller.signal,
          workspaceId: "workspace-demo",
        }),
      ),
    (error: unknown) => error === failure,
  );
});

test("reserves before provider inference and reconciles usage before finish", async () => {
  const fixture = admissionFixture();
  let providerCalls = 0;
  const service = answerService(
    [evidence()],
    () => {
      providerCalls += 1;
      assert.equal(fixture.reservations.length, 1);
      return providerEvents([
        '{"type":"content","markdown":"Open settings."}\n' +
          '{"type":"citation","id":"C1"}\n',
      ]);
    },
    undefined,
    fixture.admission,
  );

  const events = await collect(
    service.stream({
      maximumOutputTokens: 256,
      question: "How do I reset my password?",
      workspaceId: "workspace-demo",
    }),
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(fixture.reservations, [
    {
      maximumOutputTokens: 256,
      model: "fixture-answer-model",
      provider: "openai-compatible",
      workspaceId: "workspace-demo",
    },
  ]);
  assert.deepEqual(fixture.settlements, [
    {
      outcome: "completed",
      usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
    },
  ]);
  assert.equal(events.at(-1)?.type, "finish");
});

test("cross-provider fallback stays inside one reservation and one reconciliation", async () => {
  const fixture = admissionFixture();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const observedProviders: Array<{ model: string; provider: string }> = [];
  const primary: GenerationAdapter = {
    ...generator(() =>
      (async function* () {
        primaryCalls += 1;
        throw new GenerationError(
          "provider-unavailable",
          "Primary provider unavailable",
        );
      })(),
    ),
    metadata: {
      model: "workers-primary-v1",
      provider: "cloudflare-workers-ai",
      retentionDisclosure: "Primary requests are not retained.",
    },
  };
  const fallback = generator(() => {
    fallbackCalls += 1;
    return providerEvents([
      '{"type":"content","markdown":"Open settings."}\n' +
        '{"type":"citation","id":"C1"}\n',
    ]);
  });
  const generation = createGenerationFallbackAdapter({ fallback, primary });
  const service = createAnswerService({
    admission: fixture.admission,
    evidencePolicy: {
      minimumScore: 0.7,
      minimumScoreGapAcrossArticles: 0.05,
    },
    generation,
    retriever: async () => [evidence()],
  });

  const events = await collect(
    service.stream({
      maximumOutputTokens: 256,
      observeProvider(metadata) {
        observedProviders.push(metadata);
        throw new Error("Observer failures are contained");
      },
      question: "How do I reset my password?",
      workspaceId: "workspace-demo",
    }),
  );

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(observedProviders, [
    { model: "workers-primary-v1", provider: "cloudflare-workers-ai" },
    { model: "fixture-answer-model", provider: "openai-compatible" },
  ]);
  assert.ok(observedProviders.every(Object.isFrozen));
  assert.deepEqual(fixture.reservations, [
    {
      maximumOutputTokens: 256,
      model: "workers-primary-v1",
      provider: "cloudflare-workers-ai",
      workspaceId: "workspace-demo",
    },
  ]);
  assert.deepEqual(fixture.settlements, [
    {
      generation: {
        model: "fixture-answer-model",
        provider: "openai-compatible",
      },
      outcome: "completed",
      usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
    },
  ]);
  assert.equal(events.at(-1)?.type, "finish");
  assert.match(generation.metadata.retentionDisclosure, /openai-compatible/u);
});

test("reconciles cancellation, timeout, invalid output, and provider failure once", async (context) => {
  await context.test("cancellation", async () => {
    const fixture = admissionFixture();
    const controller = new AbortController();
    const service = answerService(
      [evidence()],
      async function* (request) {
        yield {
          text:
            '{"type":"content","markdown":"Open settings."}\n' +
            '{"type":"citation","id":"C1"}\n',
          type: "text",
        };
        if (request.signal?.aborted) {
          throw new GenerationError("cancelled", "Generation cancelled");
        }
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new GenerationError("cancelled", "Generation cancelled")),
            { once: true },
          );
        });
      },
      undefined,
      fixture.admission,
    );
    const iterator = service
      .stream({
        question: "How do I reset my password?",
        signal: controller.signal,
        workspaceId: "workspace-demo",
      })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "content");
    assert.equal((await iterator.next()).value?.type, "citation");
    controller.abort();
    await assert.rejects(iterator.next(), /cancelled/u);
    assert.deepEqual(fixture.settlements, [
      { outcome: "cancelled", usage: undefined },
    ]);
  });

  for (const fixtureCase of [
    {
      name: "timeout",
      error: new GenerationError("timeout", "Generation timed out"),
      outcome: "timeout" as const,
    },
    {
      name: "provider failure",
      error: new GenerationError(
        "provider-unavailable",
        "Generation provider unavailable",
      ),
      outcome: "failed" as const,
    },
  ]) {
    await context.test(fixtureCase.name, async () => {
      const fixture = admissionFixture();
      let providerCalls = 0;
      const service = answerService(
        [evidence()],
        async function* () {
          providerCalls += 1;
          throw fixtureCase.error;
        },
        undefined,
        fixture.admission,
      );
      await assert.rejects(
        collect(
          service.stream({
            question: "How do I reset my password?",
            workspaceId: "workspace-demo",
          }),
        ),
        (error) => error === fixtureCase.error,
      );
      assert.equal(providerCalls, 1);
      assert.equal(fixture.reservations.length, 1);
      assert.deepEqual(fixture.settlements, [
        { outcome: fixtureCase.outcome, usage: undefined },
      ]);
    });
  }

  await context.test("invalid output after provider finish", async () => {
    const fixture = admissionFixture();
    const service = answerService(
      [evidence()],
      () => providerEvents(['{"type":"content","markdown":"Uncited."}\n']),
      undefined,
      fixture.admission,
    );
    await assert.rejects(
      collect(
        service.stream({
          question: "How do I reset my password?",
          workspaceId: "workspace-demo",
        }),
      ),
      (error) => error instanceof AnswerError && error.category === "invalid-output",
    );
    assert.deepEqual(fixture.settlements, [
      {
        outcome: "invalid-output",
        usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
      },
    ]);
  });

  await context.test("provider output after finish", async () => {
    const fixture = admissionFixture();
    const service = answerService(
      [evidence()],
      async function* () {
        yield {
          text:
            '{"type":"content","markdown":"Open settings."}\n' +
            '{"type":"citation","id":"C1"}\n',
          type: "text",
        };
        yield {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
        };
        yield { text: "unexpected", type: "text" };
      },
      undefined,
      fixture.admission,
    );

    await assert.rejects(
      collect(
        service.stream({
          question: "How do I reset my password?",
          workspaceId: "workspace-demo",
        }),
      ),
      (error) => error instanceof AnswerError && error.category === "invalid-output",
    );
    assert.deepEqual(fixture.settlements, [
      {
        outcome: "invalid-output",
        usage: { inputTokens: 42, outputTokens: 11, totalTokens: 53 },
      },
    ]);
  });
});

test("admission denial never reaches the configured provider", async () => {
  let providerCalls = 0;
  const service = answerService(
    [evidence()],
    () => {
      providerCalls += 1;
      return providerEvents([]);
    },
    undefined,
    {
      async reserve() {
        throw new AnswerAdmissionError("denied");
      },
    },
  );

  await assert.rejects(
    collect(
      service.stream({
        question: "How do I reset my password?",
        workspaceId: "workspace-demo",
      }),
    ),
    (error) =>
      error instanceof AnswerAdmissionError && error.category === "denied",
  );
  assert.equal(providerCalls, 0);
});
