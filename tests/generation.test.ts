// ABOUTME: Verifies bounded provider-neutral streaming generation and privacy-safe metadata.
// ABOUTME: Locks Workers AI Gateway options and OpenAI-compatible SSE normalization.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createGenerationFallbackAdapter,
  createOpenAiCompatibleGenerationAdapter,
  createWorkersAiGenerationAdapter,
  GenerationError,
  type GenerationErrorCategory,
  type GenerationAdapter,
  type GenerationEvent,
  type WorkersAiGenerationBinding,
} from "@/ai/generation";

const workersModel = "@cf/meta/llama-3.1-8b-instruct-fp8";
const retentionDisclosure =
  "The provider processes prompts transiently; OPAS disables Gateway logs and response caching.";

function sseStream(parts: readonly string[]) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

function workersBinding(
  run: (...parameters: readonly unknown[]) => Promise<unknown>,
) {
  return { run } as unknown as WorkersAiGenerationBinding;
}

async function collect(stream: AsyncIterable<GenerationEvent>) {
  const events: GenerationEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function fixtureAdapter(
  provider: GenerationAdapter["metadata"]["provider"],
  model: string,
  stream: GenerationAdapter["stream"],
): GenerationAdapter {
  return Object.freeze({
    limits: Object.freeze({
      maximumInputUtf8Bytes: 65_536,
      maximumMessages: 16,
      maximumOutputTokens: 1_024,
      maximumOutputUtf8Bytes: 65_536,
      timeoutMilliseconds: 30_000,
    }),
    metadata: Object.freeze({
      model,
      provider,
      retentionDisclosure: `${provider} does not retain fixture requests.`,
    }),
    stream,
  });
}

test("uses an explicitly disclosed cross-provider fallback only before output", async () => {
  const calls: string[] = [];
  const primary = fixtureAdapter(
    "cloudflare-workers-ai",
    "primary-v1",
    () =>
      (async function* () {
        calls.push("primary");
        throw new GenerationError(
          "provider-unavailable",
          "Primary provider is unavailable",
        );
      })(),
  );
  const fallback = fixtureAdapter(
    "openai-compatible",
    "fallback-v2",
    () =>
      (async function* () {
        calls.push("fallback");
        yield { text: "fallback answer", type: "text" } as const;
        yield {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        } as const;
      })(),
  );
  const adapter = createGenerationFallbackAdapter({ fallback, primary });

  assert.deepEqual(
    await collect(adapter.stream({ messages: [{ content: "Fixture", role: "user" }] })),
    [
      { text: "fallback answer", type: "text" },
      {
        reason: "stop",
        type: "finish",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      },
    ],
  );
  assert.deepEqual(calls, ["primary", "fallback"]);
  assert.deepEqual(adapter.fallbackMetadata, fallback.metadata);
  assert.equal(adapter.metadata.provider, "cloudflare-workers-ai");
  assert.equal(adapter.metadata.model, "primary-v1");
  assert.match(adapter.metadata.retentionDisclosure, /openai-compatible/u);
  assert.match(adapter.metadata.retentionDisclosure, /fallback-v2/u);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.fallbackMetadata));
});

test("uses fallback for every safe pre-output provider failure", async (context) => {
  for (const category of ["provider-unavailable", "rate-limited", "timeout"] as const) {
    await context.test(category, async () => {
      let fallbackCalls = 0;
      const adapter = createGenerationFallbackAdapter({
        primary: fixtureAdapter(
          "cloudflare-workers-ai",
          "primary-v1",
          () =>
            (async function* () {
              throw new GenerationError(category, "Primary provider failed");
            })(),
        ),
        fallback: fixtureAdapter(
          "openai-compatible",
          "fallback-v2",
          () =>
            (async function* () {
              fallbackCalls += 1;
              yield {
                reason: "stop",
                type: "finish",
                usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
              } as const;
            })(),
        ),
      });

      assert.equal(
        (
          await collect(
            adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
          )
        ).at(-1)?.type,
        "finish",
      );
      assert.equal(fallbackCalls, 1);
    });
  }
});

test("never falls back after an event or for unsafe provider failures", async (context) => {
  for (const fixture of [
    {
      name: "output started",
      primary: async function* () {
        yield { text: "visible", type: "text" } as const;
        throw new GenerationError(
          "provider-unavailable",
          "Primary provider disconnected",
        );
      },
      expectedCategory: "provider-unavailable",
    },
    {
      name: "authentication",
      primary: async function* () {
        throw new GenerationError(
          "authentication",
          "Primary provider authentication failed",
        );
      },
      expectedCategory: "authentication",
    },
    {
      name: "cancellation",
      primary: async function* () {
        throw new GenerationError("cancelled", "Request cancelled");
      },
      expectedCategory: "cancelled",
    },
    {
      name: "invalid response",
      primary: async function* () {
        throw new GenerationError(
          "invalid-response",
          "Primary provider returned invalid output",
        );
      },
      expectedCategory: "invalid-response",
    },
  ] as const) {
    await context.test(fixture.name, async () => {
      let fallbackCalls = 0;
      const adapter = createGenerationFallbackAdapter({
        primary: fixtureAdapter(
          "cloudflare-workers-ai",
          "primary-v1",
          fixture.primary,
        ),
        fallback: fixtureAdapter(
          "openai-compatible",
          "fallback-v2",
          () =>
            (async function* () {
              fallbackCalls += 1;
              yield { text: "must not run", type: "text" } as const;
            })(),
        ),
      });

      await assert.rejects(
        collect(
          adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
        ),
        (error) =>
          error instanceof GenerationError &&
          error.category === fixture.expectedCategory,
      );
      assert.equal(fallbackCalls, 0);
    });
  }
});

function generationError(category: GenerationErrorCategory, retryable: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof GenerationError);
    assert.equal(error.category, category);
    assert.equal(error.retryable, retryable);
    return true;
  };
}

async function workersAdapter(
  run: (...parameters: readonly unknown[]) => Promise<unknown>,
  overrides: Partial<
    Parameters<typeof createWorkersAiGenerationAdapter>[0]
  > = {},
) {
  return createWorkersAiGenerationAdapter({
    binding: workersBinding(run),
    gatewayId: "opas-answers",
    model: workersModel,
    retentionDisclosure,
    ...overrides,
  });
}

async function openAiAdapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<
    Parameters<typeof createOpenAiCompatibleGenerationAdapter>[0]
  > = {},
) {
  return createOpenAiCompatibleGenerationAdapter({
    apiKey: "private-provider-key",
    endpoint: "https://generation.example.test/v1/chat/completions",
    fetch: fetchImplementation,
    model: "answer-pilot-v1",
    retentionDisclosure: "The configured provider retains requests for 30 days.",
    ...overrides,
  });
}

test("publishes frozen semantic metadata without credentials or mutable options", async () => {
  const binding = workersBinding(async () => sseStream(["data: [DONE]\n\n"]));
  const workersOptions: Parameters<
    typeof createWorkersAiGenerationAdapter
  >[0] = {
    binding,
    gatewayId: "opas-answers",
    model: workersModel,
    retentionDisclosure,
  };
  const workers = await createWorkersAiGenerationAdapter(workersOptions);

  workersOptions.gatewayId = "changed-after-creation";
  workersOptions.model = "@cf/changed/model";
  workersOptions.retentionDisclosure = "Changed";

  assert.deepEqual(workers.metadata, {
    model: workersModel,
    provider: "cloudflare-workers-ai",
    retentionDisclosure,
  });
  assert.ok(Object.isFrozen(workers));
  assert.ok(Object.isFrozen(workers.limits));
  assert.ok(Object.isFrozen(workers.metadata));

  const response = new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  const openAi = await openAiAdapter(async () => response.clone());
  const changedKey = await openAiAdapter(async () => response.clone(), {
    apiKey: "another-secret-key",
  });

  assert.deepEqual(openAi.metadata, {
    model: "answer-pilot-v1",
    provider: "openai-compatible",
    retentionDisclosure: "The configured provider retains requests for 30 days.",
  });
  assert.deepEqual(openAi.metadata, changedKey.metadata);
  assert.doesNotMatch(JSON.stringify(openAi), /private-provider-key/u);
});

test("Workers AI streams normalized events with exact private Gateway options", async () => {
  const calls: unknown[][] = [];
  const binding = {
    async run(this: unknown, ...parameters: readonly unknown[]) {
      assert.equal(this, binding);
      calls.push([...parameters]);
      return sseStream([
        "data: {\"response\":\"Hel",
        "lo\"}\r\n\r\ndata: {\"response\":\" world\",\"usage\":{",
        "\"prompt_tokens\":12,\"completion_tokens\":2,\"total_tokens\":14},",
        "\"finish_reason\":\"stop\"}\n\ndata: [DONE]\n\n",
      ]);
    },
  };
  const adapter = await createWorkersAiGenerationAdapter({
    binding: binding as unknown as WorkersAiGenerationBinding,
    gatewayId: "opas-answers",
    model: workersModel,
    retentionDisclosure,
  });
  const messages = [
    { role: "system" as const, content: "Answer from supplied evidence." },
    { role: "user" as const, content: "How do I reset a password?" },
  ];
  const events = await collect(
    adapter.stream({ messages, maximumOutputTokens: 64, temperature: 0 }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], workersModel);
  assert.deepEqual(calls[0]?.[1], {
    max_tokens: 64,
    messages,
    stream: true,
    temperature: 0,
  });
  assert.deepEqual(
    (calls[0]?.[2] as { gateway: unknown }).gateway,
    {
      collectLog: false,
      id: "opas-answers",
      skipCache: true,
    },
  );
  assert.ok((calls[0]?.[2] as { signal: unknown }).signal instanceof AbortSignal);
  assert.deepEqual(events, [
    { text: "Hello", type: "text" },
    { text: " world", type: "text" },
    {
      reason: "stop",
      type: "finish",
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    },
  ]);
  assert.ok(events.every(Object.isFrozen));
  assert.ok(Object.isFrozen(events[2]?.usage));
});

test("OpenAI-compatible generation sends a bounded request and parses deterministic SSE", async () => {
  const requests: { input?: RequestInit; url: string }[] = [];
  const adapter = await openAiAdapter(async (input, init) => {
    requests.push({ input: init, url: String(input) });
    return new Response(
      sseStream([
        ": keepalive\n\n",
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Reset \"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"it.\"},\"finish_reason\":\"length\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":3,\"total_tokens\":24}}\n\n",
        "data: [DONE]\n\n",
      ]),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  });
  const messages = [{ role: "user" as const, content: "Reset password" }];
  const events = await collect(
    adapter.stream({ messages, maximumOutputTokens: 128, temperature: 0.25 }),
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://generation.example.test/v1/chat/completions",
  );
  const headers = new Headers(requests[0]?.input?.headers);
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("authorization"), "Bearer private-provider-key");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(requests[0]?.input?.cache, "no-store");
  assert.equal(requests[0]?.input?.method, "POST");
  assert.equal(requests[0]?.input?.redirect, "error");
  assert.ok(requests[0]?.input?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(requests[0]?.input?.body)), {
    max_tokens: 128,
    messages,
    model: "answer-pilot-v1",
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.25,
  });
  assert.deepEqual(events, [
    { text: "Reset ", type: "text" },
    { text: "it.", type: "text" },
    {
      reason: "length",
      type: "finish",
      usage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
    },
  ]);
});

test("rejects invalid configuration before exposing an adapter", () => {
  const binding = workersBinding(async () => sseStream(["data: [DONE]\n\n"]));

  assert.throws(
    () =>
      createWorkersAiGenerationAdapter({
        binding,
        gatewayId: "Invalid gateway id",
        model: workersModel,
        retentionDisclosure,
      }),
    generationError("configuration", false),
  );
  assert.throws(
    () =>
      createWorkersAiGenerationAdapter({
        binding,
        gatewayId: "opas-answers",
        model: "model\nsecret",
        retentionDisclosure,
      }),
    generationError("configuration", false),
  );
  assert.throws(
    () =>
      createOpenAiCompatibleGenerationAdapter({
        endpoint: "https://user:secret@example.test/v1/chat/completions",
        fetch,
        model: "model",
        retentionDisclosure: "Retained",
      }),
    generationError("configuration", false),
  );
  assert.throws(
    () =>
      createOpenAiCompatibleGenerationAdapter({
        endpoint: "https://example.test/v1/chat/completions?token=secret",
        fetch,
        model: "model",
        retentionDisclosure: "Retained",
      }),
    generationError("configuration", false),
  );
  assert.throws(
    () =>
      createOpenAiCompatibleGenerationAdapter({
        endpoint: "https://example.test/v1/chat/completions",
        fetch,
        model: "model",
        retentionDisclosure: " ",
      }),
    generationError("configuration", false),
  );
});

test("bounds message count, UTF-8 input, output tokens, and streamed output", async () => {
  let calls = 0;
  const adapter = await workersAdapter(
    async () => {
      calls += 1;
      return sseStream([
        "data: {\"response\":\"12345\"}\n\n",
        "data: {\"response\":\"6789\"}\n\n",
        "data: [DONE]\n\n",
      ]);
    },
    {
      maximumInputUtf8Bytes: 8,
      maximumMessages: 2,
      maximumOutputTokens: 4,
      maximumOutputUtf8Bytes: 8,
    },
  );

  for (const messages of [
    [],
    [{ role: "user" as const, content: " " }],
    [{ role: "user" as const, content: "🧭🧭x" }],
    [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ],
  ]) {
    await assert.rejects(
      () => collect(adapter.stream({ messages })),
      generationError("invalid-input", false),
    );
  }
  await assert.rejects(
    () =>
      collect(
        adapter.stream({
          messages: [{ role: "tool" as never, content: "invalid role" }],
        }),
      ),
    generationError("invalid-input", false),
  );
  await assert.rejects(
    () =>
      collect(
        adapter.stream({
          maximumOutputTokens: 5,
          messages: [{ role: "user", content: "valid" }],
        }),
      ),
    generationError("invalid-input", false),
  );
  await assert.rejects(
    () =>
      collect(
        adapter.stream({
          messages: [{ role: "user", content: "valid" }],
          temperature: Number.NaN,
        }),
      ),
    generationError("invalid-input", false),
  );
  assert.equal(calls, 0);

  const events: GenerationEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of adapter.stream({
      messages: [{ role: "user", content: "valid" }],
    })) {
      events.push(event);
    }
  }, generationError("output-limit", false));
  assert.deepEqual(events, [{ text: "12345", type: "text" }]);
  assert.equal(calls, 1);
});

test("normalizes finish reasons and rejects malformed or incomplete streams", async (context) => {
  for (const [providerReason, expectedReason] of [
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "content-filter"],
    ["tool_calls", "tool-call"],
    ["provider-specific", "unknown"],
  ] as const) {
    await context.test(providerReason, async () => {
      const adapter = await workersAdapter(async () =>
        sseStream([
          `data: {"response":"ok","finish_reason":"${providerReason}"}\n\n`,
          "data: [DONE]\n\n",
        ]),
      );
      const events = await collect(
        adapter.stream({ messages: [{ role: "user", content: "question" }] }),
      );

      const finish = events.at(-1);
      assert.equal(finish?.type, "finish");
      assert.equal(
        finish?.type === "finish" ? finish.reason : null,
        expectedReason,
      );
    });
  }

  for (const [name, body] of [
    ["malformed JSON", "data: {not-json}\n\ndata: [DONE]\n\n"],
    ["invalid usage", "data: {\"usage\":{\"prompt_tokens\":-1}}\n\ndata: [DONE]\n\n"],
    ["missing completion marker", "data: {\"response\":\"partial\"}\n\n"],
    ["data after completion", "data: [DONE]\n\ndata: {\"response\":\"late\"}\n\n"],
  ] as const) {
    await context.test(name, async () => {
      const adapter = await workersAdapter(async () => sseStream([body]));
      await assert.rejects(
        () =>
          collect(
            adapter.stream({
              messages: [{ role: "user", content: "question" }],
            }),
          ),
        generationError("invalid-response", false),
      );
    });
  }
});

test("maps HTTP and transport failures without exposing bodies, prompts, or secrets", async (context) => {
  const prompt = "customer-secret-question";
  const apiKey = "provider-secret-key";

  for (const [status, category, retryable] of [
    [401, "authentication", false],
    [429, "rate-limited", true],
    [400, "provider-rejected", false],
    [503, "provider-unavailable", true],
  ] as const) {
    await context.test(String(status), async () => {
      const adapter = await openAiAdapter(
        async () =>
          new Response(`raw ${prompt} ${apiKey}`, {
            status,
            headers: { "content-type": "application/json" },
          }),
        { apiKey },
      );

      await assert.rejects(
        () =>
          collect(
            adapter.stream({
              messages: [{ role: "user", content: prompt }],
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof GenerationError);
          assert.equal(error.category, category);
          assert.equal(error.retryable, retryable);
          assert.doesNotMatch(error.message, new RegExp(prompt, "u"));
          assert.doesNotMatch(error.message, new RegExp(apiKey, "u"));
          assert.doesNotMatch(error.message, /raw/u);
          return true;
        },
      );
    });
  }

  await context.test("transport", async () => {
    const adapter = await openAiAdapter(async () => {
      throw new Error(`transport exposed ${prompt} ${apiKey}`);
    }, { apiKey });

    await assert.rejects(
      () =>
        collect(
          adapter.stream({ messages: [{ role: "user", content: prompt }] }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.category, "provider-unavailable");
        assert.doesNotMatch(error.message, new RegExp(prompt, "u"));
        assert.doesNotMatch(error.message, new RegExp(apiKey, "u"));
        return true;
      },
    );
  });
});

test("enforces timeout and caller cancellation without logging conversation data", async () => {
  const consoleCalls: unknown[][] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.error = (...values) => consoleCalls.push(values);
  console.log = (...values) => consoleCalls.push(values);
  console.warn = (...values) => consoleCalls.push(values);

  try {
    const timedOut = await workersAdapter(
      async (...parameters) => {
        const signal = (parameters[2] as { signal: AbortSignal }).signal;
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("sensitive provider error", "AbortError")),
            { once: true },
          );
        });
      },
      { timeoutMilliseconds: 5 },
    );
    await assert.rejects(
      () =>
        collect(
          timedOut.stream({
            messages: [{ role: "user", content: "private timeout prompt" }],
          }),
        ),
      generationError("timeout", true),
    );

    let calls = 0;
    const cancelled = await workersAdapter(async () => {
      calls += 1;
      return sseStream(["data: [DONE]\n\n"]);
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        collect(
          cancelled.stream({
            messages: [{ role: "user", content: "private cancelled prompt" }],
            signal: controller.signal,
          }),
        ),
      generationError("cancelled", false),
    );
    assert.equal(calls, 0);
    assert.deepEqual(consoleCalls, []);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});
