// ABOUTME: Builds authenticated retrieval benchmark targets for supported production services.
// ABOUTME: Keeps credentials out of reports while exercising the production embedding and search contracts.
import {
  createOpenAiCompatibleEmbeddingAdapter,
  createWorkersAiEmbeddingAdapter,
  workersAiEmbeddingModel,
  type EmbeddingAdapter,
  type EmbeddingLimits,
  type WorkersAiEmbeddingBinding,
} from "@/ai/embeddings";
import {
  notConfiguredRetrievalTarget,
  type RetrievalEvaluationAdapter,
  type RetrievalEvaluationFixture,
  type RetrievalEvaluationTarget,
} from "@/evaluation/retrieval";
import { createEvaluationEvidenceSource } from "@/evaluation/retrieval-source";
import { createEvidenceRetriever } from "@/search/evidence";

type EvaluationEnvironment = Readonly<{
  [name: string]: string | undefined;
  OPAS_EMBEDDING_API_KEY?: string;
  OPAS_EMBEDDING_DIMENSION?: string;
  OPAS_EMBEDDING_DIMENSIONS_PARAMETER?: string;
  OPAS_EMBEDDING_ENDPOINT?: string;
  OPAS_EMBEDDING_MODEL?: string;
  OPAS_EVALUATION_AI_SEARCH_COST_USD_PER_QUERY?: string;
  OPAS_EVALUATION_AI_SEARCH_INSTANCE?: string;
  OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS?: string;
  OPAS_EVALUATION_CLOUDFLARE_ACCOUNT_ID?: string;
  OPAS_EVALUATION_CLOUDFLARE_API_TOKEN?: string;
  OPAS_EVALUATION_OPENAI_INPUT_USD_PER_MILLION_TOKENS?: string;
  OPAS_EVALUATION_WORKERS_AI_INPUT_USD_PER_MILLION_TOKENS?: string;
}>;

type CostEstimate = Readonly<{
  cost(input: string): number;
  description: string;
}>;

type EmbeddingTargetOptions = Readonly<{
  adapter: EmbeddingAdapter;
  cost: CostEstimate;
  fixture: RetrievalEvaluationFixture;
  id: string;
  label: string;
}>;

type WorkersAiBenchmarkOptions = Readonly<{
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
}>;

type AiSearchTargetOptions = Readonly<{
  accountId: string;
  apiToken: string;
  costPerQueryUsd: number;
  fetch?: typeof fetch;
  instance: string;
  sourceKeys: Readonly<Record<string, string>>;
}>;

const maintainedCloudflareAccountId = "f8801c7e8853a113a25f8b52fd9ceec1";
const cloudflareAccountPattern = /^[a-f0-9]{32}$/u;
const opasResourcePattern = /^opas-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u;
const utf8Encoder = new TextEncoder();

function configured(value: string | undefined) {
  return value === undefined || value === "" ? undefined : value;
}

function requiredConfiguration(value: string | undefined, name: string) {
  const selected = configured(value);
  if (!selected) {
    throw new Error(`${name} is required for the configured evaluation target`);
  }
  return selected;
}

function credential(value: string | undefined, name: string) {
  const selected = requiredConfiguration(value, name);
  if (
    selected.trim() !== selected ||
    selected.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(selected)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return selected;
}

function cloudflareAccount(value: string | undefined) {
  const accountId = requiredConfiguration(
    value,
    "OPAS_EVALUATION_CLOUDFLARE_ACCOUNT_ID",
  );
  if (
    !cloudflareAccountPattern.test(accountId) ||
    accountId !== maintainedCloudflareAccountId
  ) {
    throw new Error(
      "OPAS_EVALUATION_CLOUDFLARE_ACCOUNT_ID must identify the maintained DevPlant account",
    );
  }
  return accountId;
}

function boundedDecimal(value: string | undefined, name: string) {
  const source = requiredConfiguration(value, name);
  const amount = Number(source);
  if (!decimalPattern.test(source) || !Number.isFinite(amount) || amount > 100) {
    throw new Error(`${name} is invalid`);
  }
  return amount;
}

function positiveInteger(value: string | undefined, name: string) {
  const source = requiredConfiguration(value, name);
  if (!/^[1-9]\d*$/u.test(source)) {
    throw new Error(`${name} is invalid`);
  }
  const number = Number(source);
  if (!Number.isSafeInteger(number) || number > 4_096) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function dimensionsParameter(value: string | undefined) {
  const source = configured(value);
  if (source === undefined || source === "false") return false;
  if (source === "true") return true;
  throw new Error("OPAS_EMBEDDING_DIMENSIONS_PARAMETER is invalid");
}

function inputCostEstimate(
  usdPerMillionTokens: number,
  providerLabel: string,
): CostEstimate {
  return {
    cost(input) {
      const estimatedTokens = Math.max(
        1,
        Math.ceil(utf8Encoder.encode(input).byteLength / 4),
      );
      return (estimatedTokens * usdPerMillionTokens) / 1_000_000;
    },
    description:
      `${providerLabel}: operator-supplied USD per million input tokens, ` +
      "estimated at ceil(UTF-8 bytes / 4); one source-embedding pass is amortized across the fixture and benchmark repeat overhead is excluded",
  };
}

function embeddingInputBatches(inputs: readonly string[], limits: EmbeddingLimits) {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const input of inputs) {
    const bytes = utf8Encoder.encode(input).byteLength;
    if (bytes === 0 || bytes > limits.maximumInputUtf8Bytes) {
      throw new Error("Evaluation source exceeds the embedding input limit");
    }
    if (
      current.length > 0 &&
      (current.length === limits.maximumBatchSize ||
        currentBytes + bytes > limits.maximumBatchInputUtf8Bytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(input);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function embedAll(adapter: EmbeddingAdapter, inputs: readonly string[]) {
  const vectors: (readonly number[])[] = [];
  for (const batch of embeddingInputBatches(inputs, adapter.limits)) {
    const response = await adapter.embed(batch);
    vectors.push(...response.vectors);
  }
  if (vectors.length !== inputs.length) {
    throw new Error("Evaluation provider returned an incomplete embedding set");
  }
  return vectors;
}

export function createEmbeddingEvaluationTarget({
  adapter,
  cost,
  fixture,
  id,
  label,
}: EmbeddingTargetOptions): RetrievalEvaluationAdapter {
  const sourceInputs = fixture.sources.map(
    ({ evidenceText, title }) => `${title}\n\n${evidenceText}`,
  );
  const sourceEmbeddingCostPerQuestion =
    sourceInputs.reduce((total, input) => total + cost.cost(input), 0) /
    fixture.questions.length;
  let sourceVectors: readonly (readonly number[])[] | undefined;
  let retrieve: ReturnType<typeof createEvidenceRetriever> | undefined;

  return {
    id,
    label,
    kind: "embedding-provider",
    provider: adapter.metadata.provider,
    model: adapter.metadata.model,
    costBasis: cost.description,
    async prepareSourceEmbeddings() {
      sourceVectors = await embedAll(adapter, sourceInputs);
      retrieve = undefined;
    },
    async rebuild() {
      if (!sourceVectors) {
        throw new Error("Evaluation embedding generation is not active");
      }
      const source = createEvaluationEvidenceSource(fixture, {
        configurationHash: adapter.metadata.configurationHash,
        model: adapter.metadata.model,
        provider: adapter.metadata.provider,
        vectors: sourceVectors,
      });
      retrieve = createEvidenceRetriever(source);
      const firstSourceVector = sourceVectors[0];
      const warmupQuestion = fixture.questions[0];
      if (firstSourceVector && warmupQuestion) {
        await retrieve({
          workspaceId: fixture.workspaceId,
          query: warmupQuestion.question,
          mode: "hybrid",
          queryVector: firstSourceVector,
          topK: 5,
        });
      }
    },
    async retrieve({ question, topK }) {
      if (!retrieve) {
        throw new Error("Evaluation retrieval index has not been rebuilt");
      }
      const query = await adapter.embed([question.question]);
      const queryVector = query.vectors[0];
      if (!queryVector) {
        throw new Error("Evaluation provider returned no query embedding");
      }
      const results = await retrieve({
        workspaceId: fixture.workspaceId,
        query: question.question,
        mode: "hybrid",
        queryVector,
        topK,
      });
      return {
        sourceIds: results.map(({ sourceId }) => sourceId),
        inferenceCostUsd:
          sourceEmbeddingCostPerQuestion + cost.cost(question.question),
      };
    },
  };
}

export function createWorkersAiBenchmarkBinding({
  accountId,
  apiToken,
  fetch: request = fetch,
}: WorkersAiBenchmarkOptions): WorkersAiEmbeddingBinding {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/` +
    workersAiEmbeddingModel;

  return {
    async run(model: string, input: unknown) {
      if (model !== workersAiEmbeddingModel) {
        throw new Error("Workers AI evaluation model is unsupported");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(`Workers AI evaluation request failed (${response.status})`);
      }
      const body: unknown = await response.json();
      if (
        body === null ||
        typeof body !== "object" ||
        !("success" in body) ||
        body.success !== true ||
        !("result" in body)
      ) {
        throw new Error("Workers AI evaluation returned an invalid response");
      }
      return body.result as never;
    },
  } as WorkersAiEmbeddingBinding;
}

function aiSearchSourceKeys(
  fixture: RetrievalEvaluationFixture,
  value: string | undefined,
) {
  const source = requiredConfiguration(
    value,
    "OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS is invalid");
  }
  const mapping = parsed as Record<string, unknown>;
  const expectedIds = fixture.sources.map(({ id }) => id).sort();
  const actualIds = Object.keys(mapping).sort();
  const keys = actualIds.map((id) => mapping[id]);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index]) ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !key ||
        key.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(key),
    ) ||
    new Set(keys).size !== keys.length
  ) {
    throw new Error("OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS is invalid");
  }
  return Object.fromEntries(
    Object.entries(mapping).map(([id, key]) => [id, key as string]),
  );
}

export function createAiSearchEvaluationTarget({
  accountId,
  apiToken,
  costPerQueryUsd,
  fetch: request = fetch,
  instance,
  sourceKeys,
}: AiSearchTargetOptions): RetrievalEvaluationAdapter {
  if (!opasResourcePattern.test(instance)) {
    throw new Error("AI Search evaluation instance must be an opas-* resource");
  }
  const sourceIdsByKey = new Map(
    Object.entries(sourceKeys).map(([sourceId, key]) => [key, sourceId]),
  );
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/` +
    `ai-search/instances/${instance}/search`;

  return {
    id: "cloudflare-ai-search",
    label: "Cloudflare AI Search",
    kind: "ai-search",
    provider: "cloudflare-ai-search",
    model: null,
    costBasis: "Operator-supplied fixed USD cost per AI Search query",
    async retrieve({ question, topK }) {
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: question.question,
          ai_search_options: {
            cache: { enabled: false },
            query_rewrite: { enabled: false },
            reranking: { enabled: false },
            retrieval: {
              max_num_results: topK,
              retrieval_type: "hybrid",
            },
          },
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`AI Search evaluation request failed (${response.status})`);
      }
      const body: unknown = await response.json();
      if (
        body === null ||
        typeof body !== "object" ||
        !("success" in body) ||
        body.success !== true ||
        !("result" in body) ||
        body.result === null ||
        typeof body.result !== "object" ||
        !("chunks" in body.result) ||
        !Array.isArray(body.result.chunks)
      ) {
        throw new Error("AI Search evaluation returned an invalid response");
      }
      const sourceIds = body.result.chunks.map((chunk) => {
        if (
          chunk === null ||
          typeof chunk !== "object" ||
          !("item" in chunk) ||
          chunk.item === null ||
          typeof chunk.item !== "object" ||
          !("key" in chunk.item) ||
          typeof chunk.item.key !== "string"
        ) {
          throw new Error("AI Search evaluation returned an invalid source key");
        }
        const sourceId = sourceIdsByKey.get(chunk.item.key);
        if (!sourceId) {
          throw new Error("AI Search evaluation returned a source outside the fixture");
        }
        return sourceId;
      });
      return { sourceIds, inferenceCostUsd: costPerQueryUsd };
    },
  };
}

function anyConfigured(values: readonly (string | undefined)[]) {
  return values.some((value) => configured(value) !== undefined);
}

export async function configuredProviderRetrievalTargets(
  fixture: RetrievalEvaluationFixture,
  environment: EvaluationEnvironment = process.env,
  request: typeof fetch = fetch,
): Promise<readonly RetrievalEvaluationTarget[]> {
  const openAiValues = [
    environment.OPAS_EMBEDDING_ENDPOINT,
    environment.OPAS_EMBEDDING_MODEL,
    environment.OPAS_EMBEDDING_DIMENSION,
    environment.OPAS_EVALUATION_OPENAI_INPUT_USD_PER_MILLION_TOKENS,
  ];
  const aiSearchValues = [
    environment.OPAS_EVALUATION_AI_SEARCH_INSTANCE,
    environment.OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS,
    environment.OPAS_EVALUATION_AI_SEARCH_COST_USD_PER_QUERY,
  ];
  const targets: RetrievalEvaluationTarget[] = [];

  if (
    configured(
      environment.OPAS_EVALUATION_WORKERS_AI_INPUT_USD_PER_MILLION_TOKENS,
    ) !== undefined
  ) {
    const accountId = cloudflareAccount(
      environment.OPAS_EVALUATION_CLOUDFLARE_ACCOUNT_ID,
    );
    const apiToken = credential(
      environment.OPAS_EVALUATION_CLOUDFLARE_API_TOKEN,
      "OPAS_EVALUATION_CLOUDFLARE_API_TOKEN",
    );
    const price = boundedDecimal(
      environment.OPAS_EVALUATION_WORKERS_AI_INPUT_USD_PER_MILLION_TOKENS,
      "OPAS_EVALUATION_WORKERS_AI_INPUT_USD_PER_MILLION_TOKENS",
    );
    const adapter = await createWorkersAiEmbeddingAdapter({
      binding: createWorkersAiBenchmarkBinding({ accountId, apiToken, fetch: request }),
      pooling: "cls",
    });
    targets.push(
      createEmbeddingEvaluationTarget({
        adapter,
        cost: inputCostEstimate(price, "Workers AI embeddings"),
        fixture,
        id: "workers-ai",
        label: "Workers AI embeddings",
      }),
    );
  } else {
    targets.push(
      notConfiguredRetrievalTarget({
        id: "workers-ai",
        label: "Workers AI embeddings",
        kind: "embedding-provider",
        reason: "No authenticated Workers AI evaluation configuration was supplied",
      }),
    );
  }

  if (anyConfigured(openAiValues)) {
    const price = boundedDecimal(
      environment.OPAS_EVALUATION_OPENAI_INPUT_USD_PER_MILLION_TOKENS,
      "OPAS_EVALUATION_OPENAI_INPUT_USD_PER_MILLION_TOKENS",
    );
    const adapter = await createOpenAiCompatibleEmbeddingAdapter({
      apiKey: configured(environment.OPAS_EMBEDDING_API_KEY),
      dimension: positiveInteger(
        environment.OPAS_EMBEDDING_DIMENSION,
        "OPAS_EMBEDDING_DIMENSION",
      ),
      dimensionsParameter: dimensionsParameter(
        environment.OPAS_EMBEDDING_DIMENSIONS_PARAMETER,
      ),
      endpoint: requiredConfiguration(
        environment.OPAS_EMBEDDING_ENDPOINT,
        "OPAS_EMBEDDING_ENDPOINT",
      ),
      fetch: request,
      model: requiredConfiguration(
        environment.OPAS_EMBEDDING_MODEL,
        "OPAS_EMBEDDING_MODEL",
      ),
    });
    targets.push(
      createEmbeddingEvaluationTarget({
        adapter,
        cost: inputCostEstimate(price, "OpenAI-compatible embeddings"),
        fixture,
        id: "openai-compatible",
        label: "OpenAI-compatible embeddings",
      }),
    );
  } else {
    targets.push(
      notConfiguredRetrievalTarget({
        id: "openai-compatible",
        label: "OpenAI-compatible embeddings",
        kind: "embedding-provider",
        reason: "No OpenAI-compatible embedding evaluation configuration was supplied",
      }),
    );
  }

  if (anyConfigured(aiSearchValues)) {
    const accountId = cloudflareAccount(
      environment.OPAS_EVALUATION_CLOUDFLARE_ACCOUNT_ID,
    );
    const apiToken = credential(
      environment.OPAS_EVALUATION_CLOUDFLARE_API_TOKEN,
      "OPAS_EVALUATION_CLOUDFLARE_API_TOKEN",
    );
    const instance = requiredConfiguration(
      environment.OPAS_EVALUATION_AI_SEARCH_INSTANCE,
      "OPAS_EVALUATION_AI_SEARCH_INSTANCE",
    );
    targets.push(
      createAiSearchEvaluationTarget({
        accountId,
        apiToken,
        costPerQueryUsd: boundedDecimal(
          environment.OPAS_EVALUATION_AI_SEARCH_COST_USD_PER_QUERY,
          "OPAS_EVALUATION_AI_SEARCH_COST_USD_PER_QUERY",
        ),
        fetch: request,
        instance,
        sourceKeys: aiSearchSourceKeys(
          fixture,
          environment.OPAS_EVALUATION_AI_SEARCH_SOURCE_KEYS,
        ),
      }),
    );
  } else {
    targets.push(
      notConfiguredRetrievalTarget({
        id: "cloudflare-ai-search",
        label: "Cloudflare AI Search",
        kind: "ai-search",
        reason: "No Cloudflare AI Search staging instance was supplied",
      }),
    );
  }

  return targets;
}
