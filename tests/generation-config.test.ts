// ABOUTME: Verifies deployment-specific generation selection and public disclosure metadata.
// ABOUTME: Proves provider credentials never enter the immutable browser-visible contract.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createGenerationAdapter,
  generationUsesWorkersAiBinding,
  generationPublicMetadata,
} from "@/ai/generation-config";
import type {
  GenerationEvent,
  WorkersAiGenerationBinding,
} from "@/ai/generation";

const workersModel = "@cf/meta/llama-3.1-8b-instruct-fp8";
const workersDisclosure =
  "Cloudflare processes this answer transiently; Gateway logs and caching are disabled.";
const openAiDisclosure =
  "The configured answer provider retains requests for up to 30 days.";

function sse(parts: readonly string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<GenerationEvent>) {
  const events: GenerationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("D1 selects the Workers AI binding with private Gateway request options", async () => {
  const calls: unknown[][] = [];
  const binding = {
    async run(...parameters: readonly unknown[]) {
      calls.push([...parameters]);
      return sse([
        'data: {"response":"ok","finish_reason":"stop"}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  } as unknown as WorkersAiGenerationBinding;
  const adapter = createGenerationAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_GENERATION_GATEWAY_ID: "opas-answers",
      OPAS_GENERATION_MODEL: workersModel,
      OPAS_GENERATION_RETENTION_DISCLOSURE: workersDisclosure,
    },
    workersAiBinding: binding,
  });

  await collect(
    adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], workersModel);
  assert.deepEqual((calls[0]?.[2] as { gateway: unknown }).gateway, {
    collectLog: false,
    id: "opas-answers",
    skipCache: true,
  });
  assert.deepEqual(generationPublicMetadata(adapter), {
    model: workersModel,
    provider: "cloudflare-workers-ai",
    retentionDisclosure: workersDisclosure,
  });
});

test("treats an empty optional deployment credential as absent", async () => {
  const requests: RequestInit[] = [];
  const adapter = createGenerationAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_GENERATION_API_KEY: "",
      OPAS_GENERATION_ENDPOINT:
        "https://answers.example.test/v1/chat/completions",
      OPAS_GENERATION_MODEL: "fixture-answer-v1",
      OPAS_GENERATION_RETENTION_DISCLOSURE: openAiDisclosure,
    },
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(
        sse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  await collect(
    adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
  );

  assert.equal(requests.length, 1);
  assert.equal(new Headers(requests[0]?.headers).has("authorization"), false);
});

test("requires explicit complete cross-provider fallback configuration", async () => {
  const calls: string[] = [];
  const adapter = createGenerationAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_GENERATION_FALLBACK_API_KEY: "fallback-private-key",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_ENDPOINT:
        "https://fallback.example.test/v1/chat/completions",
      OPAS_GENERATION_FALLBACK_MODEL: "fallback-answer-v2",
      OPAS_GENERATION_FALLBACK_PROVIDER: "openai-compatible",
      OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE:
        "The fallback provider retains requests for seven days.",
      OPAS_GENERATION_GATEWAY_ID: "opas-answers",
      OPAS_GENERATION_MODEL: workersModel,
      OPAS_GENERATION_RETENTION_DISCLOSURE: workersDisclosure,
    },
    fetch: async () => {
      calls.push("fallback");
      return new Response(
        sse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    workersAiBinding: {
      async run() {
        calls.push("primary");
        throw new Error("private Workers failure");
      },
    } as unknown as WorkersAiGenerationBinding,
  });

  assert.deepEqual(
    await collect(
      adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
    ),
    [
      { text: "ok", type: "text" },
      {
        reason: "stop",
        type: "finish",
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      },
    ],
  );
  assert.deepEqual(calls, ["primary", "fallback"]);
  assert.deepEqual(adapter.fallbackMetadata, {
    model: "fallback-answer-v2",
    provider: "openai-compatible",
    retentionDisclosure: "The fallback provider retains requests for seven days.",
  });
  assert.deepEqual(generationPublicMetadata(adapter), {
    model: workersModel,
    provider: "cloudflare-workers-ai",
    retentionDisclosure:
      `${workersDisclosure} If that provider fails before answer output, OPAS may use ` +
      "openai-compatible model fallback-answer-v2. The fallback provider retains requests for seven days.",
  });
});

test("rejects implicit, invalid, partial, and same-vendor fallback settings", () => {
  const base = {
    OPAS_DATABASE_DRIVER: "d1",
    OPAS_GENERATION_GATEWAY_ID: "opas-answers",
    OPAS_GENERATION_MODEL: workersModel,
    OPAS_GENERATION_RETENTION_DISCLOSURE: workersDisclosure,
  } as const;
  const binding = {
    async run() {
      return sse(["data: [DONE]\n\n"]);
    },
  } as unknown as WorkersAiGenerationBinding;

  for (const environment of [
    {
      ...base,
      OPAS_GENERATION_FALLBACK_MODEL: "configured-without-opt-in",
    },
    {
      ...base,
      OPAS_GENERATION_FALLBACK_ENABLED: "TRUE",
    },
    {
      ...base,
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_MODEL: "missing-provider-fields",
      OPAS_GENERATION_FALLBACK_PROVIDER: "openai-compatible",
    },
    {
      ...base,
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_ENDPOINT:
        "https://fallback.example.test/v1/chat/completions",
      OPAS_GENERATION_FALLBACK_GATEWAY_ID: "must-not-mix-provider-fields",
      OPAS_GENERATION_FALLBACK_MODEL: "mixed-provider-settings",
      OPAS_GENERATION_FALLBACK_PROVIDER: "openai-compatible",
      OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE: "Not retained.",
    },
    {
      ...base,
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_GATEWAY_ID: "other-gateway",
      OPAS_GENERATION_FALLBACK_MODEL: "same-vendor",
      OPAS_GENERATION_FALLBACK_PROVIDER: "cloudflare-workers-ai",
      OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE: "Not retained.",
    },
  ]) {
    assert.throws(
      () => createGenerationAdapter({ environment, workersAiBinding: binding }),
      /fallback|endpoint/u,
    );
  }

  assert.equal(generationUsesWorkersAiBinding(base), true);
  assert.equal(
    generationUsesWorkersAiBinding({ OPAS_DATABASE_DRIVER: "postgres" }),
    false,
  );
  assert.equal(
    generationUsesWorkersAiBinding({
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_PROVIDER: "cloudflare-workers-ai",
    }),
    true,
  );
});

for (const databaseDriver of ["postgres", "neon"] as const) {
  test(`${databaseDriver} selects the generic OpenAI-compatible stream`, async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const secret = "private-answer-provider-key";
    const adapter = createGenerationAdapter({
      environment: {
        OPAS_DATABASE_DRIVER: databaseDriver,
        OPAS_GENERATION_API_KEY: secret,
        OPAS_GENERATION_ENDPOINT:
          "https://answers.example.test/v1/chat/completions",
        OPAS_GENERATION_MODEL: "fixture-answer-v1",
        OPAS_GENERATION_RETENTION_DISCLOSURE: openAiDisclosure,
      },
      fetch: async (input, init) => {
        requests.push({ input, init });
        return new Response(
          sse([
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await collect(
      adapter.stream({ messages: [{ content: "Fixture", role: "user" }] }),
    );

    assert.equal(requests.length, 1);
    assert.equal(
      new Headers(requests[0]?.init?.headers).get("authorization"),
      `Bearer ${secret}`,
    );
    const metadata = generationPublicMetadata(adapter);
    assert.deepEqual(metadata, {
      model: "fixture-answer-v1",
      provider: "openai-compatible",
      retentionDisclosure: openAiDisclosure,
    });
    assert.ok(Object.isFrozen(metadata));
    assert.doesNotMatch(JSON.stringify(metadata), new RegExp(secret, "u"));
  });
}

test("rejects missing, unsupported, and accidentally disclosed generation secrets", () => {
  assert.throws(
    () =>
      createGenerationAdapter({
        environment: { OPAS_DATABASE_DRIVER: "postgres" },
      }),
    /endpoint is invalid/u,
  );
  assert.throws(
    () =>
      createGenerationAdapter({
        environment: {
          OPAS_DATABASE_DRIVER: "d1",
          OPAS_GENERATION_GATEWAY_ID: "opas-answers",
          OPAS_GENERATION_MODEL: workersModel,
          OPAS_GENERATION_RETENTION_DISCLOSURE: workersDisclosure,
        },
      }),
    /binding is unavailable/u,
  );
  assert.throws(
    () =>
      createGenerationAdapter({
        environment: {
          OPAS_DATABASE_DRIVER: "sqlite",
          OPAS_GENERATION_MODEL: "fixture-answer-v1",
        },
      }),
    /database driver is unsupported/u,
  );
  assert.throws(
    () =>
      createGenerationAdapter({
        environment: {
          OPAS_DATABASE_DRIVER: "neon",
          OPAS_GENERATION_API_KEY: "leaked-answer-provider-key",
          OPAS_GENERATION_ENDPOINT:
            "https://answers.example.test/v1/chat/completions",
          OPAS_GENERATION_MODEL: "fixture-answer-v1",
          OPAS_GENERATION_RETENTION_DISCLOSURE:
            "Provider policy: leaked-answer-provider-key",
        },
      }),
    /disclosure is invalid/u,
  );
  assert.throws(
    () =>
      createGenerationAdapter({
        environment: {
          OPAS_DATABASE_DRIVER: "postgres",
          OPAS_GENERATION_API_KEY: "\r",
          OPAS_GENERATION_ENDPOINT:
            "https://answers.example.test/v1/chat/completions",
          OPAS_GENERATION_MODEL: "fixture-answer-v1",
          OPAS_GENERATION_RETENTION_DISCLOSURE: openAiDisclosure,
        },
      }),
    /credential is invalid/u,
  );
});
