// ABOUTME: Selects and validates the answer-generation provider for each deployment target.
// ABOUTME: Exposes only immutable provider identity and retention disclosure to public clients.
import {
  createGenerationFallbackAdapter,
  createOpenAiCompatibleGenerationAdapter,
  createWorkersAiGenerationAdapter,
  GenerationError,
  type GenerationAdapter,
  type GenerationMetadata,
  type WorkersAiGenerationBinding,
} from "@/ai/generation";

export type GenerationEnvironment = {
  OPAS_DATABASE_DRIVER?: string;
  OPAS_GENERATION_API_KEY?: string;
  OPAS_GENERATION_ENDPOINT?: string;
  OPAS_GENERATION_GATEWAY_ID?: string;
  OPAS_GENERATION_MODEL?: string;
  OPAS_GENERATION_RETENTION_DISCLOSURE?: string;
  OPAS_GENERATION_FALLBACK_API_KEY?: string;
  OPAS_GENERATION_FALLBACK_ENABLED?: string;
  OPAS_GENERATION_FALLBACK_ENDPOINT?: string;
  OPAS_GENERATION_FALLBACK_GATEWAY_ID?: string;
  OPAS_GENERATION_FALLBACK_MODEL?: string;
  OPAS_GENERATION_FALLBACK_PROVIDER?: string;
  OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE?: string;
};

export type GenerationAdapterConfiguration = {
  environment?: GenerationEnvironment;
  fetch?: typeof fetch;
  workersAiBinding?: WorkersAiGenerationBinding;
};

export type PublicGenerationMetadata = Readonly<GenerationMetadata>;

function optionalEnvironmentValue(value: string | undefined) {
  return value === "" ? undefined : value;
}

const fallbackConfigurationKeys = [
  "OPAS_GENERATION_FALLBACK_API_KEY",
  "OPAS_GENERATION_FALLBACK_ENDPOINT",
  "OPAS_GENERATION_FALLBACK_GATEWAY_ID",
  "OPAS_GENERATION_FALLBACK_MODEL",
  "OPAS_GENERATION_FALLBACK_PROVIDER",
  "OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE",
] as const;

function fallbackEnabled(environment: GenerationEnvironment) {
  const value = optionalEnvironmentValue(
    environment.OPAS_GENERATION_FALLBACK_ENABLED,
  );
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new GenerationError(
    "configuration",
    "Generation fallback opt-in is invalid",
  );
}

function hasFallbackConfiguration(environment: GenerationEnvironment) {
  return fallbackConfigurationKeys.some(
    (key) => optionalEnvironmentValue(environment[key]) !== undefined,
  );
}

function configuredFallbackProvider(environment: GenerationEnvironment) {
  const provider = optionalEnvironmentValue(
    environment.OPAS_GENERATION_FALLBACK_PROVIDER,
  );
  if (
    provider !== "cloudflare-workers-ai" &&
    provider !== "openai-compatible"
  ) {
    throw new GenerationError(
      "configuration",
      "Generation fallback provider is invalid",
    );
  }
  return provider;
}

function rejectCredentialDisclosure(environment: GenerationEnvironment) {
  const credentials = [
    environment.OPAS_GENERATION_API_KEY,
    environment.OPAS_GENERATION_FALLBACK_API_KEY,
  ].filter((value): value is string => Boolean(value));
  const publicValues = [
    environment.OPAS_GENERATION_MODEL,
    environment.OPAS_GENERATION_RETENTION_DISCLOSURE,
    environment.OPAS_GENERATION_FALLBACK_MODEL,
    environment.OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE,
  ];
  if (
    credentials.some((credential) =>
      publicValues.some((value) => value?.includes(credential)),
    )
  ) {
    throw new GenerationError(
      "configuration",
      "Generation public disclosure is invalid",
    );
  }
}

function primaryGenerationAdapter(
  configuration: GenerationAdapterConfiguration,
  environment: GenerationEnvironment,
) {
  const databaseDriver = environment.OPAS_DATABASE_DRIVER ?? "postgres";
  if (databaseDriver === "d1") {
    return createWorkersAiGenerationAdapter({
      binding: configuration.workersAiBinding!,
      gatewayId: environment.OPAS_GENERATION_GATEWAY_ID ?? "",
      model: environment.OPAS_GENERATION_MODEL ?? "",
      retentionDisclosure:
        environment.OPAS_GENERATION_RETENTION_DISCLOSURE ?? "",
    });
  }

  if (databaseDriver === "neon" || databaseDriver === "postgres") {
    return createOpenAiCompatibleGenerationAdapter({
      apiKey: optionalEnvironmentValue(environment.OPAS_GENERATION_API_KEY),
      endpoint: environment.OPAS_GENERATION_ENDPOINT ?? "",
      fetch: configuration.fetch,
      model: environment.OPAS_GENERATION_MODEL ?? "",
      retentionDisclosure:
        environment.OPAS_GENERATION_RETENTION_DISCLOSURE ?? "",
    });
  }

  throw new GenerationError(
    "configuration",
    "Generation database driver is unsupported",
  );
}

function fallbackGenerationAdapter(
  configuration: GenerationAdapterConfiguration,
  environment: GenerationEnvironment,
) {
  const provider = configuredFallbackProvider(environment);
  if (provider === "cloudflare-workers-ai") {
    if (
      optionalEnvironmentValue(environment.OPAS_GENERATION_FALLBACK_ENDPOINT) ||
      optionalEnvironmentValue(environment.OPAS_GENERATION_FALLBACK_API_KEY)
    ) {
      throw new GenerationError(
        "configuration",
        "Generation fallback provider configuration is invalid",
      );
    }
    return createWorkersAiGenerationAdapter({
      binding: configuration.workersAiBinding!,
      gatewayId: environment.OPAS_GENERATION_FALLBACK_GATEWAY_ID ?? "",
      model: environment.OPAS_GENERATION_FALLBACK_MODEL ?? "",
      retentionDisclosure:
      environment.OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE ?? "",
    });
  }
  if (
    optionalEnvironmentValue(environment.OPAS_GENERATION_FALLBACK_GATEWAY_ID)
  ) {
    throw new GenerationError(
      "configuration",
      "Generation fallback provider configuration is invalid",
    );
  }
  return createOpenAiCompatibleGenerationAdapter({
    apiKey: optionalEnvironmentValue(
      environment.OPAS_GENERATION_FALLBACK_API_KEY,
    ),
    endpoint: environment.OPAS_GENERATION_FALLBACK_ENDPOINT ?? "",
    fetch: configuration.fetch,
    model: environment.OPAS_GENERATION_FALLBACK_MODEL ?? "",
    retentionDisclosure:
      environment.OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE ?? "",
  });
}

export function generationUsesWorkersAiBinding(
  environment: GenerationEnvironment,
) {
  const databaseDriver = environment.OPAS_DATABASE_DRIVER ?? "postgres";
  if (databaseDriver === "d1") return true;
  return (
    fallbackEnabled(environment) &&
    configuredFallbackProvider(environment) === "cloudflare-workers-ai"
  );
}

export function createGenerationAdapter(
  configuration: GenerationAdapterConfiguration = {},
): GenerationAdapter {
  const environment = configuration.environment ?? process.env;
  rejectCredentialDisclosure(environment);
  const primary = primaryGenerationAdapter(configuration, environment);
  if (!fallbackEnabled(environment)) {
    if (hasFallbackConfiguration(environment)) {
      throw new GenerationError(
        "configuration",
        "Generation fallback requires explicit opt-in",
      );
    }
    return primary;
  }
  const fallback = fallbackGenerationAdapter(configuration, environment);
  return createGenerationFallbackAdapter({ fallback, primary });
}

export function generationPublicMetadata(
  adapter: Pick<GenerationAdapter, "metadata">,
): PublicGenerationMetadata {
  return Object.freeze({
    model: adapter.metadata.model,
    provider: adapter.metadata.provider,
    retentionDisclosure: adapter.metadata.retentionDisclosure,
  });
}
