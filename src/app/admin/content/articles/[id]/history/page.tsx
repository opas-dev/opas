// ABOUTME: Lists bounded immutable article revisions for an authorized team member.
// ABOUTME: Separates working and live markers while paginating older summaries by revision.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Article history",
  description: "Review immutable OPAS article revisions.",
};

const timestampFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const changeKindLabels = {
  import: "Imported",
  manual: "Manual save",
  migration: "Migrated",
  rollback: "Restored",
  seed: "Initial seed",
} as const;

function historyCursor(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export default async function ArticleHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const beforeRevisionNumber = historyCursor(query.before);
  if (beforeRevisionNumber === null) notFound();

  const repository = await getRepository();
  const actor = { memberId: admin.memberId, sessionId: admin.sessionId };
  const [head, history] = await Promise.all([
    repository.getArticleWorkingHead({
      actor,
      articleId: id,
      workspaceId: demoIds.workspace,
    }),
    repository.listArticleRevisionHistory({
      actor,
      articleId: id,
      beforeRevisionNumber,
      workspaceId: demoIds.workspace,
    }),
  ]);
  if (!head || !history) notFound();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <Link href="/admin/content" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
          ← Content library
        </Link>
        <div className="mt-6 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">
            {head.archivedAt ? "Archived answer" : "Saved versions"}
          </p>
          <h1 className="mb-0 mt-2 text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl">
            {head.article.title}
          </h1>
          <p className="mb-0 mt-3 text-sm leading-6 text-muted">
            Each version is immutable. Open one to compare its exact source and restore it as a new
            private draft.
          </p>
        </div>

        <nav aria-label="Article sections" className="mt-8 flex border-b border-border">
          <Link
            className="min-h-11 px-3 py-2 text-sm font-semibold text-muted no-underline hover:text-foreground"
            href={`/admin/content/articles/${id}`}
          >
            Article
          </Link>
          <Link
            aria-current="page"
            className="min-h-11 border-b-2 border-primary px-3 py-2 text-sm font-semibold text-foreground no-underline"
            href={`/admin/content/articles/${id}/history`}
          >
            History
          </Link>
        </nav>

        {head.archivedAt ? (
          <p className="mt-6 border-y border-border bg-surface-strong px-4 py-3 text-sm leading-6">
            <strong>Archived · Not public.</strong> History remains available, but revisions are
            read-only until the article is restored.
          </p>
        ) : null}

        <section aria-labelledby="revision-history-heading" className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="revision-history-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                {beforeRevisionNumber ? "Older revisions" : "Latest revisions"}
              </h2>
              <p className="mb-0 mt-1.5 text-sm text-muted">Up to 20 versions per page.</p>
            </div>
            {beforeRevisionNumber ? (
              <Link
                className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
                href={`/admin/content/articles/${id}/history`}
              >
                Back to latest
              </Link>
            ) : null}
          </div>

          {history.items.length > 0 ? (
            <ol className="m-0 mt-5 list-none divide-y divide-border border-y border-border p-0">
              {history.items.map((revision) => (
                <li key={revision.revisionId} className="py-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                        <span>Revision {revision.revisionNumber}</span>
                        {revision.isWorkingRevision ? (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
                            Working
                          </span>
                        ) : null}
                        {revision.isPublishedRevision && head.publicStatus === "published" ? (
                          <span className="rounded-full bg-success px-2 py-0.5 text-success-foreground">
                            Live
                          </span>
                        ) : revision.isPublishedRevision ? (
                          <span className="rounded-full bg-surface-strong px-2 py-0.5 text-muted">
                            Last published
                          </span>
                        ) : null}
                      </div>
                      <h3 className="mb-0 mt-2 text-lg font-semibold tracking-[-0.015em] text-balance">
                        {revision.title}
                      </h3>
                      <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                        {changeKindLabels[revision.changeKind]} by {revision.createdByDisplayName}{" "}
                        <span aria-hidden="true">·</span>{" "}
                        <time dateTime={revision.createdAt.toISOString()}>
                          {timestampFormatter.format(revision.createdAt)} UTC
                        </time>
                      </p>
                      {revision.changeSummary ? (
                        <p className="mb-0 mt-2 text-sm leading-6">{revision.changeSummary}</p>
                      ) : null}
                      {revision.restoredFromRevisionId ? (
                        <p className="mb-0 mt-2 text-xs text-muted">
                          Created by restoring an earlier saved revision.
                        </p>
                      ) : null}
                    </div>
                    <Link
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-semibold text-foreground no-underline"
                      href={`/admin/content/articles/${id}/history/${revision.revisionNumber}/${revision.revisionId}`}
                    >
                      Compare
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="mt-5 border-y border-dashed border-border-strong py-8">
              <p className="m-0 font-semibold">No revisions on this page</p>
              <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                Return to the latest revisions to continue browsing this article’s history.
              </p>
            </div>
          )}

          {history.nextBeforeRevisionNumber ? (
            <Link
              className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-semibold text-foreground no-underline"
              href={`/admin/content/articles/${id}/history?before=${history.nextBeforeRevisionNumber}`}
            >
              Show older revisions
            </Link>
          ) : null}
        </section>
      </div>
    </main>
  );
}
