// ABOUTME: Presents ranked retained answer gaps, topic guardrails, and source observations.
// ABOUTME: Links correction briefings to human article authoring without publishing them directly.
import Link from "next/link";

import type {
  ContentGapKind,
  ContentGapReport,
} from "@/gaps/report";

type ContentGapsProps = Readonly<{
  report: ContentGapReport;
}>;

const numberFormatter = new Intl.NumberFormat("en");
const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const gapLabels: Record<ContentGapKind, string> = {
  escalated: "Escalated",
  "low-rated": "Low-rated",
  unsupported: "Unsupported",
};

function sampleLabel(count: number) {
  return `${numberFormatter.format(count)} ${count === 1 ? "sample" : "samples"}`;
}

function TopicConfiguration({ report }: ContentGapsProps) {
  const configuration = report.topicGuardrails.configuration;
  if (configuration.status === "invalid") {
    return (
      <p className="m-0 text-sm leading-6 text-danger" role="alert">
        The topic configuration is invalid. Answers fail closed until it is corrected.
      </p>
    );
  }
  if (configuration.status === "unconfigured") {
    return (
      <p className="m-0 text-sm leading-6 text-muted">
        No allow or deny topic list is configured. The universal request and evidence safety checks
        remain active.
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h4 className="m-0 text-sm font-semibold">Allowed topics</h4>
        {configuration.allow.length > 0 ? (
          <ul className="mb-0 mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {configuration.allow.map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : (
          <p className="mb-0 mt-2 text-sm text-muted">All topics not explicitly denied.</p>
        )}
      </div>
      <div>
        <h4 className="m-0 text-sm font-semibold">Denied topics</h4>
        {configuration.deny.length > 0 ? (
          <ul className="mb-0 mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {configuration.deny.map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : (
          <p className="mb-0 mt-2 text-sm text-muted">No explicit topic denials.</p>
        )}
      </div>
    </div>
  );
}

export function ContentGaps({ report }: ContentGapsProps) {
  const topic = report.topicGuardrails;
  return (
    <div className="space-y-16">
      <section aria-labelledby="content-gaps-heading">
        <div className="border-b border-border pb-4">
          <h2
            id="content-gaps-heading"
            className="m-0 text-xl font-semibold tracking-[-0.02em]"
          >
            Content gaps
          </h2>
          <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
            Ranked from {sampleLabel(report.recordsExamined)} in active, redacted retained
            conversations. Each count is a retained sample, not a unique person or total demand.
            {report.recordsTruncated
              ? ` The view is capped at the ${numberFormatter.format(report.recordsExamined)} most recent eligible records.`
              : ""}
          </p>
        </div>

        {report.gaps.length > 0 ? (
          <ol className="m-0 list-none divide-y divide-border p-0">
            {report.gaps.map((gap, index) => (
              <li
                key={`${gap.kind}:${gap.representativeConversationId}`}
                className="grid gap-5 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm tabular-nums text-muted" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="rounded-full bg-surface-strong px-2 py-0.5 text-xs font-semibold">
                      {gapLabels[gap.kind]}
                    </span>
                    <span className="text-xs text-muted">
                      {sampleLabel(gap.observedCount)} of {sampleLabel(gap.categorySampleCount)} in
                      this outcome
                    </span>
                  </div>
                  <blockquote className="mb-0 mt-3 rounded-md border border-border bg-surface-strong px-4 py-3 text-base font-semibold leading-7">
                    {gap.question}
                  </blockquote>
                  <p className="mb-0 mt-3 text-xs text-muted">
                    Last observed{" "}
                    <time dateTime={gap.lastObservedAt.toISOString()}>
                      {dateFormatter.format(gap.lastObservedAt)}
                    </time>
                  </p>
                </div>

                <aside className="rounded-lg border border-border bg-surface p-4" aria-label="Correction brief">
                  <p className="m-0 text-sm font-semibold text-primary">
                    Correction brief
                  </p>
                  <h3 className="mb-0 mt-2 text-base font-semibold">{gap.suggestion.proposedTitle}</h3>
                  <ul className="mb-0 mt-3 list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted">
                    {gap.suggestion.checklist.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {gap.suggestion.editArticleHref ? (
                      <Link
                        href={gap.suggestion.editArticleHref}
                        prefetch={false}
                        className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground no-underline"
                      >
                        Edit {gap.suggestion.editArticleTitle ?? "observed article"}
                      </Link>
                    ) : null}
                    <Link
                      href={gap.suggestion.createArticleHref}
                      prefetch={false}
                      className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-sm font-semibold text-foreground no-underline"
                    >
                      Start a draft
                    </Link>
                  </div>
                  <p className="mb-0 mt-3 text-xs leading-5 text-muted">
                    This briefing is not searchable. Retrieval changes only after a human saves a
                    validated article as published.
                  </p>
                </aside>
              </li>
            ))}
          </ol>
        ) : (
          <div className="border-b border-border py-8">
            <p className="m-0 font-semibold">No retained answer gaps</p>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              Unsupported, low-rated, and escalated retained samples will appear here.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="topic-guardrails-heading">
        <div className="border-b border-border pb-4">
          <h2
            id="topic-guardrails-heading"
            className="m-0 text-xl font-semibold tracking-[-0.02em]"
          >
            Topic guardrails
          </h2>
          <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
            Current deployment policy and observed guardrail outcomes across the same {" "}
            {sampleLabel(topic.recordsExamined)}.
          </p>
        </div>
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
          <TopicConfiguration report={report} />
          <dl className="m-0 grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-surface">
            <div className="p-3">
              <dt className="text-xs leading-5 text-muted">Out of scope</dt>
              <dd className="mb-0 mt-1 text-xl font-semibold tabular-nums">
                {numberFormatter.format(topic.outOfScopeCount)}
              </dd>
            </div>
            <div className="p-3">
              <dt className="text-xs leading-5 text-muted">Unsafe request</dt>
              <dd className="mb-0 mt-1 text-xl font-semibold tabular-nums">
                {numberFormatter.format(topic.unsafeRequestCount)}
              </dd>
            </div>
            <div className="p-3">
              <dt className="text-xs leading-5 text-muted">Unsafe evidence</dt>
              <dd className="mb-0 mt-1 text-xl font-semibold tabular-nums">
                {numberFormatter.format(topic.unsafeEvidenceCount)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="source-observations-heading">
        <div className="border-b border-border pb-4">
          <h2
            id="source-observations-heading"
            className="m-0 text-xl font-semibold tracking-[-0.02em]"
          >
            Source usefulness signals
          </h2>
          <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
            These counts show when a source and an outcome were observed together in retained
            traces. They do not prove that a source caused an answer, rating, or escalation.
          </p>
        </div>
        {report.sourceObservations.length > 0 ? (
          <div
            className="overflow-x-auto"
            role="region"
            aria-labelledby="source-observations-heading"
            tabIndex={0}
          >
            <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
              <caption className="sr-only">
                Retained source and outcome co-occurrence samples
              </caption>
              <thead>
                <tr className="border-b border-border text-muted">
                  <th scope="col" className="py-3 pr-5 font-semibold">Source</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Observed</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Answered</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Abstained</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Low-rated</th>
                  <th scope="col" className="py-3 pl-4 text-right font-semibold">Escalated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.sourceObservations.map((source) => (
                  <tr key={source.articleId}>
                    <th scope="row" className="py-4 pr-5 font-normal">
                      <a
                        href={source.canonicalUrl}
                        rel="noreferrer"
                        target="_blank"
                        className="font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                      >
                        {source.title}
                      </a>
                    </th>
                    <td className="px-4 py-4 text-right tabular-nums">
                      {source.observedConversationCount} / {source.tracedConversationCount}
                    </td>
                    <td className="px-4 py-4 text-right tabular-nums">{source.answeredCount}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{source.abstainedCount}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{source.lowRatedCount}</td>
                    <td className="py-4 pl-4 text-right tabular-nums">{source.escalatedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mb-0 mt-5 text-sm leading-6 text-muted">
            No unexpired retained source traces are available.
          </p>
        )}
      </section>
    </div>
  );
}
