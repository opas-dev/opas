// ABOUTME: Presents explicit, confirmed archive and revision recovery controls.
// ABOUTME: Keeps exact compare-and-swap fields hidden while focusing typed failures.
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  initialArticleRecoveryState,
  type ArticleRecoveryAction,
  type ArticleRecoverySnapshot,
} from "@/app/admin/content/article-recovery-contracts";

function CurrentRevisionFields({ snapshot }: { snapshot: ArticleRecoverySnapshot }) {
  return (
    <>
      <input name="id" type="hidden" value={snapshot.articleId} />
      <input name="revisionId" type="hidden" value={snapshot.revisionId} />
      <input
        name="expectedWorkingRevisionNumber"
        type="hidden"
        value={snapshot.revisionNumber}
      />
      <input
        name="expectedReviewState"
        type="hidden"
        value={snapshot.reviewState}
      />
    </>
  );
}

function RecoveryForm({
  action,
  buttonLabel,
  children,
  confirmation,
  danger = false,
  effect,
  noteLabel,
  successHref,
}: Readonly<{
  action: ArticleRecoveryAction;
  buttonLabel: string;
  children: ReactNode;
  confirmation: string;
  danger?: boolean;
  effect: string;
  noteLabel: string;
  successHref: string;
}>) {
  const [state, formAction, pending] = useActionState(
    action,
    initialArticleRecoveryState,
  );
  const [confirmed, setConfirmed] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  const noteId = `${buttonLabel.toLowerCase().replaceAll(" ", "-")}-note`;

  useEffect(() => {
    if (state.status === "error") feedback.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="mt-4 space-y-4">
      {children}
      <p className="m-0 text-sm leading-6 text-muted">{effect}</p>
      <div>
        <label className="block text-sm font-semibold" htmlFor={noteId}>
          {noteLabel} <span className="font-normal text-muted">(optional)</span>
        </label>
        <textarea
          className="mt-2 min-h-20 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-6"
          disabled={pending}
          id={noteId}
          maxLength={500}
          name="note"
        />
      </div>
      <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
        <input
          checked={confirmed}
          className="mt-1 size-4 shrink-0"
          disabled={pending}
          name="confirmation"
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        <span>{confirmation}</span>
      </label>
      <button
        className={`min-h-11 rounded-md border px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
          danger
            ? "border-danger bg-background text-danger"
            : "border-primary bg-primary text-primary-foreground"
        }`}
        disabled={!confirmed || pending}
        type="submit"
      >
        {pending ? "Working…" : buttonLabel}
      </button>
      <div
        aria-atomic="true"
        aria-live="polite"
        className={`min-h-6 text-sm font-medium ${
          state.status === "error"
            ? "text-danger"
            : state.status === "success"
              ? "text-success"
              : "text-muted"
        }`}
        ref={feedback}
        role={state.status === "error" ? "alert" : "status"}
        tabIndex={state.status === "error" ? -1 : undefined}
      >
        {pending ? "Applying this action to the exact saved revision…" : state.message}
        {state.status === "error" && state.currentRevisionNumber ? (
          <Link
            className="ml-2 inline-flex min-h-9 items-center rounded-md border border-border-strong px-3 text-sm font-semibold text-foreground no-underline"
            href={`${successHref}/history/${state.currentRevisionNumber}`}
          >
            Open revision {state.currentRevisionNumber}
          </Link>
        ) : null}
        {state.status === "success" ? (
          <Link
            className="ml-2 font-semibold text-foreground underline underline-offset-4"
            href={successHref}
          >
            Open current draft
          </Link>
        ) : null}
      </div>
    </form>
  );
}

export function ArticleLifecycleControls({
  archiveAction,
  canArchive,
  canRestoreArchived,
  isArchived,
  restoreArchivedAction,
  snapshot,
}: Readonly<{
  archiveAction: ArticleRecoveryAction;
  canArchive: boolean;
  canRestoreArchived: boolean;
  isArchived: boolean;
  restoreArchivedAction: ArticleRecoveryAction;
  snapshot: ArticleRecoverySnapshot;
}>) {
  if (isArchived) {
    return (
      <section
        aria-labelledby="article-archive-heading"
        className="border-y border-border bg-surface-strong px-5 py-6 sm:px-6"
      >
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
          Archived · Not public
        </p>
        <h2 id="article-archive-heading" className="mb-0 mt-2 text-xl font-semibold tracking-[-0.02em]">
          This article is read-only
        </h2>
        <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
          Its working revision, full history, and retained images are intact. Restore it before
          editing or starting review again.
        </p>
        {canRestoreArchived ? (
          <RecoveryForm
            action={restoreArchivedAction}
            buttonLabel="Restore private draft"
            confirmation="I understand this restores the article privately and does not republish it."
            effect="The current working revision returns in Editing state. The former public revision stays in history."
            noteLabel="Restoration note"
            successHref={`/admin/content/articles/${snapshot.articleId}`}
          >
            <CurrentRevisionFields snapshot={snapshot} />
            <input name="expectedPublicStatus" type="hidden" value={snapshot.publicStatus} />
          </RecoveryForm>
        ) : (
          <p className="mb-0 mt-4 text-sm font-medium">
            An administrator or editor can restore this private draft.
          </p>
        )}
      </section>
    );
  }

  if (!canArchive) return null;

  return (
    <section aria-labelledby="article-retirement-heading" className="border-t border-border pt-6">
      <h2 id="article-retirement-heading" className="m-0 text-lg font-semibold tracking-[-0.015em]">
        Retire this answer
      </h2>
      <details className="mt-3 rounded-md border border-border bg-surface px-4 py-3">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-danger">
          Archive article
        </summary>
        <RecoveryForm
          action={archiveAction}
          buttonLabel="Archive article"
          confirmation="I understand this removes every public surface and revokes active preview links."
          danger
          effect="History and retained images are kept. If this answer is live, its search evidence is removed in the same commit."
          noteLabel="Archive note"
          successHref={`/admin/content/articles/${snapshot.articleId}`}
        >
          <CurrentRevisionFields snapshot={snapshot} />
          <input name="expectedPublicStatus" type="hidden" value={snapshot.publicStatus} />
        </RecoveryForm>
      </details>
    </section>
  );
}

export function RestoreRevisionControl({
  action,
  canRestore,
  current,
  isArchived,
  sourceRevisionId,
  sourceRevisionNumber,
}: Readonly<{
  action: ArticleRecoveryAction;
  canRestore: boolean;
  current: ArticleRecoverySnapshot;
  isArchived: boolean;
  sourceRevisionId: string;
  sourceRevisionNumber: number;
}>) {
  if (!canRestore) return null;

  const unavailable =
    isArchived
      ? "Restore the archived article before choosing a historical revision."
      : current.reviewState === "in_review"
        ? "Withdraw the current revision from review before restoring history."
        : current.revisionId === sourceRevisionId
          ? "This is already the working revision."
          : null;

  return (
    <section aria-labelledby="restore-revision-heading" className="border-t border-border pt-6">
      <h2 id="restore-revision-heading" className="m-0 text-lg font-semibold tracking-[-0.015em]">
        Restore this version
      </h2>
      {unavailable ? (
        <p className="mb-0 mt-2 text-sm leading-6 text-muted">{unavailable}</p>
      ) : (
        <RecoveryForm
          action={action}
          buttonLabel={`Restore revision ${sourceRevisionNumber}`}
          confirmation={`I understand this creates private revision ${current.revisionNumber + 1} and does not change the live answer.`}
          effect={`The current working revision ${current.revisionNumber} remains in history. This saved source and its retained images become a new editable draft.`}
          noteLabel="Reason for restoring"
          successHref={`/admin/content/articles/${current.articleId}`}
        >
          <CurrentRevisionFields snapshot={current} />
          <input name="sourceRevisionId" type="hidden" value={sourceRevisionId} />
          <input name="sourceRevisionNumber" type="hidden" value={sourceRevisionNumber} />
        </RecoveryForm>
      )}
    </section>
  );
}
