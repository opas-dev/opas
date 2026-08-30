// ABOUTME: Defines bounded streaming text generation across Cloudflare and portable providers.
// ABOUTME: Normalizes provider events while keeping prompts, credentials, and raw failures private.
import type { Ai } from "@cloudflare/workers-types";

const defaults = {
  maximumInputUtf8Bytes: 65_536,
  maximumMessages: 16,
  maximumOutputTokens: 1_024,
  maximumOutputUtf8Bytes: 65_536,
  timeoutMilliseconds: 30_000,
} as const;

const hardMaximums = {
  maximumInputUtf8Bytes: 262_144,
  maximumMessages: 64,
  maximumOutputTokens: 8_192,
  maximumOutputUtf8Bytes: 262_144,
  timeoutMilliseconds: 120_000,
} as const;

const utf8Encoder = new TextEncoder();

export type GenerationErrorCategory =
  | "authentication"
  | "cancelled"
  | "configuration"
  | "invalid-input"
  | "invalid-response"
  | "output-limit"
  | "provider-rejected"
  | "provider-unavailable"
  | "rate-limited"
  | "timeout";

export class GenerationError extends Error {
  readonly category: GenerationErrorCategory;
  readonly retryable: boolean;

  constructor(category: GenerationErrorCategory, message: string) {
    super(message);
    this.name = "GenerationError";
    this.category = category;
    this.retryable = ["provider-unavailable", "rate-limited", "timeout"].includes(
      category,
    );
  }
}

export type GenerationRole = "assistant" | "system" | "user";
export type GenerationMessage = Readonly<{
  content: string;
  role: GenerationRole;
}>;
export type GenerationRequest = Readonly<{
  maximumOutputTokens?: number;
  messages: readonly GenerationMessage[];
  observeProvider?: (metadata: GenerationMetadata) => void;
  signal?: AbortSignal;
  temperature?: number;
}>;
export type GenerationUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;
export type GenerationFinishReason =
  | "content-filter"
  | "length"
  | "stop"
  | "tool-call"
  | "unknown";
export type GenerationEvent =
  | Readonly<{ text: string; type: "text" }>
  | Readonly<{
      reason: GenerationFinishReason;
      type: "finish";
      usage: GenerationUsage;
    }>;
export type GenerationLimits = Readonly<{
  maximumInputUtf8Bytes: number;
  maximumMessages: number;
  maximumOutputTokens: number;
  maximumOutputUtf8Bytes: number;
  timeoutMilliseconds: number;
}>;

export type GenerationMetadata = Readonly<{
  model: string;
  provider: "cloudflare-workers-ai" | "openai-compatible";
  retentionDisclosure: string;
}>;

export interface GenerationAdapter {
  readonly fallbackMetadata?: GenerationMetadata;
  readonly limits: GenerationLimits;
  readonly metadata: GenerationMetadata;
  stream(request: GenerationRequest): AsyncIterable<GenerationEvent>;
}

export type GenerationFallbackAdapterOptions = Readonly<{
  fallback: GenerationAdapter;
  primary: GenerationAdapter;
}>;

export type WorkersAiGenerationBinding = Pick<Ai, "run">;

type GenerationLimitOptions = Partial<GenerationLimits>;
export type WorkersAiGenerationAdapterOptions = GenerationLimitOptions & {
  binding: WorkersAiGenerationBinding;
  gatewayId: string;
  model: string;
  retentionDisclosure: string;
};
export type OpenAiCompatibleGenerationAdapterOptions =
  GenerationLimitOptions & {
    apiKey?: string;
    endpoint: string;
    fetch?: typeof fetch;
    model: string;
    retentionDisclosure: string;
  };

type PreparedRequest = {
  maximumOutputTokens: number;
  messages: readonly GenerationMessage[];
  signal?: AbortSignal;
  temperature: number;
};

function configuredInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
) {
  const configured = value ?? fallback;
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
    throw new GenerationError(
      "configuration",
      `Generation ${name} is outside the supported range`,
    );
  }
  return configured;
}

function generationLimits(options: GenerationLimitOptions): GenerationLimits {
  return Object.freeze({
    maximumInputUtf8Bytes: configuredInteger(
      options.maximumInputUtf8Bytes,
      defaults.maximumInputUtf8Bytes,
      hardMaximums.maximumInputUtf8Bytes,
      "input size",
    ),
    maximumMessages: configuredInteger(
      options.maximumMessages,
      defaults.maximumMessages,
      hardMaximums.maximumMessages,
      "message count",
    ),
    maximumOutputTokens: configuredInteger(
      options.maximumOutputTokens,
      defaults.maximumOutputTokens,
      hardMaximums.maximumOutputTokens,
      "output token count",
    ),
    maximumOutputUtf8Bytes: configuredInteger(
      options.maximumOutputUtf8Bytes,
      defaults.maximumOutputUtf8Bytes,
      hardMaximums.maximumOutputUtf8Bytes,
      "output size",
    ),
    timeoutMilliseconds: configuredInteger(
      options.timeoutMilliseconds,
      defaults.timeoutMilliseconds,
      hardMaximums.timeoutMilliseconds,
      "timeout",
    ),
  });
}

function configuredText(value: string, name: string, maximumUtf8Bytes: number) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    utf8Encoder.encode(value).byteLength > maximumUtf8Bytes
  ) {
    throw new GenerationError("configuration", `Generation ${name} is invalid`);
  }
  return value;
}

function configuredGatewayId(value: string) {
  const id = configuredText(value, "Gateway ID", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new GenerationError("configuration", "Generation Gateway ID is invalid");
  }
  return id;
}

function configuredEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new GenerationError("configuration", "Generation endpoint is invalid");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new GenerationError("configuration", "Generation endpoint is invalid");
  }
  return endpoint.toString();
}

function configuredApiKey(value: string | undefined) {
  if (value === undefined) return undefined;
  if (
    !value.trim() ||
    /[\r\n]/u.test(value) ||
    utf8Encoder.encode(value).byteLength > 16_384
  ) {
    throw new GenerationError(
      "configuration",
      "Generation provider credential is invalid",
    );
  }
  return value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

function prepareRequest(request: GenerationRequest, limits: GenerationLimits) {
  if (
    request === null ||
    typeof request !== "object" ||
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    request.messages.length > limits.maximumMessages
  ) {
    throw new GenerationError(
      "invalid-input",
      "Generation input has an invalid message count",
    );
  }

  let inputUtf8Bytes = 0;
  const messages = request.messages.map((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      !["assistant", "system", "user"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw new GenerationError(
        "invalid-input",
        "Generation input contains an invalid message",
      );
    }
    inputUtf8Bytes += utf8Encoder.encode(message.content).byteLength;
    return Object.freeze({ content: message.content, role: message.role });
  });
  if (inputUtf8Bytes > limits.maximumInputUtf8Bytes) {
    throw new GenerationError(
      "invalid-input",
      "Generation input exceeds the configured size",
    );
  }

  const maximumOutputTokens =
    request.maximumOutputTokens ?? limits.maximumOutputTokens;
  if (
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > limits.maximumOutputTokens
  ) {
    throw new GenerationError(
      "invalid-input",
      "Generation output token count is outside the configured range",
    );
  }
  const temperature = request.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new GenerationError(
      "invalid-input",
      "Generation temperature is outside the supported range",
    );
  }
  if (request.signal !== undefined && !isAbortSignal(request.signal)) {
    throw new GenerationError(
      "invalid-input",
      "Generation cancellation signal is invalid",
    );
  }
  return {
    maximumOutputTokens,
    messages: Object.freeze(messages),
    signal: request.signal,
    temperature,
  } satisfies PreparedRequest;
}

function requestControl(callerSignal: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const cancel = () => {
    cancelled = true;
    controller.abort();
  };
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const abortError = () =>
    timedOut
      ? new GenerationError("timeout", "Generation request timed out")
      : cancelled
        ? new GenerationError("cancelled", "Generation request was cancelled")
        : new GenerationError(
            "provider-unavailable",
            "Generation provider request failed",
          );

  async function wait<T>(promise: Promise<T>) {
    if (controller.signal.aborted) throw abortError();
    let listener: () => void = () => {};
    const abort = new Promise<never>((_, reject) => {
      listener = () => reject(abortError());
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    try {
      return await Promise.race([promise, abort]);
    } finally {
      controller.signal.removeEventListener("abort", listener);
    }
  }

  return {
    abortError,
    close() {
      controller.abort();
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    },
    signal: controller.signal,
    wait,
  };
}

type RequestControl = ReturnType<typeof requestControl>;

function safeProviderError(error: unknown, control: RequestControl) {
  if (error instanceof GenerationError) return error;
  return control.signal.aborted
    ? control.abortError()
    : new GenerationError(
        "provider-unavailable",
        "Generation provider request failed",
      );
}

function responseError(status: number) {
  if (status === 401 || status === 403) {
    return new GenerationError(
      "authentication",
      "Generation provider authentication failed",
    );
  }
  if (status === 429) {
    return new GenerationError(
      "rate-limited",
      "Generation provider rate limit was reached",
    );
  }
  if (status === 408 || status >= 500) {
    return new GenerationError(
      "provider-unavailable",
      "Generation provider is unavailable",
    );
  }
  return new GenerationError(
    "provider-rejected",
    "Generation provider rejected the request",
  );
}

function readableStream(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("getReader" in value) ||
    typeof value.getReader !== "function"
  ) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned an invalid stream",
    );
  }
  return value as ReadableStream<Uint8Array>;
}

function sseBlock(block: string, maximumUtf8Bytes: number) {
  const data: string[] = [];
  let name: string | null = null;
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") data.push(value);
    else if (field === "event") name = value;
  }
  if (data.length === 0) return null;
  const value = data.join("\n");
  if (utf8Encoder.encode(value).byteLength > maximumUtf8Bytes) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned an oversized stream event",
    );
  }
  return { data: value, name };
}

async function* sseEvents(
  streamValue: unknown,
  maximumUtf8Bytes: number,
  control: RequestControl,
) {
  const reader = readableStream(streamValue).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      const result = await control.wait(reader.read());
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new GenerationError(
          "invalid-response",
          "Generation provider returned an invalid stream chunk",
        );
      }
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        throw new GenerationError(
          "invalid-response",
          "Generation provider returned invalid UTF-8",
        );
      }
      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary?.index !== undefined) {
        const event = sseBlock(buffer.slice(0, boundary.index), maximumUtf8Bytes);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) yield event;
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
      if (utf8Encoder.encode(buffer).byteLength > maximumUtf8Bytes) {
        throw new GenerationError(
          "invalid-response",
          "Generation provider returned an oversized stream event",
        );
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw new GenerationError(
        "invalid-response",
        "Generation provider returned invalid UTF-8",
      );
    }
    if (buffer.trim()) {
      const event = sseBlock(buffer, maximumUtf8Bytes);
      if (event) yield event;
    }
  } catch (error) {
    throw safeProviderError(error, control);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancellation only releases provider resources; the surfaced error is sanitized above.
    }
    reader.releaseLock();
  }
}

function tokenCount(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned invalid token usage",
    );
  }
  return value as number;
}

function normalizedUsage(value: unknown): GenerationUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned invalid usage metadata",
    );
  }
  const record = value as Record<string, unknown>;
  const usage = Object.freeze({
    inputTokens: tokenCount(record.prompt_tokens ?? record.input_tokens),
    outputTokens: tokenCount(record.completion_tokens ?? record.output_tokens),
    totalTokens: tokenCount(record.total_tokens),
  });
  if (Object.values(usage).every((count) => count === null)) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned empty usage metadata",
    );
  }
  return usage;
}

function normalizedFinishReason(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned an invalid finish reason",
    );
  }
  const reasons: Record<string, GenerationFinishReason> = {
    "content-filter": "content-filter",
    content_filter: "content-filter",
    end_turn: "stop",
    function_call: "tool-call",
    length: "length",
    max_tokens: "length",
    stop: "stop",
    tool_calls: "tool-call",
  };
  return reasons[value] ?? "unknown";
}

function normalizedProviderEvent(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned an invalid stream event",
    );
  }
  const record = value as Record<string, unknown>;
  if ("error" in record) {
    throw new GenerationError(
      "provider-rejected",
      "Generation provider rejected the streamed request",
    );
  }

  let recognized = false;
  let text: string | undefined;
  let finishReason = normalizedFinishReason(
    record.finish_reason ?? record.finishReason,
  );
  const usage = normalizedUsage(record.usage);
  if ("response" in record) {
    recognized = true;
    if (typeof record.response !== "string") {
      throw new GenerationError(
        "invalid-response",
        "Generation provider returned invalid streamed text",
      );
    }
    text = record.response;
  }
  if ("choices" in record) {
    recognized = true;
    if (!Array.isArray(record.choices) || record.choices.length > 1) {
      throw new GenerationError(
        "invalid-response",
        "Generation provider returned invalid stream choices",
      );
    }
    const choice = record.choices[0];
    if (choice !== undefined) {
      if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
        throw new GenerationError(
          "invalid-response",
          "Generation provider returned an invalid stream choice",
        );
      }
      const choiceRecord = choice as Record<string, unknown>;
      finishReason = normalizedFinishReason(choiceRecord.finish_reason);
      const delta = choiceRecord.delta;
      if (delta !== undefined && delta !== null) {
        if (typeof delta !== "object" || Array.isArray(delta)) {
          throw new GenerationError(
            "invalid-response",
            "Generation provider returned an invalid stream delta",
          );
        }
        const content = (delta as Record<string, unknown>).content;
        if (content !== undefined && content !== null) {
          if (typeof content !== "string") {
            throw new GenerationError(
              "invalid-response",
              "Generation provider returned invalid streamed text",
            );
          }
          text = content;
        }
      }
    }
  }
  if (!recognized && finishReason === undefined && usage === undefined) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider returned an empty stream event",
    );
  }
  return { finishReason, text, usage };
}

async function* normalizedEvents(
  stream: unknown,
  limits: GenerationLimits,
  control: RequestControl,
): AsyncIterable<GenerationEvent> {
  let finishReason: GenerationFinishReason | undefined;
  let outputUtf8Bytes = 0;
  let sawDone = false;
  let usage: GenerationUsage | undefined;
  for await (const event of sseEvents(
    stream,
    limits.maximumOutputUtf8Bytes + 32_768,
    control,
  )) {
    if (sawDone) {
      throw new GenerationError(
        "invalid-response",
        "Generation provider sent data after completion",
      );
    }
    if (event.name === "error") {
      throw new GenerationError(
        "provider-rejected",
        "Generation provider rejected the streamed request",
      );
    }
    if (event.data === "[DONE]") {
      sawDone = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      throw new GenerationError(
        "invalid-response",
        "Generation provider returned malformed stream data",
      );
    }
    const normalized = normalizedProviderEvent(parsed);
    finishReason = normalized.finishReason ?? finishReason;
    usage = normalized.usage ?? usage;
    if (normalized.text) {
      outputUtf8Bytes += utf8Encoder.encode(normalized.text).byteLength;
      if (outputUtf8Bytes > limits.maximumOutputUtf8Bytes) {
        throw new GenerationError(
          "output-limit",
          "Generation output exceeds the configured size",
        );
      }
      yield Object.freeze({ text: normalized.text, type: "text" });
    }
  }
  if (!sawDone) {
    throw new GenerationError(
      "invalid-response",
      "Generation provider stream ended before completion",
    );
  }
  yield Object.freeze({
    reason: finishReason ?? "stop",
    type: "finish",
    usage:
      usage ??
      Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
  });
}

async function* providerStream(
  limits: GenerationLimits,
  request: GenerationRequest,
  open: (
    prepared: PreparedRequest,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>,
) {
  const prepared = prepareRequest(request, limits);
  const control = requestControl(prepared.signal, limits.timeoutMilliseconds);
  try {
    if (control.signal.aborted) throw control.abortError();
    const stream = await control.wait(open(prepared, control.signal));
    yield* normalizedEvents(stream, limits, control);
  } catch (error) {
    throw safeProviderError(error, control);
  } finally {
    control.close();
  }
}

type WorkersRun = (
  model: string,
  input: {
    max_tokens: number;
    messages: readonly GenerationMessage[];
    stream: true;
    temperature: number;
  },
  options: {
    gateway: { collectLog: false; id: string; skipCache: true };
    signal: AbortSignal;
  },
) => Promise<ReadableStream<Uint8Array>>;

function metadata(
  provider: GenerationMetadata["provider"],
  model: string,
  retentionDisclosure: string,
) {
  return Object.freeze({ provider, model, retentionDisclosure });
}

function sharedGenerationLimits(
  primary: GenerationLimits,
  fallback: GenerationLimits,
) {
  return Object.freeze({
    maximumInputUtf8Bytes: Math.min(
      primary.maximumInputUtf8Bytes,
      fallback.maximumInputUtf8Bytes,
    ),
    maximumMessages: Math.min(
      primary.maximumMessages,
      fallback.maximumMessages,
    ),
    maximumOutputTokens: Math.min(
      primary.maximumOutputTokens,
      fallback.maximumOutputTokens,
    ),
    maximumOutputUtf8Bytes: Math.min(
      primary.maximumOutputUtf8Bytes,
      fallback.maximumOutputUtf8Bytes,
    ),
    timeoutMilliseconds:
      primary.timeoutMilliseconds + fallback.timeoutMilliseconds,
  });
}

function fallbackDisclosure(
  primary: GenerationMetadata,
  fallback: GenerationMetadata,
) {
  return configuredText(
    `${primary.retentionDisclosure} If that provider fails before answer output, OPAS may use ${fallback.provider} model ${fallback.model}. ${fallback.retentionDisclosure}`,
    "fallback retention disclosure",
    1_024,
  );
}

function eligibleFallbackFailure(error: unknown) {
  return error instanceof GenerationError && error.retryable;
}

async function* fallbackStream(
  options: GenerationFallbackAdapterOptions,
  request: GenerationRequest,
) {
  let primaryProducedEvent = false;
  try {
    request.observeProvider?.(options.primary.metadata);
    for await (const event of options.primary.stream(request)) {
      primaryProducedEvent = true;
      yield event;
    }
  } catch (error) {
    if (
      primaryProducedEvent ||
      request.signal?.aborted ||
      !eligibleFallbackFailure(error)
    ) {
      throw error;
    }
    request.observeProvider?.(options.fallback.metadata);
    yield* options.fallback.stream(request);
  }
}

export function createGenerationFallbackAdapter(
  options: GenerationFallbackAdapterOptions,
): GenerationAdapter {
  if (
    !options?.primary ||
    !options?.fallback ||
    options.primary.metadata.provider === options.fallback.metadata.provider ||
    options.primary.fallbackMetadata ||
    options.fallback.fallbackMetadata
  ) {
    throw new GenerationError(
      "configuration",
      "Generation fallback configuration is invalid",
    );
  }
  const limits = sharedGenerationLimits(
    options.primary.limits,
    options.fallback.limits,
  );
  if (limits.timeoutMilliseconds > hardMaximums.timeoutMilliseconds) {
    throw new GenerationError(
      "configuration",
      "Generation fallback timeout is outside the supported range",
    );
  }
  const primaryMetadata = metadata(
    options.primary.metadata.provider,
    options.primary.metadata.model,
    fallbackDisclosure(options.primary.metadata, options.fallback.metadata),
  );
  const fallbackMetadata = metadata(
    options.fallback.metadata.provider,
    options.fallback.metadata.model,
    options.fallback.metadata.retentionDisclosure,
  );
  const providers = Object.freeze({
    fallback: options.fallback,
    primary: options.primary,
  });
  return Object.freeze({
    fallbackMetadata,
    limits,
    metadata: primaryMetadata,
    stream(request: GenerationRequest) {
      return fallbackStream(providers, request);
    },
  });
}

export function createWorkersAiGenerationAdapter(
  options: WorkersAiGenerationAdapterOptions,
): GenerationAdapter {
  if (!options.binding || typeof options.binding.run !== "function") {
    throw new GenerationError(
      "configuration",
      "Workers AI generation binding is unavailable",
    );
  }
  const run = options.binding.run.bind(options.binding) as unknown as WorkersRun;
  const gatewayId = configuredGatewayId(options.gatewayId);
  const model = configuredText(options.model, "model", 256);
  const retentionDisclosure = configuredText(
    options.retentionDisclosure,
    "retention disclosure",
    1_024,
  );
  const limits = generationLimits(options);
  return Object.freeze({
    limits,
    metadata: metadata("cloudflare-workers-ai", model, retentionDisclosure),
    stream(request: GenerationRequest) {
      return providerStream(limits, request, (prepared, signal) =>
        run(
          model,
          {
            max_tokens: prepared.maximumOutputTokens,
            messages: prepared.messages,
            stream: true,
            temperature: prepared.temperature,
          },
          {
            gateway: { collectLog: false, id: gatewayId, skipCache: true },
            signal,
          },
        ),
      );
    },
  });
}

export function createOpenAiCompatibleGenerationAdapter(
  options: OpenAiCompatibleGenerationAdapterOptions,
): GenerationAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new GenerationError(
      "configuration",
      "Generation provider fetch is unavailable",
    );
  }
  const apiKey = configuredApiKey(options.apiKey);
  const endpoint = configuredEndpoint(options.endpoint);
  const model = configuredText(options.model, "model", 256);
  const retentionDisclosure = configuredText(
    options.retentionDisclosure,
    "retention disclosure",
    1_024,
  );
  const limits = generationLimits(options);
  return Object.freeze({
    limits,
    metadata: metadata("openai-compatible", model, retentionDisclosure),
    stream(request: GenerationRequest) {
      return providerStream(limits, request, async (prepared, signal) => {
        const headers = new Headers({
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        });
        if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
        const response = await fetchImplementation(endpoint, {
          body: JSON.stringify({
            max_tokens: prepared.maximumOutputTokens,
            messages: prepared.messages,
            model,
            stream: true,
            stream_options: { include_usage: true },
            temperature: prepared.temperature,
          }),
          cache: "no-store",
          headers,
          method: "POST",
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            // The body is deliberately unread because it can contain prompt data.
          }
          throw responseError(response.status);
        }
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream") ||
          !response.body
        ) {
          throw new GenerationError(
            "invalid-response",
            "Generation provider returned a non-streaming response",
          );
        }
        return response.body;
      });
    },
  });
}
