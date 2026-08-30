// ABOUTME: Defines the portable embedding contract and its supported provider adapters.
// ABOUTME: Validates provider configuration, bounded inputs, and exact embedding responses.
import type {
  Ai,
  Ai_Cf_Baai_Bge_Base_En_V1_5_Output,
} from "@cloudflare/workers-types";

export const workersAiEmbeddingModel = "@cf/baai/bge-base-en-v1.5";
export const workersAiEmbeddingDimension = 768;

const defaultMaximumBatchSize = 32;
const defaultMaximumInputUtf8Bytes = 4_096;
const defaultRequestTimeoutMilliseconds = 30_000;
const hardMaximumBatchSize = 128;
const hardMaximumInputUtf8Bytes = 65_536;
const hardMaximumDimension = 8_192;
const hardMaximumTimeoutMilliseconds = 120_000;
const workersAiMaximumInputTokens = 512;
const workersAiFramingTokens = 2;
const workersAiMaximumInputUtf8Bytes =
  workersAiMaximumInputTokens - workersAiFramingTokens;
const openAiMaximumInputUtf8Bytes = 8_192;
const openAiMaximumBatchInputUtf8Bytes = 300_000;

const utf8Encoder = new TextEncoder();

export type EmbeddingErrorCategory =
  | "authentication"
  | "configuration"
  | "invalid-input"
  | "invalid-response"
  | "provider-rejected"
  | "provider-unavailable"
  | "rate-limited"
  | "timeout";

const retryableCategory: Record<EmbeddingErrorCategory, boolean> = {
  authentication: false,
  configuration: false,
  "invalid-input": false,
  "invalid-response": false,
  "provider-rejected": false,
  "provider-unavailable": true,
  "rate-limited": true,
  timeout: true,
};

export class EmbeddingError extends Error {
  readonly category: EmbeddingErrorCategory;
  readonly retryable: boolean;

  constructor(category: EmbeddingErrorCategory, message: string) {
    super(message);
    this.name = "EmbeddingError";
    this.category = category;
    this.retryable = retryableCategory[category];
  }
}

export type WorkersAiEmbeddingMetadata = {
  configuration: {
    pooling: "cls" | "mean";
  };
  configurationHash: string;
  dimension: typeof workersAiEmbeddingDimension;
  model: typeof workersAiEmbeddingModel;
  provider: "cloudflare-workers-ai";
};

export type OpenAiCompatibleEmbeddingMetadata = {
  configuration: {
    dimensionsParameter: boolean;
    endpoint: string;
  };
  configurationHash: string;
  dimension: number;
  model: string;
  provider: "openai-compatible";
};

export type EmbeddingMetadata =
  | WorkersAiEmbeddingMetadata
  | OpenAiCompatibleEmbeddingMetadata;

export type EmbeddingLimits = {
  maximumBatchInputUtf8Bytes: number;
  maximumBatchSize: number;
  maximumInputUtf8Bytes: number;
};

export type EmbeddingBatch = {
  metadata: EmbeddingMetadata;
  vectors: readonly (readonly number[])[];
};

export interface EmbeddingAdapter {
  readonly limits: EmbeddingLimits;
  readonly metadata: EmbeddingMetadata;
  embed(input: readonly string[]): Promise<EmbeddingBatch>;
}

export type WorkersAiEmbeddingBinding = Pick<Ai, "run">;

export type WorkersAiEmbeddingAdapterOptions = {
  binding: WorkersAiEmbeddingBinding;
  maximumBatchSize?: number;
  maximumInputUtf8Bytes?: number;
  pooling: "cls" | "mean";
};

export type OpenAiCompatibleEmbeddingAdapterOptions = {
  apiKey?: string;
  dimension: number;
  dimensionsParameter?: boolean;
  endpoint: string;
  fetch?: typeof fetch;
  maximumBatchSize?: number;
  maximumInputUtf8Bytes?: number;
  model: string;
  timeoutMilliseconds?: number;
};

type CanonicalValue =
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function canonicalJson(value: CanonicalValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, CanonicalValue>)[key] as CanonicalValue,
          )}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

async function configurationHash(value: CanonicalValue) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8Encoder.encode(canonicalJson(value)),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function integerSetting(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
) {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new EmbeddingError(
      "configuration",
      `Embedding ${name} is outside the supported range`,
    );
  }

  return resolved;
}

function embeddingLimits(
  options: {
    maximumBatchSize?: number;
    maximumInputUtf8Bytes?: number;
  },
  providerMaximumInputUtf8Bytes: number,
  providerMaximumBatchInputUtf8Bytes?: number,
) {
  const maximumBatchSize = integerSetting(
    options.maximumBatchSize,
    defaultMaximumBatchSize,
    hardMaximumBatchSize,
    "batch size",
  );
  const maximumInputUtf8Bytes = integerSetting(
    options.maximumInputUtf8Bytes,
    Math.min(defaultMaximumInputUtf8Bytes, providerMaximumInputUtf8Bytes),
    Math.min(hardMaximumInputUtf8Bytes, providerMaximumInputUtf8Bytes),
    "input size",
  );

  return Object.freeze({
    maximumBatchInputUtf8Bytes: Math.min(
      maximumBatchSize * maximumInputUtf8Bytes,
      providerMaximumBatchInputUtf8Bytes ?? Number.MAX_SAFE_INTEGER,
    ),
    maximumBatchSize,
    maximumInputUtf8Bytes,
  });
}

function validateInput(input: readonly string[], limits: EmbeddingLimits) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new EmbeddingError(
      "invalid-input",
      "Embedding input must contain at least one text value",
    );
  }

  if (input.length > limits.maximumBatchSize) {
    throw new EmbeddingError(
      "invalid-input",
      "Embedding input exceeds the configured batch size",
    );
  }

  let batchInputUtf8Bytes = 0;

  for (const value of input) {
    const inputUtf8Bytes =
      typeof value === "string" ? utf8Encoder.encode(value).byteLength : 0;

    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      inputUtf8Bytes > limits.maximumInputUtf8Bytes
    ) {
      throw new EmbeddingError(
        "invalid-input",
        "Embedding input contains an empty or oversized text value",
      );
    }

    batchInputUtf8Bytes += inputUtf8Bytes;
  }

  if (batchInputUtf8Bytes > limits.maximumBatchInputUtf8Bytes) {
    throw new EmbeddingError(
      "invalid-input",
      "Embedding input exceeds the configured request size",
    );
  }
}

export async function embeddingInputHash(input: string) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new EmbeddingError(
      "invalid-input",
      "Embedding input hash requires a non-empty text value",
    );
  }

  return configurationHash({
    input,
    purpose: "opas-embedding-input",
    version: 1,
  });
}

function validatedVector(value: unknown, dimension: number) {
  if (
    !Array.isArray(value) ||
    value.length !== dimension ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new EmbeddingError(
      "invalid-response",
      "Embedding provider returned an invalid vector",
    );
  }

  return Object.freeze([...value] as number[]);
}

function validatedVectors(
  value: unknown,
  batchSize: number,
  dimension: number,
) {
  if (!Array.isArray(value) || value.length !== batchSize) {
    throw new EmbeddingError(
      "invalid-response",
      "Embedding provider returned an invalid batch",
    );
  }

  return Object.freeze(
    value.map((vector) => validatedVector(vector, dimension)),
  );
}

function workersAiVectors(
  value: Ai_Cf_Baai_Bge_Base_En_V1_5_Output,
  batchSize: number,
  pooling: "cls" | "mean",
) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("data" in value) ||
    ("pooling" in value && value.pooling !== undefined && value.pooling !== pooling)
  ) {
    throw new EmbeddingError(
      "invalid-response",
      "Workers AI returned an invalid embedding response",
    );
  }

  if (
    "shape" in value &&
    value.shape !== undefined &&
    (!Array.isArray(value.shape) ||
      value.shape.length !== 2 ||
      value.shape[0] !== batchSize ||
      value.shape[1] !== workersAiEmbeddingDimension)
  ) {
    throw new EmbeddingError(
      "invalid-response",
      "Workers AI returned an invalid embedding shape",
    );
  }

  return validatedVectors(
    value.data,
    batchSize,
    workersAiEmbeddingDimension,
  );
}

function frozenBatch(
  metadata: EmbeddingMetadata,
  vectors: readonly (readonly number[])[],
): EmbeddingBatch {
  return Object.freeze({ metadata, vectors });
}

function isAbortError(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function providerFailure(error: unknown, provider: string) {
  if (isAbortError(error)) {
    return new EmbeddingError("timeout", `${provider} embedding request timed out`);
  }

  return new EmbeddingError(
    "provider-unavailable",
    `${provider} embedding request failed`,
  );
}

export async function createWorkersAiEmbeddingAdapter(
  options: WorkersAiEmbeddingAdapterOptions,
): Promise<EmbeddingAdapter> {
  if (!options.binding || typeof options.binding.run !== "function") {
    throw new EmbeddingError(
      "configuration",
      "Workers AI embedding binding is unavailable",
    );
  }

  if (options.pooling !== "cls" && options.pooling !== "mean") {
    throw new EmbeddingError(
      "configuration",
      "Workers AI embedding pooling is invalid",
    );
  }

  const binding = options.binding;
  const pooling = options.pooling;
  const limits = embeddingLimits(options, workersAiMaximumInputUtf8Bytes);
  const configuration = Object.freeze({ pooling });
  const metadata: WorkersAiEmbeddingMetadata = Object.freeze({
    provider: "cloudflare-workers-ai",
    model: workersAiEmbeddingModel,
    dimension: workersAiEmbeddingDimension,
    configuration,
    configurationHash: await configurationHash({
      configuration,
      dimension: workersAiEmbeddingDimension,
      model: workersAiEmbeddingModel,
      provider: "cloudflare-workers-ai",
      version: 1,
    }),
  });

  return Object.freeze({
    limits,
    metadata,
    async embed(input: readonly string[]) {
      validateInput(input, limits);
      let response: Ai_Cf_Baai_Bge_Base_En_V1_5_Output;

      try {
        response = await binding.run(workersAiEmbeddingModel, {
          text: [...input],
          pooling,
        });
      } catch (error) {
        throw providerFailure(error, "Workers AI");
      }

      return frozenBatch(
        metadata,
        workersAiVectors(response, input.length, pooling),
      );
    },
  });
}

function normalizedEndpoint(value: string) {
  let endpoint: URL;

  if (typeof value !== "string") {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding endpoint is invalid",
    );
  }

  try {
    endpoint = new URL(value);
  } catch {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding endpoint is invalid",
    );
  }

  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding endpoint is invalid",
    );
  }

  return endpoint.toString();
}

function modelName(value: string) {
  if (typeof value !== "string") {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding model is invalid",
    );
  }

  const model = value.trim();

  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding model is invalid",
    );
  }

  return model;
}

function apiKey(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4_096 ||
    /[\r\n]/u.test(value)
  ) {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding credential is invalid",
    );
  }

  return value;
}

function responseError(status: number) {
  if (status === 401 || status === 403) {
    return new EmbeddingError(
      "authentication",
      "OpenAI-compatible embedding authentication failed",
    );
  }

  if (status === 408 || status === 504) {
    return new EmbeddingError(
      "timeout",
      "OpenAI-compatible embedding request timed out",
    );
  }

  if (status === 429) {
    return new EmbeddingError(
      "rate-limited",
      "OpenAI-compatible embedding provider is rate limited",
    );
  }

  if (status >= 500) {
    return new EmbeddingError(
      "provider-unavailable",
      "OpenAI-compatible embedding provider is unavailable",
    );
  }

  return new EmbeddingError(
    "provider-rejected",
    "OpenAI-compatible embedding provider rejected the request",
  );
}

function openAiCompatibleVectors(
  value: unknown,
  batchSize: number,
  dimension: number,
) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("data" in value) ||
    !Array.isArray(value.data) ||
    value.data.length !== batchSize
  ) {
    throw new EmbeddingError(
      "invalid-response",
      "OpenAI-compatible provider returned an invalid embedding batch",
    );
  }

  const vectors: (readonly number[] | undefined)[] = Array(batchSize);

  for (const entry of value.data) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("index" in entry) ||
      !Number.isSafeInteger(entry.index) ||
      (entry.index as number) < 0 ||
      (entry.index as number) >= batchSize ||
      vectors[entry.index as number] !== undefined ||
      !("embedding" in entry)
    ) {
      throw new EmbeddingError(
        "invalid-response",
        "OpenAI-compatible provider returned invalid embedding indexes",
      );
    }

    vectors[entry.index as number] = validatedVector(
      entry.embedding,
      dimension,
    );
  }

  if (vectors.some((vector) => vector === undefined)) {
    throw new EmbeddingError(
      "invalid-response",
      "OpenAI-compatible provider returned invalid embedding indexes",
    );
  }

  return Object.freeze(vectors as readonly (readonly number[])[]);
}

export async function createOpenAiCompatibleEmbeddingAdapter(
  options: OpenAiCompatibleEmbeddingAdapterOptions,
): Promise<EmbeddingAdapter> {
  const endpoint = normalizedEndpoint(options.endpoint);
  const model = modelName(options.model);
  const dimension = integerSetting(
    options.dimension,
    0,
    hardMaximumDimension,
    "dimension",
  );
  const dimensionsParameter = options.dimensionsParameter ?? false;

  if (typeof dimensionsParameter !== "boolean") {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible dimensions parameter setting is invalid",
    );
  }

  const credential = apiKey(options.apiKey);
  const limits = embeddingLimits(
    options,
    openAiMaximumInputUtf8Bytes,
    openAiMaximumBatchInputUtf8Bytes,
  );
  const timeoutMilliseconds = integerSetting(
    options.timeoutMilliseconds,
    defaultRequestTimeoutMilliseconds,
    hardMaximumTimeoutMilliseconds,
    "timeout",
  );
  const request = options.fetch ?? fetch;

  if (typeof request !== "function") {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible fetch implementation is unavailable",
    );
  }

  const configuration = Object.freeze({
    dimensionsParameter,
    endpoint,
  });
  const metadata: OpenAiCompatibleEmbeddingMetadata = Object.freeze({
    provider: "openai-compatible",
    model,
    dimension,
    configuration,
    configurationHash: await configurationHash({
      configuration,
      dimension,
      model,
      provider: "openai-compatible",
      version: 1,
    }),
  });

  return Object.freeze({
    limits,
    metadata,
    async embed(input: readonly string[]) {
      validateInput(input, limits);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      if (credential) {
        headers.authorization = `Bearer ${credential}`;
      }

      let response: Response;
      const requestBody = {
        ...(dimensionsParameter ? { dimensions: dimension } : {}),
        input: [...input],
        model,
      };

      try {
        response = await request(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        throw providerFailure(error, "OpenAI-compatible");
      }

      if (!response.ok) {
        clearTimeout(timeout);
        throw responseError(response.status);
      }

      let body: unknown;

      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new EmbeddingError(
            "timeout",
            "OpenAI-compatible embedding request timed out",
          );
        }

        throw new EmbeddingError(
          "invalid-response",
          "OpenAI-compatible provider returned invalid JSON",
        );
      } finally {
        clearTimeout(timeout);
      }

      return frozenBatch(
        metadata,
        openAiCompatibleVectors(body, input.length, dimension),
      );
    },
  });
}
