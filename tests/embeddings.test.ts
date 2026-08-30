// ABOUTME: Verifies portable embedding adapters, metadata, input bounds, and safe failures.
// ABOUTME: Locks Workers AI and OpenAI-compatible response validation to exact vector order.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiCompatibleEmbeddingAdapter,
  createWorkersAiEmbeddingAdapter,
  embeddingInputHash,
  EmbeddingError,
  type EmbeddingErrorCategory,
  type WorkersAiEmbeddingAdapterOptions,
  type WorkersAiEmbeddingBinding,
  workersAiEmbeddingDimension,
  workersAiEmbeddingModel,
} from "@/ai/embeddings";

function vector(dimension: number, seed = 0) {
  return Array.from({ length: dimension }, (_, index) => seed + index / 10);
}

function workersBinding(
  run: (model: string, input: unknown) => Promise<unknown>,
) {
  return { run } as unknown as WorkersAiEmbeddingBinding;
}

function embeddingError(category: EmbeddingErrorCategory, retryable: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.category, category);
    assert.equal(error.retryable, retryable);
    return true;
  };
}

async function openAiAdapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<
    Parameters<typeof createOpenAiCompatibleEmbeddingAdapter>[0]
  > = {},
) {
  return createOpenAiCompatibleEmbeddingAdapter({
    endpoint: "https://embeddings.example.test/v1/embeddings",
    model: "embed-pilot-v1",
    dimension: 3,
    apiKey: "private-test-key",
    fetch: fetchImplementation,
    ...overrides,
  });
}

test("publishes deterministic semantic configuration metadata without credentials", async () => {
  const binding = workersBinding(async () => ({
    shape: [1, workersAiEmbeddingDimension],
    data: [vector(workersAiEmbeddingDimension)],
    pooling: "cls",
  }));
  const firstWorkers = await createWorkersAiEmbeddingAdapter({
    binding,
    pooling: "cls",
    maximumBatchSize: 1,
  });
  const secondWorkers = await createWorkersAiEmbeddingAdapter({
    binding,
    pooling: "cls",
    maximumBatchSize: 32,
  });
  const meanWorkers = await createWorkersAiEmbeddingAdapter({
    binding,
    pooling: "mean",
  });

  assert.deepEqual(firstWorkers.metadata, {
    provider: "cloudflare-workers-ai",
    model: workersAiEmbeddingModel,
    dimension: workersAiEmbeddingDimension,
    configuration: { pooling: "cls" },
    configurationHash: firstWorkers.metadata.configurationHash,
  });
  assert.match(firstWorkers.metadata.configurationHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    secondWorkers.metadata.configurationHash,
    firstWorkers.metadata.configurationHash,
  );
  assert.notEqual(
    meanWorkers.metadata.configurationHash,
    firstWorkers.metadata.configurationHash,
  );

  const response = new Response(
    JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    { headers: { "content-type": "application/json" } },
  );
  const firstOpenAi = await openAiAdapter(async () => response.clone(), {
    apiKey: "first-secret",
    timeoutMilliseconds: 10,
  });
  const secondOpenAi = await openAiAdapter(async () => response.clone(), {
    apiKey: "second-secret",
    timeoutMilliseconds: 100,
  });
  const changedModel = await openAiAdapter(async () => response.clone(), {
    model: "embed-pilot-v2",
  });
  const withDimensions = await openAiAdapter(async () => response.clone(), {
    dimensionsParameter: true,
  });

  assert.deepEqual(firstOpenAi.metadata, {
    provider: "openai-compatible",
    model: "embed-pilot-v1",
    dimension: 3,
    configuration: {
      dimensionsParameter: false,
      endpoint: "https://embeddings.example.test/v1/embeddings",
    },
    configurationHash: firstOpenAi.metadata.configurationHash,
  });
  assert.equal(
    secondOpenAi.metadata.configurationHash,
    firstOpenAi.metadata.configurationHash,
  );
  assert.notEqual(
    changedModel.metadata.configurationHash,
    firstOpenAi.metadata.configurationHash,
  );
  assert.notEqual(
    withDimensions.metadata.configurationHash,
    firstOpenAi.metadata.configurationHash,
  );
  assert.doesNotMatch(JSON.stringify(firstOpenAi.metadata), /first-secret/u);
});

test("hashes exact embedding input separately from citation source identity", async () => {
  const firstSource = {
    canonicalUrl: "https://opas.dev/account/reset-password",
    contentHash: "a".repeat(64),
    embeddingText: "Reset password Account Use the emailed reset link.",
  };
  const movedSource = {
    ...firstSource,
    canonicalUrl: "https://opas.dev/security/reset-password",
    contentHash: "b".repeat(64),
  };

  assert.notEqual(firstSource.contentHash, movedSource.contentHash);
  assert.notEqual(firstSource.canonicalUrl, movedSource.canonicalUrl);
  assert.equal(
    await embeddingInputHash(firstSource.embeddingText),
    await embeddingInputHash(movedSource.embeddingText),
  );
  assert.notEqual(
    await embeddingInputHash(firstSource.embeddingText),
    await embeddingInputHash(`${movedSource.embeddingText} Updated.`),
  );
  await assert.rejects(
    () => embeddingInputHash("   "),
    embeddingError("invalid-input", false),
  );
});

test("Workers AI sends the typed BGE request and returns an immutable exact batch", async () => {
  const calls: { input: unknown; model: string }[] = [];
  const firstVector = vector(workersAiEmbeddingDimension, 1);
  const secondVector = vector(workersAiEmbeddingDimension, 2);
  const adapter = await createWorkersAiEmbeddingAdapter({
    binding: workersBinding(async (model, input) => {
      calls.push({ model, input });
      return {
        shape: [2, workersAiEmbeddingDimension],
        data: [firstVector, secondVector],
        pooling: "cls",
      };
    }),
    pooling: "cls",
  });
  const result = await adapter.embed(["First chunk", "Second chunk"]);

  assert.deepEqual(calls, [
    {
      model: workersAiEmbeddingModel,
      input: {
        text: ["First chunk", "Second chunk"],
        pooling: "cls",
      },
    },
  ]);
  assert.equal(result.metadata, adapter.metadata);
  assert.deepEqual(result.vectors, [firstVector, secondVector]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.vectors));
  assert.ok(Object.isFrozen(result.vectors[0]));
});

test("Workers AI runtime stays aligned with its snapshotted configuration", async () => {
  const calls: { input: unknown; model: string }[] = [];
  let replacementCalls = 0;
  const options: WorkersAiEmbeddingAdapterOptions = {
    binding: workersBinding(async (model, input) => {
      calls.push({ model, input });
      return {
        data: [vector(workersAiEmbeddingDimension)],
        pooling: "cls",
      };
    }),
    pooling: "cls",
  };
  const adapter = await createWorkersAiEmbeddingAdapter(options);

  options.binding = workersBinding(async () => {
    replacementCalls += 1;
    return {
      data: [vector(workersAiEmbeddingDimension)],
      pooling: "mean",
    };
  });
  options.pooling = "mean";

  await adapter.embed(["Stable chunk"]);

  assert.deepEqual(calls, [
    {
      model: workersAiEmbeddingModel,
      input: { pooling: "cls", text: ["Stable chunk"] },
    },
  ]);
  assert.equal(replacementCalls, 0);
  assert.deepEqual(adapter.metadata.configuration, { pooling: "cls" });
});

test("rejects empty, oversized, and over-count inputs before a provider call", async () => {
  let calls = 0;
  const adapter = await createWorkersAiEmbeddingAdapter({
    binding: workersBinding(async () => {
      calls += 1;
      return { data: [vector(workersAiEmbeddingDimension)] };
    }),
    pooling: "cls",
    maximumBatchSize: 1,
    maximumInputUtf8Bytes: 4,
  });

  await assert.rejects(
    () => adapter.embed([]),
    embeddingError("invalid-input", false),
  );
  await assert.rejects(
    () => adapter.embed(["  "]),
    embeddingError("invalid-input", false),
  );
  await assert.rejects(
    () => adapter.embed(["🧭x"]),
    embeddingError("invalid-input", false),
  );
  await assert.rejects(
    () => adapter.embed(["one", "two"]),
    embeddingError("invalid-input", false),
  );
  assert.equal(calls, 0);
});

test("enforces provider token ceilings conservatively before network calls", async () => {
  let workersCalls = 0;
  const workers = await createWorkersAiEmbeddingAdapter({
    binding: workersBinding(async () => {
      workersCalls += 1;
      return { data: [vector(workersAiEmbeddingDimension)] };
    }),
    pooling: "cls",
  });

  await workers.embed(["x".repeat(384)]);
  await assert.rejects(
    () => workers.embed(["x".repeat(511)]),
    embeddingError("invalid-input", false),
  );
  assert.equal(workersCalls, 1);
  assert.equal(workers.limits.maximumInputUtf8Bytes, 510);

  let openAiCalls = 0;
  const openAi = await openAiAdapter(
    async () => {
      openAiCalls += 1;
      return Response.json({ data: [] });
    },
    {
      maximumBatchSize: 64,
      maximumInputUtf8Bytes: 8_192,
    },
  );

  await assert.rejects(
    () => openAi.embed(["x".repeat(8_193)]),
    embeddingError("invalid-input", false),
  );
  await assert.rejects(
    () => openAi.embed(Array(61).fill("x".repeat(5_000))),
    embeddingError("invalid-input", false),
  );
  assert.equal(openAiCalls, 0);
  assert.equal(openAi.limits.maximumBatchInputUtf8Bytes, 300_000);
});

test("validates both current Workers AI BGE response variants and sanitizes failures", async (context) => {
  await context.test("accepts the typed optional shape fields", async () => {
    const adapter = await createWorkersAiEmbeddingAdapter({
      binding: workersBinding(async () => ({
        data: [vector(workersAiEmbeddingDimension)],
      })),
      pooling: "cls",
    });

    assert.equal((await adapter.embed(["chunk"])).vectors.length, 1);
  });

  for (const [name, output] of [
    ["asynchronous receipt", { request_id: "queued" }],
    [
      "wrong shape",
      {
        shape: [1, workersAiEmbeddingDimension - 1],
        data: [vector(workersAiEmbeddingDimension)],
      },
    ],
    [
      "wrong pooling",
      {
        data: [vector(workersAiEmbeddingDimension)],
        pooling: "mean",
      },
    ],
    [
      "wrong dimension",
      { data: [vector(workersAiEmbeddingDimension - 1)] },
    ],
    [
      "non-finite value",
      {
        data: [
          [Number.NaN, ...vector(workersAiEmbeddingDimension - 1)],
        ],
      },
    ],
  ] as const) {
    await context.test(`rejects ${name}`, async () => {
      const adapter = await createWorkersAiEmbeddingAdapter({
        binding: workersBinding(async () => output),
        pooling: "cls",
      });

      await assert.rejects(
        () => adapter.embed(["chunk"]),
        embeddingError("invalid-response", false),
      );
    });
  }

  await context.test("does not expose a provider error body", async () => {
    const sensitive = "raw provider failure included chunk text";
    const adapter = await createWorkersAiEmbeddingAdapter({
      binding: workersBinding(async () => {
        throw new Error(sensitive);
      }),
      pooling: "cls",
    });

    await assert.rejects(() => adapter.embed(["private chunk"]), (error) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.category, "provider-unavailable");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(String(error), /raw provider|private chunk/u);
      assert.equal("cause" in error, false);
      return true;
    });
  });
});

test("OpenAI-compatible requests opted-in dimensions and restores indexed order", async () => {
  let capturedRequest: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const adapter = await openAiAdapter(
    async (input, init) => {
      capturedRequest = { input, init };
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { object: "embedding", index: 1, embedding: [4, 5, 6] },
            { object: "embedding", index: 0, embedding: [1, 2, 3] },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    { dimensionsParameter: true },
  );
  const result = await adapter.embed(["Alpha", "Beta"]);

  assert.ok(capturedRequest);
  assert.equal(
    capturedRequest.input,
    "https://embeddings.example.test/v1/embeddings",
  );
  assert.equal(capturedRequest.init?.method, "POST");
  assert.deepEqual(capturedRequest.init?.headers, {
    authorization: "Bearer private-test-key",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(capturedRequest.init?.body)), {
    dimensions: 3,
    input: ["Alpha", "Beta"],
    model: "embed-pilot-v1",
  });
  assert.deepEqual(result.vectors, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
});

test("OpenAI-compatible omits dimensions unless explicitly configured", async () => {
  let body: unknown;
  const adapter = await openAiAdapter(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      data: [{ index: 0, embedding: [1, 2, 3] }],
    });
  });

  await adapter.embed(["Alpha"]);

  assert.deepEqual(body, {
    input: ["Alpha"],
    model: "embed-pilot-v1",
  });
});

test("OpenAI-compatible responses require unique contiguous indexes and exact finite vectors", async (context) => {
  for (const [name, body] of [
    [
      "duplicate indexes",
      {
        data: [
          { index: 0, embedding: [1, 2, 3] },
          { index: 0, embedding: [4, 5, 6] },
        ],
      },
    ],
    [
      "out-of-range index",
      {
        data: [
          { index: 0, embedding: [1, 2, 3] },
          { index: 2, embedding: [4, 5, 6] },
        ],
      },
    ],
    ["missing output", { data: [] }],
    ["wrong dimension", { data: [{ index: 0, embedding: [1, 2] }] }],
    [
      "non-finite vector",
      { data: [{ index: 0, embedding: [1, Number.POSITIVE_INFINITY, 3] }] },
    ],
  ] as const) {
    await context.test(`rejects ${name}`, async () => {
      const adapter = await openAiAdapter(async () =>
        Response.json(body),
      );
      const input =
        name === "duplicate indexes" || name === "out-of-range index"
          ? ["first", "second"]
          : ["first"];

      await assert.rejects(
        () => adapter.embed(input),
        embeddingError("invalid-response", false),
      );
    });
  }
});

test("normalizes OpenAI-compatible response statuses for bounded retry policy", async (context) => {
  for (const [status, category, retryable] of [
    [400, "provider-rejected", false],
    [401, "authentication", false],
    [403, "authentication", false],
    [408, "timeout", true],
    [429, "rate-limited", true],
    [500, "provider-unavailable", true],
    [504, "timeout", true],
  ] as const) {
    await context.test(`${status} becomes ${category}`, async () => {
      const adapter = await openAiAdapter(async () =>
        new Response("sensitive response body", { status }),
      );

      await assert.rejects(
        () => adapter.embed(["private input"]),
        (error: unknown) => {
          assert.ok(embeddingError(category, retryable)(error));
          assert.doesNotMatch(
            String(error),
            /sensitive response body|private input|private-test-key/u,
          );
          return true;
        },
      );
    });
  }
});

test("sanitizes transport errors and categorizes request expiry", async (context) => {
  await context.test("transport errors", async () => {
    const adapter = await openAiAdapter(async () => {
      throw new EmbeddingError(
        "invalid-input",
        "private-test-key and private input",
      );
    });

    await assert.rejects(() => adapter.embed(["private input"]), (error) => {
      assert.ok(embeddingError("provider-unavailable", true)(error));
      assert.doesNotMatch(String(error), /private-test-key|private input/u);
      assert.equal("cause" in (error as object), false);
      return true;
    });
  });

  await context.test("request expiry", async () => {
    const adapter = await openAiAdapter(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject({ name: "AbortError", message: "sensitive timeout body" });
          });
        }),
      { timeoutMilliseconds: 1 },
    );

    await assert.rejects(
      () => adapter.embed(["private input"]),
      embeddingError("timeout", true),
    );
  });

  await context.test("response body expiry", async () => {
    const adapter = await openAiAdapter(async (_input, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error({
              name: "AbortError",
              message: "sensitive response body",
            });
          });
        },
      });

      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    }, { timeoutMilliseconds: 1 });

    await assert.rejects(
      () => adapter.embed(["private input"]),
      embeddingError("timeout", true),
    );
  });
});

test("rejects unbounded or ambiguous adapter configuration", async () => {
  const binding = workersBinding(async () => ({
    data: [vector(workersAiEmbeddingDimension)],
  }));

  await assert.rejects(
    () =>
      createWorkersAiEmbeddingAdapter({
        binding,
        pooling: "cls",
        maximumBatchSize: Number.POSITIVE_INFINITY,
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      createWorkersAiEmbeddingAdapter({
        binding,
        pooling: "average" as "cls",
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      createWorkersAiEmbeddingAdapter({
        binding,
        pooling: "cls",
        maximumInputUtf8Bytes: 511,
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      openAiAdapter(async () => Response.json({ data: [] }), {
        endpoint: "https://secret@example.test/embeddings?token=private",
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      openAiAdapter(async () => Response.json({ data: [] }), {
        dimension: 0,
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      openAiAdapter(async () => Response.json({ data: [] }), {
        maximumInputUtf8Bytes: 8_193,
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      openAiAdapter(async () => Response.json({ data: [] }), {
        dimensionsParameter: "yes" as unknown as boolean,
      }),
    embeddingError("configuration", false),
  );
  await assert.rejects(
    () =>
      openAiAdapter(async () => Response.json({ data: [] }), {
        apiKey: "bad\nheader",
      }),
    embeddingError("configuration", false),
  );
});
