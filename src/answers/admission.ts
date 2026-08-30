// ABOUTME: Converts strict deployment budgets into conservative answer-inference leases.
// ABOUTME: Reconciles provider token usage once while keeping failures and identifiers private.
import type { GenerationMetadata, GenerationUsage } from "@/ai/generation";
import type {
  AnswerInferenceLease,
  AnswerInferenceRepository,
} from "@/db/repository";

const answerInferenceSpendWindowMilliseconds = 24 * 60 * 60 * 1_000;
const answerInferenceRetentionMilliseconds = 31 * 24 * 60 * 60 * 1_000;

const maximumStoredMicrodollars = 2_000_000_000;
const maximumConfiguredInputTokens = 1_000_000;
const maximumConfiguredConcurrency = 100;
const maximumGenerationOutputTokens = 8_192;
const minimumLeaseMilliseconds = 35_000;
const minimumFallbackLeaseMilliseconds = 65_000;
const maximumLeaseMilliseconds = 300_000;
const microdollarsPerPricingUnit = 1_000_000;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u;
const forbiddenTextControls = /[\u0000-\u001f\u007f]/u;

export type AnswerAdmissionEnvironment = {
  OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS?: string;
  OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
  OPAS_ANSWER_LEASE_MILLISECONDS?: string;
  OPAS_ANSWER_MAXIMUM_CONCURRENCY?: string;
  OPAS_ANSWER_MAXIMUM_INPUT_TOKENS?: string;
  OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
  OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
  OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
  OPAS_GENERATION_FALLBACK_ENABLED?: string;
};

export type AnswerAdmissionPolicy = Readonly<{
  dailyBudgetMicrodollars: number;
  inputMicrodollarsPerMillionTokens: number;
  leaseMilliseconds: number;
  maximumConcurrency: number;
  maximumInputTokens: number;
  outputMicrodollarsPerMillionTokens: number;
  primaryInputMicrodollarsPerMillionTokens: number;
  primaryOutputMicrodollarsPerMillionTokens: number;
}>;

export type AnswerInferenceOutcome =
  | "cancelled"
  | "completed"
  | "failed"
  | "invalid-output"
  | "timeout";

export type AnswerInferenceAdmissionRequest = Readonly<{
  maximumOutputTokens: number;
  model: string;
  provider: GenerationMetadata["provider"];
  workspaceId: string;
}>;

export type AnswerInferenceSettlement = Readonly<{
  generation?: Readonly<Pick<GenerationMetadata, "model" | "provider">>;
  outcome: AnswerInferenceOutcome;
  usage?: GenerationUsage;
}>;

export type AnswerInferenceReservation = Readonly<{
  lease: AnswerInferenceLease;
  reconcile(settlement: AnswerInferenceSettlement): Promise<AnswerInferenceLease>;
}>;

export interface AnswerInferenceAdmission {
  reserve(
    request: AnswerInferenceAdmissionRequest,
  ): Promise<AnswerInferenceReservation>;
}

export type AnswerAdmissionErrorCategory =
  | "configuration"
  | "denied"
  | "unavailable";

export class AnswerAdmissionError extends Error {
  readonly category: AnswerAdmissionErrorCategory;

  constructor(category: AnswerAdmissionErrorCategory) {
    super("Answer inference is unavailable");
    this.name = "AnswerAdmissionError";
    this.category = category;
  }
}

function configuredInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new AnswerAdmissionError("configuration");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AnswerAdmissionError("configuration");
  }
  return parsed;
}

function optionalConfiguredValue(value: string | undefined) {
  return value === "" ? undefined : value;
}

function fallbackEnabled(environment: AnswerAdmissionEnvironment) {
  const value = optionalConfiguredValue(
    environment.OPAS_GENERATION_FALLBACK_ENABLED,
  );
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new AnswerAdmissionError("configuration");
}

function tokenCost(tokens: number, rate: number) {
  const numerator = tokens * rate;
  if (!Number.isSafeInteger(numerator)) {
    throw new AnswerAdmissionError("configuration");
  }
  const cost = Math.ceil(numerator / microdollarsPerPricingUnit);
  if (cost > maximumStoredMicrodollars) {
    throw new AnswerAdmissionError("configuration");
  }
  return cost;
}

export function maximumAnswerInferenceCost(
  policy: AnswerAdmissionPolicy,
  maximumOutputTokens: number,
) {
  if (
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > maximumGenerationOutputTokens
  ) {
    throw new AnswerAdmissionError("configuration");
  }
  const cost =
    tokenCost(
      policy.maximumInputTokens,
      policy.inputMicrodollarsPerMillionTokens,
    ) +
    tokenCost(
      maximumOutputTokens,
      policy.outputMicrodollarsPerMillionTokens,
    );
  if (cost < 1 || cost > maximumStoredMicrodollars) {
    throw new AnswerAdmissionError("configuration");
  }
  return cost;
}

export function createAnswerAdmissionPolicy(
  environment: AnswerAdmissionEnvironment,
  maximumOutputTokens: number,
): AnswerAdmissionPolicy {
  const usesFallback = fallbackEnabled(environment);
  const primaryInputPrice = configuredInteger(
    environment.OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
    0,
    maximumStoredMicrodollars,
  );
  const primaryOutputPrice = configuredInteger(
    environment.OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
    0,
    maximumStoredMicrodollars,
  );
  const fallbackInputValue = optionalConfiguredValue(
    environment.OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
  );
  const fallbackOutputValue = optionalConfiguredValue(
    environment.OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
  );
  if (!usesFallback && (fallbackInputValue || fallbackOutputValue)) {
    throw new AnswerAdmissionError("configuration");
  }
  const fallbackInputPrice = usesFallback
    ? configuredInteger(
        fallbackInputValue,
        0,
        maximumStoredMicrodollars,
      )
    : 0;
  const fallbackOutputPrice = usesFallback
    ? configuredInteger(
        fallbackOutputValue,
        0,
        maximumStoredMicrodollars,
      )
    : 0;
  const policy = Object.freeze({
    dailyBudgetMicrodollars: configuredInteger(
      environment.OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS,
      1,
      maximumStoredMicrodollars,
    ),
    inputMicrodollarsPerMillionTokens:
      primaryInputPrice + fallbackInputPrice,
    leaseMilliseconds: configuredInteger(
      environment.OPAS_ANSWER_LEASE_MILLISECONDS,
      usesFallback
        ? minimumFallbackLeaseMilliseconds
        : minimumLeaseMilliseconds,
      maximumLeaseMilliseconds,
    ),
    maximumConcurrency: configuredInteger(
      environment.OPAS_ANSWER_MAXIMUM_CONCURRENCY,
      1,
      maximumConfiguredConcurrency,
    ),
    maximumInputTokens: configuredInteger(
      environment.OPAS_ANSWER_MAXIMUM_INPUT_TOKENS,
      1,
      maximumConfiguredInputTokens,
    ),
    outputMicrodollarsPerMillionTokens:
      primaryOutputPrice + fallbackOutputPrice,
    primaryInputMicrodollarsPerMillionTokens: primaryInputPrice,
    primaryOutputMicrodollarsPerMillionTokens: primaryOutputPrice,
  });
  if (
    (primaryInputPrice === 0 && primaryOutputPrice === 0) ||
    (usesFallback && fallbackInputPrice === 0 && fallbackOutputPrice === 0) ||
    policy.inputMicrodollarsPerMillionTokens === 0 &&
    policy.outputMicrodollarsPerMillionTokens === 0
  ) {
    throw new AnswerAdmissionError("configuration");
  }
  if (
    maximumAnswerInferenceCost(policy, maximumOutputTokens) >
    policy.dailyBudgetMicrodollars
  ) {
    throw new AnswerAdmissionError("configuration");
  }
  return policy;
}

function validIdentity(value: string, maximumUtf8Bytes: number) {
  return (
    identifierPattern.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumUtf8Bytes
  );
}

function validText(value: string, maximumUtf8Bytes: number) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !forbiddenTextControls.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumUtf8Bytes
  );
}

function validDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function actualCharge(
  policy: AnswerAdmissionPolicy,
  lease: AnswerInferenceLease,
  settlement: AnswerInferenceSettlement,
) {
  if (settlement.generation) {
    return {
      chargedMicrodollars: lease.reservedMicrodollars,
      inputTokens: null,
      outputTokens: null,
    };
  }
  const usage = settlement.usage;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const totalTokens = usage?.totalTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    (totalTokens !== null && !Number.isSafeInteger(totalTokens)) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0 ||
    (totalTokens !== null &&
      totalTokens !== (inputTokens as number) + (outputTokens as number)) ||
    (inputTokens as number) > policy.maximumInputTokens ||
    (outputTokens as number) > lease.maximumOutputTokens
  ) {
    return {
      chargedMicrodollars: lease.reservedMicrodollars,
      inputTokens: null,
      outputTokens: null,
    };
  }
  const chargedMicrodollars =
    tokenCost(
      inputTokens as number,
      policy.primaryInputMicrodollarsPerMillionTokens,
    ) +
    tokenCost(
      outputTokens as number,
      policy.primaryOutputMicrodollarsPerMillionTokens,
    );
  if (chargedMicrodollars > lease.reservedMicrodollars) {
    return {
      chargedMicrodollars: lease.reservedMicrodollars,
      inputTokens: null,
      outputTokens: null,
    };
  }
  return {
    chargedMicrodollars,
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
  };
}

type AnswerInferenceAdmissionOptions = {
  createId?: () => string;
  now?: () => Date;
  policy: AnswerAdmissionPolicy;
  repository: AnswerInferenceRepository;
};

export function createAnswerInferenceAdmission(
  options: AnswerInferenceAdmissionOptions,
): AnswerInferenceAdmission {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async reserve(request: AnswerInferenceAdmissionRequest) {
      if (
        request === null ||
        typeof request !== "object" ||
        !validIdentity(request.workspaceId, 200) ||
        !validIdentity(request.provider, 64) ||
        !validText(request.model, 256) ||
        !Number.isSafeInteger(request.maximumOutputTokens) ||
        request.maximumOutputTokens < 1 ||
        request.maximumOutputTokens > maximumGenerationOutputTokens
      ) {
        throw new AnswerAdmissionError("configuration");
      }
      const id = createId();
      const startedAt = now();
      if (!validIdentity(id, 200) || !validDate(startedAt)) {
        throw new AnswerAdmissionError("configuration");
      }
      const reservedMicrodollars = maximumAnswerInferenceCost(
        options.policy,
        request.maximumOutputTokens,
      );
      let lease: AnswerInferenceLease | null;
      try {
        lease = await options.repository.reserveAnswerInference({
          id,
          workspaceId: request.workspaceId,
          provider: request.provider,
          model: request.model,
          maximumOutputTokens: request.maximumOutputTokens,
          reservedMicrodollars,
          maximumConcurrency: options.policy.maximumConcurrency,
          dailyBudgetMicrodollars: options.policy.dailyBudgetMicrodollars,
          startedAt,
          expiresAt: new Date(
            startedAt.getTime() + options.policy.leaseMilliseconds,
          ),
          spendWindowStartedAt: new Date(
            startedAt.getTime() - answerInferenceSpendWindowMilliseconds,
          ),
          retentionStartedAt: new Date(
            startedAt.getTime() - answerInferenceRetentionMilliseconds,
          ),
        });
      } catch {
        throw new AnswerAdmissionError("unavailable");
      }
      if (!lease) throw new AnswerAdmissionError("denied");

      let reconciliation: Promise<AnswerInferenceLease> | undefined;
      const reservation: AnswerInferenceReservation = Object.freeze({
        lease: Object.freeze({ ...lease }),
        reconcile(settlement: AnswerInferenceSettlement) {
          if (reconciliation) return reconciliation;
          reconciliation = (async () => {
            const reconciledAt = now();
            if (!validDate(reconciledAt)) {
              throw new AnswerAdmissionError("configuration");
            }
            const charge = actualCharge(
              options.policy,
              lease!,
              settlement,
            );
            let settled: AnswerInferenceLease | null;
            try {
              settled = await options.repository.reconcileAnswerInference({
                id: lease!.id,
                workspaceId: lease!.workspaceId,
                status: settlement.outcome,
                ...charge,
                reconciledAt,
              });
            } catch {
              throw new AnswerAdmissionError("unavailable");
            }
            if (!settled) throw new AnswerAdmissionError("unavailable");
            return Object.freeze({ ...settled });
          })();
          return reconciliation;
        },
      });
      return reservation;
    },
  });
}
