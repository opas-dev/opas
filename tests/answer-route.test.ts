// ABOUTME: Verifies the bounded streaming HTTP contract for grounded answers.
// ABOUTME: Proves malformed input and provider failures cannot leak untrusted or private data.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiCompatibleGenerationAdapter,
  createWorkersAiGenerationAdapter,
  GenerationError,
  type GenerationAdapter,
  type GenerationEvent,
} from "@/ai/generation";
import { generationPublicMetadata } from "@/ai/generation-config";
import {
  handleAnswerRequest,
  maximumAnswerRequestUtf8Bytes,
} from "@/answers/answer-route";
import { createAnswerService, type AnswerRetriever } from "@/answers/answer";
import type { AnswerRuntime } from "@/answers/answer-runtime";
import type { EvidenceRetrievalResult } from "@/search/evidence";

const answerUrl = "https://help.example.test/api/answers";
const privateValue = "private-provider-key-and-prompt";
const articleHash = "a".repeat(64);
const chunkHash = "b".repeat(64);
const conversationId = "123e4567-e89b-42d3-a456-426614174000";
const safeProviderOutput =
  '{"type":"content","markdown":"Open **Account settings**."}\n' +
  '{"type":"citation","id":"C1"}\n';

function sse(parts: readonly string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function evidence(): EvidenceRetrievalResult {
  return {
    articleContentHash: articleHash,
    articleId: "article-password-reset",
    canonicalUrl: "https://help.example.test/account/reset-password",
    chunkId: "chunk-password-reset",
    contentHash: chunkHash,
    evidenceText: "Open Account settings and choose Reset password.",
    headingPath: ["Account", "Password"],
    indexGeneration: 7,
    markdown: "## Password\n\nOpen Account settings and choose Reset password.",
    mode: "lexical",
    ordinal: 0,
    score: 0.91,
    sourceId: "chunk-password-reset",
    sourceLineRange: { end: 5, start: 3 },
    title: "Reset your password",
    workspaceId: "workspace_demo",
  };
}

function runtime(
  generation: GenerationAdapter,
  retriever: AnswerRetriever = async () => [evidence()],
): AnswerRuntime {
  return Object.freeze({
    metadata: generationPublicMetadata(generation),
    service: createAnswerService({
      evidencePolicy: {
        minimumScore: 0.7,
        minimumScoreGapAcrossArticles: 0.05,
      },
      generation,
      retriever,
    }),
  });
}

function fixtureGeneration(
  events: (request: Parameters<GenerationAdapter["stream"]>[0]) =>
    AsyncIterable<GenerationEvent>,
): GenerationAdapter {
  return {
    limits: {
      maximumInputUtf8Bytes: 65_536,
      maximumMessages: 16,
      maximumOutputTokens: 1_024,
      maximumOutputUtf8Bytes: 65_536,
      timeoutMilliseconds: 30_000,
    },
    metadata: Object.freeze({
      model: "fixture-answer-v1",
      provider: "openai-compatible",
      retentionDisclosure: "Fixture requests are not retained.",
    }),
    stream: events,
  };
}

function outputGeneration(parts: readonly string[]) {
  return fixtureGeneration(() =>
    (async function* (): AsyncIterable<GenerationEvent> {
      for (const text of parts) yield { text, type: "text" };
      yield {
        reason: "stop",
        type: "finish",
        usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32 },
      };
    })(),
  );
}

function answerRequest(
  body: BodyInit = JSON.stringify({
    history: [{ content: "I cannot sign in.", role: "user" }],
    question: "How do I reset my password?",
  }),
  headers: HeadersInit = { "content-type": "application/json; charset=utf-8" },
  signal?: AbortSignal,
) {
  return new Request(answerUrl, {
    body,
    headers,
    method: "POST",
    signal,
  });
}

async function records(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function completeRecordChunks(response: Response) {
  const reader = response.body!.getReader();
  const parsed: Record<string, unknown>[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = new TextDecoder("utf-8", { fatal: true }).decode(result.value);
    assert.ok(chunk.endsWith("\n"));
    assert.equal(chunk.slice(0, -1).includes("\n"), false);
    parsed.push(JSON.parse(chunk) as Record<string, unknown>);
  }
  return parsed;
}

test("starts the analytics clock before admission and runtime construction", async () => {
  const requestStartedAt = new Date("2026-08-30T12:00:00.000Z");
  const order: string[] = [];
  let recorderStartedAt: Date | undefined;
  const response = await handleAnswerRequest(answerRequest(), {
    consumeAllowance: async () => {
      order.push("allowance");
      return { accepted: true };
    },
    createConversationId: () => conversationId,
    createRecorder(options) {
      order.push("recorder");
      recorderStartedAt = options.startedAt;
      return Object.freeze({
        abandon: async () => {},
        observeEvent: async () => {},
        observeProvider: () => {},
        observeRetrieval: () => {},
      });
    },
    createRuntime: async () => {
      order.push("runtime");
      return runtime(outputGeneration([safeProviderOutput]));
    },
    now: () => {
      order.push("clock");
      return requestStartedAt;
    },
  });

  await response.text();
  assert.deepEqual(order, ["clock", "allowance", "runtime", "recorder"]);
  assert.equal(recorderStartedAt, requestStartedAt);
});

test("Cloudflare and OpenAI-compatible fixtures expose the same NDJSON answer contract", async (context) => {
  const workersCalls: unknown[][] = [];
  const fixtures: Array<{ name: string; generation: GenerationAdapter }> = [
    {
      name: "cloudflare-workers-ai",
      generation: createWorkersAiGenerationAdapter({
        binding: {
          async run(...parameters: readonly unknown[]) {
            workersCalls.push([...parameters]);
            return sse([
              `data: ${JSON.stringify({
                response: safeProviderOutput,
                finish_reason: "stop",
                usage: {
                  prompt_tokens: 24,
                  completion_tokens: 8,
                  total_tokens: 32,
                },
              })}\n\n`,
              "data: [DONE]\n\n",
            ]);
          },
        } as never,
        gatewayId: "opas-answers",
        model: "@cf/meta/llama-3.1-8b-instruct-fp8",
        retentionDisclosure:
          "Cloudflare processes answers transiently; Gateway logs and caching are disabled.",
      }),
    },
    {
      name: "openai-compatible",
      generation: createOpenAiCompatibleGenerationAdapter({
        apiKey: privateValue,
        endpoint: "https://answers.example.test/v1/chat/completions",
        fetch: async () =>
          new Response(
            sse([
              `data: ${JSON.stringify({
                choices: [
                  { delta: { content: safeProviderOutput }, finish_reason: "stop" },
                ],
                usage: {
                  prompt_tokens: 24,
                  completion_tokens: 8,
                  total_tokens: 32,
                },
              })}\n\n`,
              "data: [DONE]\n\n",
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
        model: "fixture-answer-v1",
        retentionDisclosure: "The configured provider retains requests for 30 days.",
      }),
    },
  ];

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const response = await handleAnswerRequest(answerRequest(), {
        createConversationId: () => conversationId,
        createRuntime: async () => runtime(fixture.generation),
      });
      const streamed = await completeRecordChunks(response);

      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "application/x-ndjson; charset=utf-8",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      assert.deepEqual(streamed.slice(1), [
        { markdown: "Open **Account settings**.", type: "content" },
        {
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
        },
        {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32 },
        },
      ]);
      assert.equal(streamed[0]?.type, "metadata");
      assert.equal(streamed[0]?.conversationId, conversationId);
      assert.deepEqual(streamed[0]?.generation, fixture.generation.metadata);
      assert.doesNotMatch(JSON.stringify(streamed), new RegExp(privateValue, "u"));
    });
  }

  assert.deepEqual(
    (workersCalls[0]?.[2] as { gateway: unknown }).gateway,
    { collectLog: false, id: "opas-answers", skipCache: true },
  );
});

test("rejects non-POST, non-JSON, malformed UTF-8, malformed JSON, and unknown fields before runtime creation", async (context) => {
  let runtimeCalls = 0;
  const dependencies = {
    createRuntime: async () => {
      runtimeCalls += 1;
      return runtime(outputGeneration([safeProviderOutput]));
    },
  };
  const fixtures = [
    new Request(answerUrl, { method: "GET" }),
    answerRequest("{}", { "content-type": "text/plain" }),
    answerRequest(new Uint8Array([0xc3, 0x28])),
    answerRequest("{"),
    answerRequest(JSON.stringify({ question: "Help", workspaceId: "other" })),
    answerRequest(JSON.stringify({ conversationId, question: "Help" })),
  ];
  const statuses = [405, 415, 400, 400, 400, 400];

  for (const [index, request] of fixtures.entries()) {
    await context.test(String(statuses[index]), async () => {
      const response = await handleAnswerRequest(request, dependencies);
      assert.equal(response.status, statuses[index]);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    });
  }
  assert.equal(runtimeCalls, 0);
});

test("rejects oversized bodies before JSON parsing and oversized semantic input before retrieval", async () => {
  let retrievalCalls = 0;
  const generation = outputGeneration([safeProviderOutput]);
  const configuredRuntime = runtime(generation, async () => {
    retrievalCalls += 1;
    return [evidence()];
  });
  const oversizedBody = JSON.stringify({
    question: "x".repeat(maximumAnswerRequestUtf8Bytes),
  });
  const bodyResponse = await handleAnswerRequest(answerRequest(oversizedBody), {
    createRuntime: async () => configuredRuntime,
  });
  const semanticResponse = await handleAnswerRequest(
    answerRequest(JSON.stringify({ question: "x".repeat(201) })),
    { createRuntime: async () => configuredRuntime },
  );

  assert.equal(bodyResponse.status, 413);
  assert.equal(semanticResponse.status, 400);
  assert.equal(retrievalCalls, 0);
});

test("fails closed before streaming for malformed, unknown-citation, and XSS provider output", async (context) => {
  for (const output of [
    "not-json\n",
    '{"type":"content","markdown":"Use settings."}\n' +
      '{"type":"citation","id":"unknown"}\n',
    '{"type":"content","markdown":"<img src=x onerror=alert(1)>"}\n' +
      '{"type":"citation","id":"C1"}\n',
  ]) {
    await context.test(output.slice(0, 24), async () => {
      const response = await handleAnswerRequest(answerRequest(), {
        createRuntime: async () => runtime(outputGeneration([output])),
      });
      const body = await response.text();

      assert.equal(response.status, 502);
      assert.deepEqual(JSON.parse(body), { error: "invalid-answer" });
      assert.doesNotMatch(body, /onerror|unknown|not-json|private/u);
    });
  }
});

test("emits only a sanitized in-stream error after a previously validated cited block", async () => {
  const unsafe =
    '{"type":"content","markdown":"<script>alert(1)</script>"}\n' +
    '{"type":"citation","id":"C1"}\n';
  const response = await handleAnswerRequest(answerRequest(), {
    createRuntime: async () =>
      runtime(outputGeneration([safeProviderOutput, unsafe])),
  });
  const streamed = await records(response);

  assert.equal(response.status, 200);
  assert.deepEqual(streamed.slice(-1), [
    { code: "invalid-answer", type: "error" },
  ]);
  assert.equal(streamed[1]?.type, "content");
  assert.equal(streamed[2]?.type, "citation");
  assert.doesNotMatch(JSON.stringify(streamed), /script|alert/u);
});

test("propagates request cancellation and emits no private provider failure", async () => {
  let providerAborted = false;
  let recordedReason: string | null = null;
  let markProviderWaiting: () => void = () => {};
  const providerWaiting = new Promise<void>((resolve) => {
    markProviderWaiting = resolve;
  });
  const requestController = new AbortController();
  const generation = fixtureGeneration((request) =>
    (async function* (): AsyncIterable<GenerationEvent> {
      yield { text: safeProviderOutput, type: "text" };
      markProviderWaiting();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            providerAborted = true;
            reject(
              new GenerationError(
                "cancelled",
                `Generation cancelled: ${privateValue}`,
              ),
            );
          },
          { once: true },
        );
      });
    })(),
  );
  const response = await handleAnswerRequest(
    answerRequest(undefined, undefined, requestController.signal),
    {
      createRecorder: () =>
        Object.freeze({
          async abandon(reason: string) {
            recordedReason = reason;
          },
          observeEvent: async () => {},
          observeProvider: () => {},
          observeRetrieval: () => {},
        }),
      createRuntime: async () => runtime(generation),
    },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let streamed = "";

  while (!streamed.includes('"type":"citation"')) {
    const result = await reader.read();
    assert.equal(result.done, false);
    streamed += decoder.decode(result.value, { stream: true });
  }
  const pending = reader.read();
  await providerWaiting;
  requestController.abort();
  const failed = await pending;
  streamed += decoder.decode(failed.value, { stream: true });

  assert.equal(providerAborted, true);
  assert.equal(recordedReason, "cancelled");
  assert.match(streamed, /"code":"cancelled"/u);
  assert.doesNotMatch(streamed, new RegExp(privateValue, "u"));
});

test("contains runtime configuration and provider outages without logging request content", async (context) => {
  await context.test("runtime configuration", async () => {
    const response = await handleAnswerRequest(answerRequest(), {
      createRuntime: async () => {
        throw new Error(`${privateValue}: How do I reset my password?`);
      },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "unavailable" });
  });

  await context.test("provider outage", async () => {
    let recordedReason: string | null = null;
    const generation = fixtureGeneration(() =>
      (async function* (): AsyncIterable<GenerationEvent> {
        throw new GenerationError(
          "provider-unavailable",
          `${privateValue}: raw prompt`,
        );
      })(),
    );
    const response = await handleAnswerRequest(answerRequest(), {
      createRecorder: () =>
        Object.freeze({
          async abandon(reason: string) {
            recordedReason = reason;
          },
          observeEvent: async () => {},
          observeProvider: () => {},
          observeRetrieval: () => {},
        }),
      createRuntime: async () => runtime(generation),
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(recordedReason, "request-failed");
    assert.deepEqual(JSON.parse(body), { error: "unavailable" });
    assert.doesNotMatch(body, new RegExp(privateValue, "u"));
  });
});
