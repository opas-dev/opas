// ABOUTME: Reviews a bounded knowledge upload and activates only a server-approved plan.
// ABOUTME: Displays every conflict, rename, repair, unknown field, and skipped source.
"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import type { ImportResponse } from "@/import/http";
import type { ImportReport } from "@/import/report";

type RequestMode = "dry-run" | "activate";

function ReportList({
  heading,
  items,
}: {
  heading: string;
  items: Array<{ key: string; text: string }>;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby={`import-${heading.toLocaleLowerCase("en-US").replace(/\s+/gu, "-")}`}>
      <h3
        id={`import-${heading.toLocaleLowerCase("en-US").replace(/\s+/gu, "-")}`}
        className="m-0 text-sm font-semibold text-foreground"
      >
        {heading} <span className="font-normal text-muted">({items.length})</span>
      </h3>
      <ul className="mb-0 mt-2 space-y-2 pl-5 text-sm leading-6 text-muted">
        {items.map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
    </section>
  );
}

function ImportReportView({ report }: { report: ImportReport }) {
  const errors = report.conflicts.filter((conflict) => conflict.severity === "error");
  const warnings = report.conflicts.filter((conflict) => conflict.severity === "warning");

  return (
    <div className="space-y-7">
      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {[
          ["Categories", report.completion.categories],
          ["Articles", report.completion.articles],
          ["Assets", report.completion.assets],
          ["Redirects", report.completion.redirects],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-surface p-4">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              {label}
            </p>
            <p className="mb-0 mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {value}
            </p>
          </div>
        ))}
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-foreground">Source files</dt>
          <dd className="m-0 mt-1 text-muted">{report.dryRun.sourceFiles}</dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">Content root</dt>
          <dd className="m-0 mt-1 break-all text-muted">
            {report.dryRun.contentRoot || "Archive root"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">Navigation source</dt>
          <dd className="m-0 mt-1 break-all text-muted">
            {report.dryRun.summaryPath || "Inferred from paths"}
          </dd>
        </div>
      </dl>

      <ReportList
        heading="Blocking conflicts"
        items={errors.map((conflict, index) => ({
          key: `${conflict.path}-${conflict.code}-${index}`,
          text: `${conflict.path}: ${conflict.message}`,
        }))}
      />
      <ReportList
        heading="Warnings"
        items={warnings.map((conflict, index) => ({
          key: `${conflict.path}-${conflict.code}-${index}`,
          text: `${conflict.path}: ${conflict.message}`,
        }))}
      />
      <ReportList
        heading="Renames"
        items={report.renames.map((rename, index) => ({
          key: `${rename.path}-${index}`,
          text: `${rename.path}: ${rename.from} → ${rename.to}`,
        }))}
      />
      <ReportList
        heading="Repairs"
        items={report.changes.map((change, index) => ({
          key: `${change.path}-${change.kind}-${index}`,
          text: `${change.path}${change.line ? `, line ${change.line}` : ""}: ${change.message}`,
        }))}
      />
      <ReportList
        heading="Unknown fields"
        items={report.unknownFields.map((field, index) => ({
          key: `${field.path}-${field.field}-${index}`,
          text: `${field.path}: ${field.field} (${field.scope})`,
        }))}
      />
      <ReportList
        heading="Skipped content"
        items={report.skippedContent.map((item, index) => ({
          key: `${item.path}-${item.reason}-${index}`,
          text: `${item.path}: ${item.reason.replace(/-/gu, " ")}`,
        }))}
      />
    </div>
  );
}

export function ImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [requestMode, setRequestMode] = useState<RequestMode | null>(null);

  async function submit(mode: RequestMode) {
    if (!file) {
      setResult({ status: "error", message: "Choose a Markdown file or ZIP archive first." });
      return;
    }

    setRequestMode(mode);
    const formData = new FormData();
    formData.set("file", file);
    formData.set("mode", mode);

    try {
      const response = await fetch("/admin/content/import/run", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      const body = (await response.json()) as ImportResponse;
      setResult(body);
    } catch {
      setResult({
        status: "error",
        message: "The import request could not be completed. Try again.",
      });
    } finally {
      setRequestMode(null);
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("dry-run");
  }

  return (
    <div className="space-y-6">
      <form onSubmit={review} className="rounded-lg border border-border bg-surface p-5 sm:p-6">
        <label htmlFor="knowledge-import-file" className="block text-sm font-semibold">
          Knowledge source
        </label>
        <p id="knowledge-import-help" className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
          Upload one Markdown file up to 2 MiB or a GitBook/Markdown ZIP up to 4 MiB. Review the
          complete mapping before any article is written.
        </p>
        <input
          id="knowledge-import-file"
          type="file"
          name="file"
          required
          accept=".md,.markdown,.zip,text/markdown,application/zip"
          aria-describedby="knowledge-import-help"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
          }}
          className="mt-5 block w-full rounded-md border border-border bg-background px-3 py-3 text-sm file:mr-4 file:rounded-sm file:border-0 file:bg-surface-strong file:px-3 file:py-2 file:font-semibold file:text-foreground"
        />
        <button
          type="submit"
          disabled={!file || requestMode !== null}
          className="mt-5 min-h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {requestMode === "dry-run" ? "Reviewing…" : "Review import"}
        </button>
      </form>

      {result?.status === "error" ? (
        <p className="m-0 rounded-lg border border-danger bg-surface p-4 text-sm text-danger" role="alert">
          {result.message}
        </p>
      ) : null}

      {result && result.status !== "error" ? (
        <section aria-labelledby="import-report-heading" className="rounded-lg border border-border bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5 border-b border-border pb-5">
            <div>
              <p
                className={`m-0 text-sm font-semibold ${
                  result.status === "blocked" ? "text-danger" : "text-success"
                }`}
                role="status"
              >
                {result.status === "blocked"
                  ? "Import blocked"
                  : result.status === "complete"
                    ? "Import complete"
                    : "Ready to import"}
              </p>
              <h2 id="import-report-heading" className="mb-0 mt-2 text-xl font-semibold tracking-[-0.02em]">
                Import report
              </h2>
            </div>
            {result.status === "ready" ? (
              <button
                type="button"
                disabled={requestMode !== null}
                onClick={() => void submit("activate")}
                className="min-h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
              >
                {requestMode === "activate" ? "Importing…" : "Import approved plan"}
              </button>
            ) : result.status === "complete" ? (
              <Link
                href="/admin/content"
                className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-semibold text-foreground no-underline"
              >
                View content
              </Link>
            ) : null}
          </div>
          <div className="mt-6">
            <ImportReportView report={result.report} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
