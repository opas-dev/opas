// ABOUTME: Presents role-appropriate review and publication actions for one exact saved revision.
// ABOUTME: Keeps working and live status distinct while announcing conflicts and public effects.
"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState, useTransition } from "react";

import type {
  ArticleWorkflowAction,
  ArticleWorkflowActionState,
} from "@/app/admin/content/article-action-contracts";
import type { ArticleReviewState } from "@/content/article-workflow";

export type ArticleWorkflowActions = Readonly<{
  approve: ArticleWorkflowAction;
  approveAndPublish: ArticleWorkflowAction;
  emergencyPublish: ArticleWorkflowAction;
  publish: ArticleWorkflowAction;
  requestChanges: ArticleWorkflowAction;
  submit: ArticleWorkflowAction;
  unpublish: ArticleWorkflowAction;
  withdraw: ArticleWorkflowAction;
}>;

export type ArticleWorkflowPermissions = Readonly<{
  canEmergencyPublish: boolean;
  canPublish: boolean;
  canReview: boolean;
  canSubmit: boolean;
  canUnpublish: boolean;
  canWithdraw: boolean;
}>;

export type ArticleWorkflowSnapshot = Readonly<{
  articleId: string;
  publicStatus: "draft" | "published";
  publishedRevisionNumber: number | null;
  reviewState: ArticleReviewState;
  revisionId: string;
  revisionNumber: number;
}>;

type ArticleWorkflowControlsProps = Readonly<{
  actions: ArticleWorkflowActions;
  hasUnsavedChanges: boolean;
  permissions: ArticleWorkflowPermissions;
  workflow: ArticleWorkflowSnapshot;
}>;

const reviewStateLabels: Record<ArticleReviewState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  editing: "Editing",
  in_review: "In review",
  published: "Published",
};

function RevisionFields({ workflow }: Readonly<{ workflow: ArticleWorkflowSnapshot }>) {
  return (
    <>
      <input name="id" type="hidden" value={workflow.articleId} />
      <input name="revisionId" type="hidden" value={workflow.revisionId} />
      <input
        name="expectedWorkingRevisionNumber"
        type="hidden"
        value={workflow.revisionNumber}
      />
      <input
        name="expectedReviewState"
        type="hidden"
        value={workflow.reviewState}
      />
    </>
  );
}

function PublicAction({
  buttonLabel,
  children,
  disabled,
  onSubmit,
  pending,
  summary,
  workflow,
}: Readonly<{
  buttonLabel: string;
  children?: ReactNode;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  summary: string;
  workflow: ArticleWorkflowSnapshot;
}>) {
  return (
    <details className="border-t border-border py-3 first:border-t-0">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-foreground">
        {summary}
      </summary>
      <form className="pb-2 pt-3" onSubmit={onSubmit}>
        <RevisionFields workflow={workflow} />
        {children}
        <button
          className="mt-3 min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || pending}
          type="submit"
        >
          {pending ? "Working…" : buttonLabel}
        </button>
      </form>
    </details>
  );
}

function workingStateCopy(state: ArticleReviewState) {
  return {
    approved: "This exact revision passed review and is ready to publish.",
    changes_requested: "Address the review note, save a new revision, then submit again.",
    editing: "This saved revision is private and can still be edited.",
    in_review: "This exact revision is locked while a reviewer decides.",
    published: "The working revision and the live revision are the same.",
  }[state];
}

function liveStateCopy(workflow: ArticleWorkflowSnapshot) {
  if (workflow.publicStatus === "draft" || workflow.publishedRevisionNumber === null) {
    return "No revision is currently public.";
  }
  return workflow.publishedRevisionNumber === workflow.revisionNumber
    ? `Revision ${workflow.publishedRevisionNumber} is live.`
    : `Revision ${workflow.publishedRevisionNumber} is live. Working revision ${workflow.revisionNumber} remains private.`;
}

export function ArticleWorkflowControls({
  actions,
  hasUnsavedChanges,
  permissions,
  workflow,
}: ArticleWorkflowControlsProps) {
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<ArticleWorkflowActionState | null>(null);
  const blockedByLocalChanges = hasUnsavedChanges;

  useEffect(() => {
    if (result?.status === "error") feedback.current?.focus();
  }, [result]);

  function submit(action: ArticleWorkflowAction) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting.current || blockedByLocalChanges) return;
      submitting.current = true;
      setResult(null);
      const formData = new FormData(event.currentTarget);
      startTransition(async () => {
        try {
          setResult(await action(formData));
        } catch {
          setResult({
            status: "error",
            message: "The article action could not be completed. Reload and try again.",
          });
        } finally {
          submitting.current = false;
        }
      });
    };
  }

  const canSubmit =
    permissions.canSubmit &&
    (workflow.reviewState === "editing" ||
      workflow.reviewState === "changes_requested");
  const canWithdraw =
    permissions.canWithdraw && workflow.reviewState === "in_review";
  const canReview = permissions.canReview && workflow.reviewState === "in_review";
  const canPublish = permissions.canPublish && workflow.reviewState === "approved";
  const canEmergencyPublish =
    permissions.canEmergencyPublish && workflow.reviewState !== "published";
  const canUnpublish =
    permissions.canUnpublish && workflow.publicStatus === "published";
  const hasAction =
    canSubmit ||
    canWithdraw ||
    canReview ||
    canPublish ||
    canEmergencyPublish ||
    canUnpublish;

  return (
    <section
      aria-labelledby="article-workflow-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <div className="p-5 sm:p-6">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
          Persisted revision {workflow.revisionNumber}
        </p>
        <h2
          className="mb-0 mt-2 text-xl font-semibold tracking-[-0.02em]"
          id="article-workflow-heading"
        >
          Review and publication
        </h2>
      </div>

      <dl className="m-0 grid border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-border">
        <div className="p-5 sm:p-6">
          <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            Working
          </dt>
          <dd className="m-0 mt-2">
            <span className="inline-flex rounded-full bg-surface-strong px-2.5 py-1 text-xs font-semibold text-foreground">
              {reviewStateLabels[workflow.reviewState]}
            </span>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              {workingStateCopy(workflow.reviewState)}
            </p>
          </dd>
        </div>
        <div className="border-t border-border p-5 sm:border-t-0 sm:p-6">
          <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            Live
          </dt>
          <dd className="m-0 mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                workflow.publicStatus === "published"
                  ? "bg-success text-success-foreground"
                  : "bg-surface-strong text-muted"
              }`}
            >
              {workflow.publicStatus === "published" ? "Published" : "Not live"}
            </span>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              {liveStateCopy(workflow)}
            </p>
          </dd>
        </div>
      </dl>

      <div className="p-5 sm:p-6">
        {blockedByLocalChanges ? (
          <p className="m-0 rounded-md bg-surface-strong px-3 py-2 text-sm text-foreground" role="status">
            Save or discard your local changes before changing review or publication state.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-3 first:mt-0">
          {canSubmit ? (
            <form onSubmit={submit(actions.submit)}>
              <RevisionFields workflow={workflow} />
              <button
                className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={blockedByLocalChanges || pending}
                type="submit"
              >
                {pending ? "Working…" : "Submit for review"}
              </button>
            </form>
          ) : null}
          {canWithdraw ? (
            <form onSubmit={submit(actions.withdraw)}>
              <RevisionFields workflow={workflow} />
              <button
                className="min-h-11 rounded-md border border-border-strong bg-background px-4 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={blockedByLocalChanges || pending}
                type="submit"
              >
                {pending ? "Working…" : "Withdraw from review"}
              </button>
            </form>
          ) : null}
          {canReview ? (
            <form onSubmit={submit(actions.approve)}>
              <RevisionFields workflow={workflow} />
              <button
                className="min-h-11 rounded-md border border-border-strong bg-background px-4 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={blockedByLocalChanges || pending}
                type="submit"
              >
                {pending ? "Working…" : "Approve privately"}
              </button>
            </form>
          ) : null}
        </div>

        {canReview ? (
          <form
            className="mt-5 border-t border-border pt-5"
            onSubmit={submit(actions.requestChanges)}
          >
            <RevisionFields workflow={workflow} />
            <label className="block text-sm font-semibold" htmlFor="review-change-note">
              Request changes
            </label>
            <p className="mb-0 mt-1 text-xs leading-5 text-muted">
              Tell the author what must change on this exact revision.
            </p>
            <textarea
              className="mt-2 min-h-24 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-6"
              disabled={blockedByLocalChanges || pending}
              id="review-change-note"
              maxLength={500}
              name="note"
              required
            />
            <button
              className="mt-3 min-h-11 rounded-md border border-border-strong bg-background px-4 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={blockedByLocalChanges || pending}
              type="submit"
            >
              {pending ? "Working…" : "Send change request"}
            </button>
          </form>
        ) : null}

        {canReview || canPublish || canEmergencyPublish || canUnpublish ? (
          <div className="mt-5 border-t border-border">
            {canReview && permissions.canPublish ? (
              <PublicAction
                buttonLabel="Approve and publish revision"
                disabled={blockedByLocalChanges}
                onSubmit={submit(actions.approveAndPublish)}
                pending={pending}
                summary="Approve this exact revision and make it public"
                workflow={workflow}
              />
            ) : null}
            {canPublish ? (
              <PublicAction
                buttonLabel="Publish approved revision"
                disabled={blockedByLocalChanges}
                onSubmit={submit(actions.publish)}
                pending={pending}
                summary="Publish this approved revision"
                workflow={workflow}
              />
            ) : null}
            {canEmergencyPublish ? (
              <PublicAction
                buttonLabel="Emergency publish revision"
                disabled={blockedByLocalChanges}
                onSubmit={submit(actions.emergencyPublish)}
                pending={pending}
                summary="Emergency publish outside the review path"
                workflow={workflow}
              >
                <label className="block text-sm font-semibold" htmlFor="emergency-publish-reason">
                  Required reason
                </label>
                <textarea
                  className="mt-2 min-h-24 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-6"
                  disabled={blockedByLocalChanges || pending}
                  id="emergency-publish-reason"
                  maxLength={500}
                  name="reason"
                  required
                />
              </PublicAction>
            ) : null}
            {canUnpublish ? (
              <PublicAction
                buttonLabel="Unpublish and keep history"
                disabled={blockedByLocalChanges}
                onSubmit={submit(actions.unpublish)}
                pending={pending}
                summary="Remove the current article from the public help center"
                workflow={workflow}
              />
            ) : null}
          </div>
        ) : null}

        {!hasAction ? (
          <p className="m-0 mt-4 text-sm leading-6 text-muted">
            No review or publication action is available for your role in this state.
          </p>
        ) : null}

        <div
          aria-atomic="true"
          aria-live="polite"
          className={`mt-4 min-h-6 text-sm font-medium ${
            result?.status === "error"
              ? "text-danger"
              : result?.status === "success"
                ? "text-success"
                : "text-muted"
          }`}
          ref={feedback}
          role={result?.status === "error" ? "alert" : "status"}
          tabIndex={result?.status === "error" ? -1 : undefined}
        >
          {pending
            ? "Applying the action to this saved revision…"
            : result?.message || "Actions apply only to the persisted revision shown above."}
          {result?.status === "error" && result.currentRevisionNumber ? (
            <button
              className="ml-2 min-h-9 rounded-md border border-border-strong px-3 text-sm font-semibold text-foreground"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload latest
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
