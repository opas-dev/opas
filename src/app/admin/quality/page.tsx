// ABOUTME: Presents authenticated answer-quality review, evaluation comparison, and testing tools.
// ABOUTME: Reads only active-workspace unexpired analytics and explicit redacted result fields.
import type { Metadata } from "next";
import Link from "next/link";

import { AdminHeader } from "@/app/admin/header";
import {
  EvaluationReview,
  QualityPlayground,
  RetainedEvidenceReplay,
  SavedQuestionControls,
  SavedQuestionImport,
} from "@/app/admin/quality/quality-controls";
import { ContentGaps } from "@/app/admin/quality/content-gaps";
import { requireAdmin } from "@/auth/admin";
import {
  compareQualityRuns,
  conversationLatencySummary,
  conversationOutcomeSummary,
  evaluateQualityReleaseGate,
  parseQualityEvaluationResults,
  replayRetainedConversation,
  safeQualitySourceUrl,
} from "@/quality/console";
import { loadActiveQualityConsoleData } from "@/quality/dependencies";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Answer quality",
  description: "Review redacted answer traces and compare OPAS evaluation runs.",
};

type QualitySearchParams = Promise<
  Record<string, string | readonly string[] | undefined>
>;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function selectedValue(value: string | readonly string[] | undefined) {
  return typeof value === "string" && value.length <= 200 ? value : null;
}

function passLabel(value: boolean | null) {
  if (value === null) return "—";
  return value ? "Pass" : "Fail";
}

function costLabel(microdollars: number | null | undefined) {
  return microdollars === null || microdollars === undefined
    ? "—"
    : `$${(microdollars / 1_000_000).toFixed(6)}`;
}

export default async function QualityAdminPage({
  searchParams,
}: {
  searchParams: QualitySearchParams;
}) {
  const admin = await requireAdmin();
  const [data, parameters] = await Promise.all([
    loadActiveQualityConsoleData(),
    searchParams,
  ]);
  const selectedConversationId = selectedValue(parameters.conversation);
  const selectedRunId = selectedValue(parameters.run);
  const baselineId = selectedValue(parameters.baseline);
  const candidateId = selectedValue(parameters.candidate);
  const selectedConversation = data.conversations.find(
    ({ id }) => id === selectedConversationId,
  );
  const replay = selectedConversation
    ? replayRetainedConversation(selectedConversation)
    : null;
  const selectedRun = data.runs.find(({ id }) => id === selectedRunId);
  const selectedResults = selectedRun
    ? parseQualityEvaluationResults(selectedRun.results)
    : null;
  const baseline = data.runs.find(({ id }) => id === baselineId);
  const candidate = data.runs.find(({ id }) => id === candidateId);
  const comparison =
    baseline && candidate ? compareQualityRuns(baseline, candidate) : null;
  const productionLatency = conversationLatencySummary(data.conversations);
  const outcomeSummary = conversationOutcomeSummary(data.conversations);
  const releaseGate = selectedResults
    ? evaluateQualityReleaseGate(selectedResults, productionLatency)
    : null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader email={admin.email} active="quality" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-8 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <p className="m-0 text-sm font-semibold text-primary">Answer operations</p>
            <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
              Find the evidence behind every answer.
            </h1>
            <p className="mb-0 mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">
              Review retained redacted conversations, reproduce failures from their stored traces,
              and compare saved questions before a release.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/admin/quality/export?kind=conversations"
              prefetch={false}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground no-underline hover:border-border-strong"
            >
              Export conversations
            </Link>
            <Link
              href="/admin/quality/export?kind=evaluations"
              prefetch={false}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground no-underline hover:border-border-strong"
            >
              Export runs
            </Link>
          </div>
        </div>

        <section className="mt-12" aria-labelledby="retained-conversations-heading">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div className="max-w-3xl">
              <h2
                id="retained-conversations-heading"
                className="m-0 text-xl font-semibold tracking-[-0.02em]"
              >
                Retained conversations
              </h2>
              <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                Only redacted, unexpired records from this workspace appear. Retained replay never
                reads the current knowledge index. An explicit diagnostic reproduction calls the
                configured provider with only the retained excerpts.
              </p>
            </div>
            <div className="text-right text-sm text-muted">
              <span className="font-semibold">
                {data.conversations.length} retained
              </span>
              {productionLatency.totalSamples > 0 ? (
                <p className="mb-0 mt-1 tabular-nums">
                  p95 first content token{" "}
                  {productionLatency.firstTokenP95Milliseconds === null
                    ? "—"
                    : `${productionLatency.firstTokenP95Milliseconds} ms`} ({productionLatency.firstTokenSamples}/{productionLatency.totalSamples}) · p95 total{" "}
                  {productionLatency.totalLatencyP95Milliseconds} ms
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 lg:grid-cols-6" aria-label="Retained outcome reconciliation">
            {([
              ["Answered", outcomeSummary.counts.answered],
              ["Abstained", outcomeSummary.counts.abstained],
              ["Low-rated", outcomeSummary.counts["low-rated"]],
              ["Escalated", outcomeSummary.counts.escalated],
              ["Abandoned", outcomeSummary.counts.abandoned],
            ] as const).map(([label, count]) => (
              <div key={label} className="bg-background px-3 py-3">
                <p className="m-0 text-xs text-muted">{label}</p>
                <p className="mb-0 mt-1 text-lg font-semibold tabular-nums">{count}</p>
              </div>
            ))}
            <div className="bg-background px-3 py-3">
              <p className="m-0 text-xs text-muted">Reconciled</p>
              <p className="mb-0 mt-1 text-sm font-semibold tabular-nums">
                {outcomeSummary.reconciledTotal}/{outcomeSummary.total}{" "}
                {outcomeSummary.reconciled ? "classified" : "mismatch"}
              </p>
            </div>
          </div>

          {data.analyticsStatus !== "enabled" ? (
            <div className="border-b border-border py-8">
              <p className="m-0 font-semibold">
                {data.analyticsStatus === "disabled"
                  ? "Conversation analytics are disabled"
                  : "Conversation analytics are unavailable"}
              </p>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
                Saved-question evaluation and the ephemeral playground remain available below.
              </p>
            </div>
          ) : data.conversations.length > 0 ? (
            <div
              className="overflow-x-auto"
              role="region"
              aria-labelledby="retained-conversations-heading"
              tabIndex={0}
            >
              <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th scope="col" className="py-3 pr-4 font-semibold">Started</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Outcome</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Last question</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Latency</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Sources</th>
                    <th scope="col" className="py-3 pl-4 text-right font-semibold">Review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.conversations.map((conversation) => {
                    const retained = replayRetainedConversation(conversation);
                    return (
                      <tr key={conversation.id}>
                        <td className="py-4 pr-4 whitespace-nowrap text-muted">
                          {dateFormatter.format(conversation.startedAt)}
                        </td>
                        <td className="px-4 py-4 font-semibold">{conversation.outcome}</td>
                        <td className="max-w-md truncate px-4 py-4">
                          {retained.question ?? "No retained user turn"}
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums whitespace-nowrap">
                          {conversation.firstTokenMilliseconds === null
                            ? "first token —"
                            : `first token ${conversation.firstTokenMilliseconds} ms`}
                          <br />
                          <span className="text-muted">
                            total {conversation.durationMilliseconds} ms
                          </span>
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          {conversation.retrievalTrace.length}
                        </td>
                        <td className="py-4 pl-4 text-right">
                          <Link
                            href={`/admin/quality?conversation=${encodeURIComponent(conversation.id)}#retained-replay`}
                            className="font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                          >
                            Inspect
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="border-b border-border py-8">
              <p className="m-0 font-semibold">No unexpired conversations</p>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
                Redacted traces appear after answers are recorded under the configured retention
                policy.
              </p>
            </div>
          )}

          {selectedConversationId && !replay ? (
            <p className="mb-0 mt-5 text-sm text-muted">
              That conversation is not available in this workspace or has expired.
            </p>
          ) : null}

          {replay && selectedConversation ? (
            <div id="retained-replay" className="mt-8 scroll-mt-6 border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="m-0 text-lg font-semibold tracking-[-0.01em]">
                    Retained replay
                  </h3>
                  <p className="mb-0 mt-1 text-sm text-muted">
                    {selectedConversation.outcome} · {selectedConversation.provider} ·{" "}
                    {selectedConversation.model}
                  </p>
                  <p className="mb-0 mt-1 text-sm tabular-nums text-muted">
                    First content token {selectedConversation.firstTokenMilliseconds === null
                      ? "not observed"
                      : `${selectedConversation.firstTokenMilliseconds} ms`} · total request{" "}
                    {selectedConversation.durationMilliseconds} ms
                  </p>
                </div>
                <Link
                  href="/admin/quality"
                  className="text-sm font-semibold text-muted underline decoration-border-strong underline-offset-4 hover:text-foreground"
                >
                  Close replay
                </Link>
              </div>

              <ol className="m-0 mt-5 list-none space-y-4 p-0" aria-label="Redacted conversation">
                {replay.messages.map((message, index) => (
                  <li key={`${message.role}-${index}`} className="max-w-3xl">
                    <p className="m-0 text-xs font-semibold text-muted">
                      {message.role === "user" ? "User" : "Assistant"}
                    </p>
                    <p className="mb-0 mt-1 whitespace-pre-wrap text-sm leading-6">
                      {message.content}
                    </p>
                  </li>
                ))}
              </ol>
              {replay.reason ? (
                <p className="mb-0 mt-4 text-sm text-muted">Recorded reason: {replay.reason}</p>
              ) : null}

              <h4 className="mb-0 mt-8 text-base font-semibold">Source trace at answer time</h4>
              {replay.trace.length > 0 ? (
                <ol className="m-0 mt-2 list-none divide-y divide-border border-y border-border p-0">
                  {replay.trace.map((source) => {
                    const href = safeQualitySourceUrl(source.canonicalUrl);
                    return (
                      <li key={source.sourceId} className="py-3 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                            >
                              {source.title}
                            </a>
                          ) : (
                            <span className="font-semibold">{source.title}</span>
                          )}
                          <span className="font-mono text-xs tabular-nums text-muted">
                            {source.score.toFixed(4)}
                          </span>
                        </div>
                        <p className="mb-0 mt-1 break-all text-xs text-muted">
                          {source.sourceId} · generation {source.indexGeneration} · {source.mode}
                        </p>
                        <p className="mb-0 mt-1 break-all font-mono text-xs text-muted">
                          chunk {source.contentHash} · article {source.articleContentHash}
                        </p>
                        <p className="mb-0 mt-1 text-xs text-muted">
                          {source.headingPath.length > 0
                            ? source.headingPath.join(" › ")
                            : "Article root"}{" "}
                          · lines {source.sourceLineRange.start}–{source.sourceLineRange.end}
                        </p>
                        <p className="mb-0 mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted">
                          Retained redacted excerpt: {source.excerpt}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="mb-0 mt-2 text-sm text-muted">
                  No retrieval evidence was retained for this outcome.
                </p>
              )}
              <RetainedEvidenceReplay conversationId={selectedConversation.id} />
            </div>
          ) : null}
        </section>

        {data.contentGapReport ? (
          <div className="mt-16 border-t border-border pt-12">
            <ContentGaps report={data.contentGapReport} />
          </div>
        ) : null}

        <section className="mt-16" aria-labelledby="saved-evaluations-heading">
          <div className="border-b border-border pb-4">
            <h2
              id="saved-evaluations-heading"
              className="m-0 text-xl font-semibold tracking-[-0.02em]"
            >
              Saved-question evaluations
            </h2>
            <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
              Each run uses the configured production answer runtime, snapshots the active index,
              and stores bounded generated answers, current citation provenance, token use, cost,
              and latency for release review.
            </p>
          </div>

          <SavedQuestionImport />

          {data.questionSets.length > 0 ? (
            <div className="mt-4">
              <SavedQuestionControls
                questionSets={data.questionSets.map((questionSet) => ({
                  id: questionSet.id,
                  name: questionSet.name,
                  questionCount: questionSet.questions.length,
                  version: questionSet.version,
                }))}
              />
            </div>
          ) : (
            <div className="border-b border-border py-8">
              <p className="m-0 font-semibold">No saved question sets</p>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
                Import a versioned evaluation set to establish a repeatable release baseline.
              </p>
            </div>
          )}

          {data.runs.length > 0 ? (
            <div className="mt-10">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h3 className="m-0 text-lg font-semibold">Run history</h3>
                  <p className="mb-0 mt-1 text-sm text-muted">
                    Newest first. Select a run for generated answers and claim-level evidence.
                  </p>
                </div>
              </div>
              <div className="mt-3 overflow-x-auto" role="region" aria-label="Evaluation run history" tabIndex={0}>
                <table className="w-full min-w-[64rem] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th scope="col" className="py-3 pr-4 font-semibold">Started</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Question set</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Runtime</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Result</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">First token p95</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">Cost</th>
                      <th scope="col" className="py-3 pl-4 text-right font-semibold">Inspect</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.runs.map((run) => {
                      const results = parseQualityEvaluationResults(run.results);
                      return (
                        <tr key={run.id}>
                          <td className="py-4 pr-4 whitespace-nowrap text-muted">
                            {dateFormatter.format(run.startedAt)}
                          </td>
                          <td className="px-4 py-4">{run.questionSetId}</td>
                          <td className="px-4 py-4">
                            {run.provider && run.model
                              ? `${run.provider} · ${run.model}`
                              : "Unavailable"}
                          </td>
                          <td className="px-4 py-4 font-semibold">
                            {results
                              ? `${results.summary.passed}/${results.summary.total} passed`
                              : run.status}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums">
                            {results?.summary.firstTokenP95Milliseconds === null ||
                            results?.summary.firstTokenP95Milliseconds === undefined
                              ? "—"
                              : `${results.summary.firstTokenP95Milliseconds} ms`}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums">
                            {costLabel(results?.summary.costMicrodollars)}
                          </td>
                          <td className="py-4 pl-4 text-right">
                            <Link
                              href={`/admin/quality?run=${encodeURIComponent(run.id)}#run-detail`}
                              className="font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                            >
                              Inspect
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {selectedRunId && !selectedRun ? (
            <p className="mb-0 mt-5 text-sm text-muted">
              That run is not available in this workspace.
            </p>
          ) : null}

          {selectedRun ? (
            <div id="run-detail" className="mt-8 scroll-mt-6 border-t border-border pt-6">
              <h3 className="m-0 text-lg font-semibold">Run detail</h3>
              <p className="mb-0 mt-1 text-sm text-muted">
                {selectedRun.id} · index generation {selectedRun.indexGeneration} ·{" "}
                {selectedRun.retrievalMode} · configured {selectedRun.provider ?? "unknown provider"} ·{" "}
                {selectedRun.model ?? "unknown model"}
              </p>
              {selectedResults ? (
                <div className="mt-5">
                  <p className="m-0 text-sm text-muted">
                    p95 total {selectedResults.summary.latencyP95Milliseconds} ms · p95 first token{" "}
                    {selectedResults.summary.firstTokenP95Milliseconds === null
                      ? "—"
                      : `${selectedResults.summary.firstTokenP95Milliseconds} ms`} ·{" "}
                    {selectedResults.summary.inputTokens ?? "—"} input /{" "}
                    {selectedResults.summary.outputTokens ?? "—"} output tokens ·{" "}
                    {costLabel(selectedResults.summary.costMicrodollars)} ·{" "}
                    {selectedResults.summary.coveredClaimCount}/{selectedResults.summary.claimCount}{" "}
                    protocol citation associations · manual grounded and materially correct{" "}
                    {selectedResults.summary.manualAnswerScore.numerator}/
                    {selectedResults.summary.manualAnswerScore.denominator} · manually entailed and
                    citation-covered claims {selectedResults.summary.manualClaimScore.numerator}/
                    {selectedResults.summary.manualClaimScore.denominator}
                  </p>
                  <p className="mb-0 mt-2 text-sm text-muted">
                    Actual generation:{" "}
                    {selectedResults.summary.generations.length > 0
                      ? selectedResults.summary.generations
                          .map(
                            (generation) =>
                              `${generation.provider} · ${generation.model}: ${generation.questions} answers, ${costLabel(generation.costMicrodollars)}`,
                          )
                          .join("; ")
                      : "none (all requests abstained before generation)"}
                  </p>
                  {releaseGate ? (
                    <section className="mt-6 border-y border-border py-5" aria-labelledby="release-gate-heading">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <div>
                          <h4 id="release-gate-heading" className="m-0 text-base font-semibold">
                            Pilot release gate
                          </h4>
                          <p className="mb-0 mt-1 text-xs leading-5 text-muted">
                            Missing reviews, missing classes, absent citations, and absent production token samples remain missing evidence; they never count as passes.
                          </p>
                        </div>
                        <span className="text-sm font-semibold">
                          {releaseGate.status === "ready"
                            ? "Ready"
                            : releaseGate.status === "blocked"
                              ? "Blocked"
                              : "Missing evidence"}
                        </span>
                      </div>
                      <div className="mt-4 overflow-x-auto" role="region" aria-label="Pilot release gate results" tabIndex={0}>
                        <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-border text-muted">
                              <th scope="col" className="py-2 pr-3 font-semibold">Gate</th>
                              <th scope="col" className="px-3 py-2 text-right font-semibold">Evidence</th>
                              <th scope="col" className="px-3 py-2 text-right font-semibold">Target</th>
                              <th scope="col" className="py-2 pl-3 text-right font-semibold">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {releaseGate.ratios.map((gate) => (
                              <tr key={gate.id}>
                                <th scope="row" className="py-3 pr-3 font-semibold">{gate.label}</th>
                                <td className="px-3 py-3 text-right tabular-nums">
                                  {gate.numerator}/{gate.denominator}
                                  {gate.denominator !== gate.expectedDenominator
                                    ? ` of ${gate.expectedDenominator} required`
                                    : ""}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums">≥{gate.requiredPercent}%</td>
                                <td className="py-3 pl-3 text-right font-semibold">
                                  {gate.status === "pass"
                                    ? "Pass"
                                    : gate.status === "fail"
                                      ? "Fail"
                                      : "Missing evidence"}
                                </td>
                              </tr>
                            ))}
                            <tr>
                              <th scope="row" className="py-3 pr-3 font-semibold">Production first-content-token p95</th>
                              <td className="px-3 py-3 text-right tabular-nums">
                                {releaseGate.productionFirstToken.p95Milliseconds === null
                                  ? `— (${releaseGate.productionFirstToken.sampleCount} samples)`
                                  : `${releaseGate.productionFirstToken.p95Milliseconds} ms (${releaseGate.productionFirstToken.sampleCount} samples)`}
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums">≤{releaseGate.productionFirstToken.maximumP95Milliseconds} ms</td>
                              <td className="py-3 pl-3 text-right font-semibold">
                                {releaseGate.productionFirstToken.status === "pass"
                                  ? "Pass"
                                  : releaseGate.productionFirstToken.status === "fail"
                                    ? "Fail"
                                    : "Missing evidence"}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </section>
                  ) : null}
                  <div className="mt-4 overflow-x-auto" role="region" aria-label="Evaluation scores by question class" tabIndex={0}>
                    <table className="w-full min-w-[48rem] border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted">
                          <th scope="col" className="py-2 pr-3 font-semibold">Class</th>
                          <th scope="col" className="px-3 py-2 text-right font-semibold">Automatic pass</th>
                          <th scope="col" className="px-3 py-2 text-right font-semibold">Grounded + correct</th>
                          <th scope="col" className="py-2 pl-3 text-right font-semibold">Entailed + covered claims</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {selectedResults.summary.perClassification.map((score) => (
                          <tr key={score.classification}>
                            <th scope="row" className="py-2 pr-3 font-semibold">{score.classification}</th>
                            <td className="px-3 py-2 text-right tabular-nums">{score.automaticPass.numerator}/{score.automaticPass.denominator}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{score.manualAnswerScore.numerator}/{score.manualAnswerScore.denominator}</td>
                            <td className="py-2 pl-3 text-right tabular-nums">{score.manualClaimScore.numerator}/{score.manualClaimScore.denominator}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 overflow-x-auto" role="region" aria-label="Evaluation question results" tabIndex={0}>
                  <table className="w-full min-w-[66rem] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th scope="col" className="py-3 pr-4 font-semibold">Question</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Expected</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Actual</th>
                        <th scope="col" className="px-4 py-3 text-right font-semibold">Latency</th>
                        <th scope="col" className="px-4 py-3 text-right font-semibold">Claims</th>
                        <th scope="col" className="py-3 pl-4 text-right font-semibold">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {selectedResults.questions.map((question) => (
                        <tr key={question.id}>
                          <td className="max-w-lg py-4 pr-4">
                            <p className="m-0 font-semibold">{question.question}</p>
                            <p className="mb-0 mt-1 text-xs text-muted">
                              {question.classification} · {question.citations.map(({ sourceId }) => sourceId).join(", ") || "no citations"}
                            </p>
                            {question.answer ? (
                              <p className="mb-0 mt-3 whitespace-pre-wrap text-sm leading-6">
                                {question.answer}
                              </p>
                            ) : question.reason ? (
                              <p className="mb-0 mt-3 text-sm text-muted">
                                Abstained: {question.reason}
                              </p>
                            ) : null}
                            {question.citations.length > 0 ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-semibold text-muted">
                                  Inspect {question.citations.length} validated {question.citations.length === 1 ? "citation" : "citations"}
                                </summary>
                                <ol className="mb-0 mt-2 list-none space-y-2 p-0">
                                  {question.citations.map((citation) => {
                                    const href = safeQualitySourceUrl(citation.canonicalUrl);
                                    return (
                                      <li key={citation.id} className="text-xs leading-5 text-muted">
                                        {href ? (
                                          <a href={href} target="_blank" rel="noreferrer" className="font-semibold text-foreground underline decoration-border-strong underline-offset-4">
                                            {citation.id} · {citation.title}
                                          </a>
                                        ) : (
                                          <span className="font-semibold text-foreground">{citation.id} · {citation.title}</span>
                                        )}
                                        <span className="block break-all">
                                          {citation.sourceId} · source {citation.contentHash} · article {citation.articleContentHash}
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ol>
                              </details>
                            ) : null}
                            {question.trace.length > 0 ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-semibold text-muted">
                                  Inspect {question.trace.length} retrieved {question.trace.length === 1 ? "chunk" : "chunks"}
                                </summary>
                                <ol className="mb-0 mt-2 list-none space-y-3 p-0">
                                  {question.trace.map((source) => (
                                    <li key={source.sourceId}>
                                      <p className="m-0 text-xs font-semibold">
                                        {source.title} · {source.score.toFixed(4)}
                                      </p>
                                      <p className="mb-0 mt-1 whitespace-pre-wrap text-xs leading-5 text-muted">
                                        {source.excerpt}
                                      </p>
                                    </li>
                                  ))}
                                </ol>
                              </details>
                            ) : null}
                            {question.actualOutcome === "answer" ? (
                              <EvaluationReview
                                key={`${selectedRun.id}:${question.id}`}
                                claims={question.claims.map(({ markdown, ordinal }) => ({
                                  markdown,
                                  ordinal,
                                }))}
                                manualReview={question.manualReview}
                                questionId={question.id}
                                runId={selectedRun.id}
                              />
                            ) : null}
                          </td>
                          <td className="px-4 py-4">{question.expectedOutcome}</td>
                          <td className="px-4 py-4">
                            {question.actualOutcome}
                            {question.generation ? (
                              <span className="mt-1 block text-xs text-muted">
                                {question.generation.provider} · {question.generation.model}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums">
                            {question.durationMilliseconds} ms
                            <span className="block text-xs text-muted">
                              first {question.firstTokenMilliseconds === null ? "—" : `${question.firstTokenMilliseconds} ms`}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums">
                            {question.claims.filter(({ citationCovered }) => citationCovered).length}/{question.claims.length}
                            <span className="block text-xs text-muted">
                              {question.inputTokens ?? "—"}/{question.outputTokens ?? "—"} tokens · {costLabel(question.costMicrodollars)}
                            </span>
                            {question.manualReview ? (
                              <span className="mt-1 block text-xs text-muted">
                                manual {question.manualReview.claims.filter(({ entailed, citationCovered }) => entailed && citationCovered).length}/{question.manualReview.claims.length}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-4 pl-4 text-right font-semibold">
                            {question.passed ? "Pass" : "Fail"}
                            <span className="mt-1 block text-xs text-muted">
                              {question.manualReview
                                ? question.manualReview.grounded && question.manualReview.materiallyCorrect
                                  ? "Manual pass"
                                  : "Manual fail"
                                : "Not reviewed"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : (
                <p className="mb-0 mt-4 text-sm text-muted">
                  This run did not produce a completed quality result.
                </p>
              )}
            </div>
          ) : null}

          {data.runs.length >= 2 ? (
            <div className="mt-10 border-t border-border pt-6">
              <h3 className="m-0 text-lg font-semibold">Compare releases</h3>
              <form method="get" action="/admin/quality" className="mt-4 flex flex-wrap items-end gap-4">
                <label className="min-w-64 flex-1 text-sm font-semibold">
                  Baseline
                  <select
                    name="baseline"
                    required
                    defaultValue={baseline?.id ?? ""}
                    className="mt-2 block min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm font-normal text-foreground"
                  >
                    <option value="" disabled>Select a run</option>
                    {data.runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {dateFormatter.format(run.startedAt)} · index {run.indexGeneration}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-64 flex-1 text-sm font-semibold">
                  Candidate
                  <select
                    name="candidate"
                    required
                    defaultValue={candidate?.id ?? ""}
                    className="mt-2 block min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm font-normal text-foreground"
                  >
                    <option value="" disabled>Select a run</option>
                    {data.runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {dateFormatter.format(run.startedAt)} · index {run.indexGeneration}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-semibold text-foreground"
                >
                  Compare
                </button>
              </form>

              {baselineId && candidateId && !comparison ? (
                <p className="mb-0 mt-4 text-sm text-muted">
                  Select two completed quality runs from this workspace.
                </p>
              ) : null}
              {comparison ? (
                <div className="mt-6">
                  <p className="m-0 text-sm font-semibold">
                    Passed-question change:{" "}
                    {comparison.passedDelta > 0 ? "+" : ""}{comparison.passedDelta}
                  </p>
                  <div className="mt-3 overflow-x-auto" role="region" aria-label="Release comparison" tabIndex={0}>
                    <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted">
                          <th scope="col" className="py-3 pr-4 font-semibold">Question</th>
                          <th scope="col" className="px-4 py-3 font-semibold">Change</th>
                          <th scope="col" className="px-4 py-3 text-right font-semibold">Baseline</th>
                          <th scope="col" className="py-3 pl-4 text-right font-semibold">Candidate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {comparison.rows.map((row) => (
                          <tr key={row.id}>
                            <td className="max-w-xl py-4 pr-4">{row.question}</td>
                            <td className="px-4 py-4 font-semibold">{row.status}</td>
                            <td className="px-4 py-4 text-right">{passLabel(row.baselinePassed)}</td>
                            <td className="py-4 pl-4 text-right">{passLabel(row.candidatePassed)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="mt-16 border-t border-border pt-8" aria-labelledby="quality-playground-heading">
          <div className="max-w-3xl">
            <h2
              id="quality-playground-heading"
              className="m-0 text-xl font-semibold tracking-[-0.02em]"
            >
              Test playground
            </h2>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              Run one bounded question against the active published index. A separately labeled
              lexical preflight shows scores; cited source IDs show what generation used. Provider
              errors are reduced to a safe status.
            </p>
          </div>
          <div className="mt-5">
            <QualityPlayground />
          </div>
        </section>
      </div>
    </main>
  );
}
