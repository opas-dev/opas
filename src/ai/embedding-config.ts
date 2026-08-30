// ABOUTME: Selects and validates the embedding provider for each deployment target.
// ABOUTME: Keeps provider credentials out of the persisted embedding configuration metadata.
import {
  EmbeddingError,
  createOpenAiCompatibleEmbeddingAdapter,
  createWorkersAiEmbeddingAdapter,
  type EmbeddingAdapter,
  type WorkersAiEmbeddingBinding,
} from "@/ai/embeddings";

export type EmbeddingEnvironment = {
  OPAS_DATABASE_DRIVER?: string;
  OPAS_EMBEDDING_API_KEY?: string;
  OPAS_EMBEDDING_DIMENSION?: string;
  OPAS_EMBEDDING_DIMENSIONS_PARAMETER?: string;
  OPAS_EMBEDDING_ENDPOINT?: string;
  OPAS_EMBEDDING_MODEL?: string;
};

export type EmbeddingAdapterConfiguration = {
  environment?: EmbeddingEnvironment;
  fetch?: typeof fetch;
  workersAiBinding?: WorkersAiEmbeddingBinding;
};

function optionalEnvironmentValue(value: string | undefined) {
  return value === "" ? undefined : value;
}

function configuredDimension(value: string | undefined) {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding dimension is invalid",
    );
  }

  const dimension = Number(value);

  if (!Number.isSafeInteger(dimension)) {
    throw new EmbeddingError(
      "configuration",
      "OpenAI-compatible embedding dimension is invalid",
    );
  }

  return dimension;
}

function configuredDimensionsParameter(value: string | undefined) {
  if (value === undefined || value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  throw new EmbeddingError(
    "configuration",
    "OpenAI-compatible dimensions parameter setting is invalid",
  );
}

export async function createEmbeddingAdapter(
  configuration: EmbeddingAdapterConfiguration = {},
): Promise<EmbeddingAdapter> {
  const environment = configuration.environment ?? process.env;
  const databaseDriver = environment.OPAS_DATABASE_DRIVER ?? "postgres";

  if (databaseDriver === "d1") {
    if (configuration.workersAiBinding === undefined) {
      throw new EmbeddingError(
        "configuration",
        "Workers AI embedding binding is unavailable",
      );
    }

    return createWorkersAiEmbeddingAdapter({
      binding: configuration.workersAiBinding,
      pooling: "cls",
    });
  }

  if (databaseDriver === "neon" || databaseDriver === "postgres") {
    return createOpenAiCompatibleEmbeddingAdapter({
      apiKey: optionalEnvironmentValue(environment.OPAS_EMBEDDING_API_KEY),
      dimension: configuredDimension(environment.OPAS_EMBEDDING_DIMENSION),
      dimensionsParameter: configuredDimensionsParameter(
        environment.OPAS_EMBEDDING_DIMENSIONS_PARAMETER,
      ),
      endpoint: environment.OPAS_EMBEDDING_ENDPOINT ?? "",
      fetch: configuration.fetch,
      model: environment.OPAS_EMBEDDING_MODEL ?? "",
    });
  }

  throw new EmbeddingError(
    "configuration",
    "Embedding database driver is unsupported",
  );
}
