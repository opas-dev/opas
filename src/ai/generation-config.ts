// ABOUTME: Selects and validates the answer-generation provider for each deployment target.
// ABOUTME: Exposes only immutable provider identity and retention disclosure to public clients.
import {
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

function rejectCredentialDisclosure(environment: GenerationEnvironment) {
  const credential = environment.OPAS_GENERATION_API_KEY;
  if (
    credential &&
    [
      environment.OPAS_GENERATION_MODEL,
      environment.OPAS_GENERATION_RETENTION_DISCLOSURE,
    ].some((value) => value?.includes(credential))
  ) {
    throw new GenerationError(
      "configuration",
      "Generation public disclosure is invalid",
    );
  }
}

export function createGenerationAdapter(
  configuration: GenerationAdapterConfiguration = {},
): GenerationAdapter {
  const environment = configuration.environment ?? process.env;
  const databaseDriver = environment.OPAS_DATABASE_DRIVER ?? "postgres";
  rejectCredentialDisclosure(environment);

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

export function generationPublicMetadata(
  adapter: Pick<GenerationAdapter, "metadata">,
): PublicGenerationMetadata {
  return Object.freeze({
    model: adapter.metadata.model,
    provider: adapter.metadata.provider,
    retentionDisclosure: adapter.metadata.retentionDisclosure,
  });
}
