// ABOUTME: Shows one exact immutable article revision with its preceding-version comparison.
// ABOUTME: Exposes attributed events and a capability-gated restore-as-draft action.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { restoreArticleRevisionAction } from "@/app/admin/content/article-recovery-actions";
import { RestoreRevisionControl } from "@/app/admin/content/article-recovery-controls";
import {
  ArticleSourceDiff,
  compareArticleMetadata,
} from "@/app/admin/content/article-revision-diff";
import { ArticleRevisionPreview } from "@/app/admin/content/article-revision-preview";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { hasCapability } from "@/auth/capabilities";
import type { ArticleReviewAction } from "@/content/article-workflow";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Compare article revision",
  description: "Inspect and restore an immutable OPAS article revision.",
};

const timestampFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

const changeKindLabels = {
  import: "Imported",
  manual: "Manual save",
  migration: "Migrated",
  rollback: "Restored from history",
  seed: "Initial seed",
} as const;

const eventLabels: Record<ArticleReviewAction, string> = {
  approved: "Approved",
  archived: "Archived",
  category_changed: "Category changed",
  changes_requested: "Changes requested",
  emergency_published: "Emergency published",
  published: "Published",
  restored: "Restored",
  submitted: "Submitted for review",
  unpublished: "Unpublished",
  withdrawn: "Withdrawn from review",
};

function parseRevisionNumber(value: string) {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const revisionNumber = Number(value);
  return Number.isSafeInteger(revisionNumber) ? revisionNumber : null;
}

export default async function ArticleRevisionPage({
  params,
}: {
  params: Promise<{ id: string; revisionId: string; revisionNumber: string }>;
}) {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const { id, revisionId, revisionNumber: value } = await params;
  const revisionNumber = parseRevisionNumber(value);
  if (revisionNumber === null) notFound();

  const repository = await getRepository();
  const actor = { memberId: admin.memberId, sessionId: admin.sessionId };
  const [head, revision, precedingHistory] = await Promise.all([
    repository.getArticleWorkingHead({
      actor,
      articleId: id,
      workspaceId: demoIds.workspace,
    }),
    repository.getArticleRevisionDetail({
      actor,
      articleId: id,
      revisionId,
      revisionNumber,
      workspaceId: demoIds.workspace,
    }),
    revisionNumber === 1
      ? Promise.resolve(null)
      : repository.listArticleRevisionHistory({
          actor,
          articleId: id,
          beforeRevisionNumber: revisionNumber,
          limit: 1,
          workspaceId: demoIds.workspace,
        }),
  ]);
  if (!head || !revision) notFound();

  const precedingSummary = precedingHistory?.items[0] ?? null;
  const preceding = precedingSummary
    ? await repository.getArticleRevisionDetail({
        actor,
        articleId: id,
        revisionId: precedingSummary.revisionId,
        revisionNumber: precedingSummary.revisionNumber,
        workspaceId: demoIds.workspace,
      })
    : null;
  if (precedingSummary && !preceding) notFound();

  const metadataChanges = compareArticleMetadata(preceding, revision);
  const isWorkingRevision = head.revisionId === revision.revisionId;
  const isPublishedRevision = head.publishedRevisionId === revision.revisionId;
  const archived = head.archivedAt !== null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <Link
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
          href={`/admin/content/articles/${id}/history`}
        >
          ← Article history
        </Link>

        <header className="mt-6 border-b border-border pb-7">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span>Revision {revision.revisionNumber}</span>
            {isWorkingRevision ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
                Working
              </span>
            ) : null}
            {isPublishedRevision && head.publicStatus === "published" ? (
              <span className="rounded-full bg-success px-2 py-0.5 text-success-foreground">
                Live
              </span>
            ) : isPublishedRevision ? (
              <span className="rounded-full bg-surface-strong px-2 py-0.5 text-muted">
                Last published
              </span>
            ) : null}
            {archived ? (
              <span className="rounded-full bg-surface-strong px-2 py-0.5 text-muted">
                Article archived
              </span>
            ) : null}
          </div>
          <h1 className="mb-0 mt-3 max-w-4xl text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl">
            {revision.article.title}
          </h1>
          <p className="mb-0 mt-3 text-sm leading-6 text-muted">
            {changeKindLabels[revision.changeKind]} by {revision.createdByDisplayName}{" "}
            <span aria-hidden="true">·</span>{" "}
            <time dateTime={revision.createdAt.toISOString()}>
              {timestampFormatter.format(revision.createdAt)} UTC
            </time>
          </p>
          {revision.changeSummary ? (
            <p className="mb-0 mt-3 max-w-3xl text-sm leading-6">{revision.changeSummary}</p>
          ) : null}
        </header>

        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div className="min-w-0 space-y-10">
            <section aria-labelledby="revision-preview-heading">
              <div className="mb-4">
                <h2 id="revision-preview-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                  Saved preview
                </h2>
                <p className="mb-0 mt-1.5 text-sm leading-6 text-muted">
                  Read-only rendering of this exact revision and its retained OPAS images.
                </p>
              </div>
              <div className="article-content article-preview rounded-md border border-border bg-surface p-5 sm:p-7">
                <ArticleRevisionPreview
                  source={revision.article.mdx}
                  title={revision.article.title}
                />
              </div>
            </section>

            <section aria-labelledby="metadata-changes-heading">
              <h2 id="metadata-changes-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                Metadata changes
              </h2>
              <p className="mb-0 mt-1.5 text-sm leading-6 text-muted">
                {preceding
                  ? `Compared with revision ${preceding.revisionNumber}.`
                  : "This is the first saved revision."}
              </p>
              {metadataChanges.length > 0 ? (
                <dl className="m-0 mt-4 divide-y divide-border border-y border-border">
                  {metadataChanges.map((change) => (
                    <div className="grid gap-2 py-4 sm:grid-cols-[10rem_minmax(0,1fr)]" key={change.label}>
                      <dt className="text-sm font-semibold">{change.label}</dt>
                      <dd className="m-0 min-w-0 text-sm leading-6">
                        <span className="block break-words text-muted">
                          <span className="font-semibold">Before:</span> {change.before}
                        </span>
                        <span className="mt-1 block break-words">
                          <span className="font-semibold">After:</span> {change.after}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mb-0 mt-4 border-y border-dashed border-border-strong py-4 text-sm text-muted">
                  No metadata fields changed in this revision.
                </p>
              )}
            </section>

            <section aria-labelledby="source-comparison-heading">
              <h2 id="source-comparison-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                Source comparison
              </h2>
              <p className="mb-0 mt-1.5 text-sm leading-6 text-muted">
                Added, removed, and changed labels carry the meaning without relying on color.
              </p>
              <div className="mt-4 max-w-full overflow-x-auto rounded-md border border-border">
                <ArticleSourceDiff
                  after={revision.article.mdx}
                  before={preceding?.article.mdx ?? ""}
                />
              </div>
            </section>
          </div>

          <aside className="space-y-8 lg:border-l lg:border-border lg:pl-6">
            <section aria-labelledby="revision-details-heading">
              <h2 id="revision-details-heading" className="m-0 text-lg font-semibold tracking-[-0.015em]">
                Revision details
              </h2>
              <dl className="m-0 mt-4 space-y-4 text-sm">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Category</dt>
                  <dd className="m-0 mt-1">{revision.categoryName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Saved path</dt>
                  <dd className="m-0 mt-1 break-all font-mono text-xs">
                    /{revision.categorySlug}/{revision.article.slug}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Revision hash</dt>
                  <dd className="m-0 mt-1 break-all font-mono text-xs">{revision.revisionHash}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Retained images</dt>
                  <dd className="m-0 mt-1">{revision.assetHashes.length}</dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="revision-events-heading" className="border-t border-border pt-6">
              <h2 id="revision-events-heading" className="m-0 text-lg font-semibold tracking-[-0.015em]">
                Workflow events
              </h2>
              {revision.events.length > 0 ? (
                <ol className="m-0 mt-4 list-none space-y-4 p-0">
                  {revision.events.map((event) => (
                    <li key={event.id} className="text-sm leading-6">
                      <p className="m-0 font-semibold">{eventLabels[event.action]}</p>
                      <p className="m-0 text-muted">
                        {event.memberDisplayName} ·{" "}
                        <time dateTime={event.createdAt.toISOString()}>
                          {timestampFormatter.format(event.createdAt)} UTC
                        </time>
                      </p>
                      {event.note ? <p className="mb-0 mt-1">{event.note}</p> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mb-0 mt-3 text-sm leading-6 text-muted">
                  No review or publication event is attached to this revision.
                </p>
              )}
              {revision.eventsTruncated ? (
                <p className="mb-0 mt-3 text-xs leading-5 text-muted">
                  Showing the latest 50 events for this revision.
                </p>
              ) : null}
            </section>

            <RestoreRevisionControl
              action={restoreArticleRevisionAction}
              canRestore={hasCapability(admin.role, "revision:restore")}
              current={{
                articleId: id,
                publicStatus: head.publicStatus,
                reviewState: head.reviewState,
                revisionId: head.revisionId,
                revisionNumber: head.revisionNumber,
              }}
              isArchived={archived}
              sourceRevisionId={revision.revisionId}
              sourceRevisionNumber={revision.revisionNumber}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
