// ABOUTME: Captures one answer attempt as a bounded redacted analytics record.
// ABOUTME: Observes retrieval and public events without allowing storage to break answers.
import type { GenerationUsage } from "@/ai/generation";
import type { AnswerEvent, AnswerHistoryMessage } from "@/answers/answer";
import type { EvidenceRetrievalResult } from "@/search/evidence";
import {
  estimateConversationCostMicrodollars,
  type ConversationAnalyticsEnvironment,
  type ConversationAnalyticsInput,
  type ConversationOutcome,
} from "@/outcomes/records";
import {
  createConfiguredConversationAnalyticsRuntime,
  createConversationAnalyticsRuntime,
} from "@/outcomes/runtime";

const writeDeadlineMilliseconds = 750;

type AnalyticsRuntime = ReturnType<typeof createConversationAnalyticsRuntime>;

type RecorderOptions = Readonly<{
  environment?: ConversationAnalyticsEnvironment & {
    OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
    OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
    OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
    OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS?: string;
  };
  getRuntime?: () => Promise<AnalyticsRuntime>;
  history?: readonly AnswerHistoryMessage[];
  id: string;
  model: string;
  now?: () => Date;
  provider: string;
  question: string;
  reportFailure?: (details: Readonly<{ type: string }>) => void;
  startedAt?: Date;
  writeDeadlineMilliseconds?: number;
  workspaceId: string;
}>;

function failureDetails(error: unknown) {
  return Object.freeze({ type: error instanceof Error ? error.name : "UnknownError" });
}

function defaultFailureReporter(details: Readonly<{ type: string }>) {
  console.error("Conversation analytics persistence failed.", details);
}

export function createAnswerOutcomeRecorder(options: RecorderOptions) {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now();
  const reportFailure = options.reportFailure ?? defaultFailureReporter;
  const runtime = (
    options.getRuntime ?? (() => createConfiguredConversationAnalyticsRuntime())
  );
  const writeDeadline = options.writeDeadlineMilliseconds ?? writeDeadlineMilliseconds;
  const assistantContent: string[] = [];
  let trace: readonly EvidenceRetrievalResult[] = [];
  let finalization: Promise<void> | undefined;
  let firstTokenMilliseconds: number | null = null;
  let alternateProviderSelected = false;
  let model = options.model;
  let provider = options.provider;

  function elapsedMilliseconds(at: Date) {
    return Math.max(
      0,
      Math.min(300_000, at.getTime() - startedAt.getTime()),
    );
  }

  function finalize(
    outcome: ConversationOutcome,
    reason: string | null,
    usage?: GenerationUsage,
    assistantMessage?: string,
  ) {
    if (finalization) return finalization;
    finalization = (async () => {
      const updatedAt = now();
      const answer = assistantMessage ?? assistantContent.join("\n\n");
      const input: ConversationAnalyticsInput = {
        conversation: Object.freeze([
          ...(options.history ?? []),
          Object.freeze({ content: options.question, role: "user" as const }),
          ...(answer
            ? [Object.freeze({ content: answer, role: "assistant" as const })]
            : []),
        ]),
        costMicrodollars: estimateConversationCostMicrodollars(
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          alternateProviderSelected
            ? environment.OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS
            : environment.OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
          alternateProviderSelected
            ? environment.OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS
            : environment.OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
        ),
        durationMilliseconds: elapsedMilliseconds(updatedAt),
        firstTokenMilliseconds,
        id: options.id,
        inputTokens: usage?.inputTokens ?? null,
        model,
        outcome,
        outputTokens: usage?.outputTokens ?? null,
        provider,
        reason,
        retrievalTrace: Object.freeze(
          trace.map((entry) =>
            Object.freeze({
              articleContentHash: entry.articleContentHash,
              articleId: entry.articleId,
              canonicalUrl: entry.canonicalUrl,
              contentHash: entry.contentHash,
              excerpt: entry.evidenceText,
              headingPath: entry.headingPath,
              indexGeneration: entry.indexGeneration,
              mode: entry.mode,
              ordinal: entry.ordinal,
              score: entry.score,
              sourceId: entry.sourceId,
              sourceLineRange: entry.sourceLineRange,
              title: entry.title,
            }),
          ),
        ),
        startedAt,
        updatedAt,
        workspaceId: options.workspaceId,
      };
      const write = runtime()
        .then((selected) => selected.put(input))
        .catch((error) => {
          reportFailure(failureDetails(error));
          return false;
        });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        write,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), writeDeadline);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    })();
    return finalization;
  }

  return Object.freeze({
    observeProvider(metadata: Readonly<{ model: string; provider: string }>) {
      alternateProviderSelected =
        metadata.model !== options.model || metadata.provider !== options.provider;
      model = metadata.model;
      provider = metadata.provider;
    },
    observeRetrieval(results: readonly EvidenceRetrievalResult[]) {
      trace = Object.freeze([...results]);
    },
    async observeEvent(event: AnswerEvent) {
      if (event.type === "content" && firstTokenMilliseconds === null) {
        firstTokenMilliseconds = elapsedMilliseconds(now());
      }
      if (event.type === "content") assistantContent.push(event.markdown);
      if (event.type === "abstention") {
        await finalize("abstained", event.reason, undefined, event.message);
      }
      if (event.type === "finish") {
        await finalize("answered", event.reason, event.usage);
      }
    },
    abandon(reason: string) {
      return finalize("abandoned", reason);
    },
  });
}

export type AnswerOutcomeRecorder = ReturnType<typeof createAnswerOutcomeRecorder>;
