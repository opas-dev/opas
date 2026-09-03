// ABOUTME: Lets content owners create, copy, rotate, and revoke an exact-revision preview.
// ABOUTME: Keeps the one-time signed link only in transient component state.
"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";

import type {
  ArticlePreviewAction,
  ArticlePreviewActionState,
  ArticlePreviewShare,
} from "@/app/admin/content/article-preview-contracts";

type ArticlePreviewControlsProps = Readonly<{
  createPreview: ArticlePreviewAction;
  revisionId: string;
  revisionNumber: number;
  revokePreview: ArticlePreviewAction;
}>;

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function ArticlePreviewLink({ link }: Readonly<{ link: ArticlePreviewShare }>) {
  const input = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [link.url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopyStatus("Copied to clipboard.");
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopyStatus("Select the link and copy it manually.");
    }
  }

  return (
    <div className="border-t border-border pt-5">
      <label className="block text-sm font-semibold" htmlFor="article-preview-link">
        Private preview link
      </label>
      <p className="mb-0 mt-1 text-xs leading-5 text-muted">
        Visible once · expires {dateFormatter.format(new Date(link.expiresAt))} UTC
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          ref={input}
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-background px-3 font-mono text-xs"
          id="article-preview-link"
          readOnly
          spellCheck={false}
          type="text"
          value={link.url}
        />
        <button
          className="min-h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
          onClick={copyLink}
          type="button"
        >
          Copy link
        </button>
      </div>
      <p
        aria-live="polite"
        className="mb-0 mt-2 min-h-5 text-xs font-medium text-muted"
        role="status"
      >
        {copyStatus}
      </p>
      {link.externalImageHosts.length > 0 ? (
        <aside className="mt-3 rounded-md bg-surface-strong px-4 py-3 text-sm leading-6 text-muted">
          <p className="m-0 font-semibold text-foreground">External images</p>
          <p className="mb-0 mt-1">
            Opening this preview contacts {link.externalImageHosts.join(", ")}. Those
            services can observe the viewer’s IP address and request timing.
          </p>
        </aside>
      ) : null}
    </div>
  );
}

export function ArticlePreviewControls({
  createPreview,
  revisionId,
  revisionNumber,
  revokePreview,
}: ArticlePreviewControlsProps) {
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const [result, setResult] = useState<ArticlePreviewActionState | null>(null);

  function submit(action: ArticlePreviewAction) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting.current) return;
      submitting.current = true;
      setResult(null);
      const formData = new FormData(event.currentTarget);

      startTransition(async () => {
        try {
          setResult(await action(formData));
        } catch {
          setResult({
            message: "The preview request could not be completed. Reload and try again.",
            status: "error",
          });
        } finally {
          submitting.current = false;
        }
      });
    };
  }

  return (
    <section
      aria-labelledby="article-preview-controls-heading"
      className="rounded-lg border border-border bg-surface p-5 sm:p-6"
    >
      <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
        Private sharing
      </p>
      <h2
        className="mb-0 mt-2 text-xl font-semibold tracking-[-0.02em]"
        id="article-preview-controls-heading"
      >
        Share revision {revisionNumber}
      </h2>
      <p className="mb-0 mt-2 max-w-[62ch] text-sm leading-6 text-muted">
        The link opens only this saved revision and expires after seven days. Creating
        another link for this revision immediately replaces the previous one.
      </p>

      <form className="mt-5" onSubmit={submit(createPreview)}>
        <input name="revisionId" type="hidden" value={revisionId} />
        <button
          className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
          disabled={pending}
          type="submit"
        >
          {pending ? "Creating…" : result?.link ? "Rotate link" : "Create share link"}
        </button>
      </form>

      {result ? (
        <div className="mt-4 space-y-4">
          <p
            aria-atomic="true"
            aria-live="polite"
            className={`m-0 rounded-md px-3 py-2 text-sm leading-5 ${
              result.status === "error"
                ? "bg-danger text-danger-foreground"
                : "bg-success text-success-foreground"
            }`}
            role={result.status === "error" ? "alert" : "status"}
          >
            {result.message}
          </p>
          {result.link ? (
            <>
              <ArticlePreviewLink link={result.link} />
              <form onSubmit={submit(revokePreview)}>
                <input name="grantId" type="hidden" value={result.link.grantId} />
                <button
                  className="min-h-11 rounded-md border border-danger bg-background px-4 text-sm font-semibold text-danger disabled:cursor-wait disabled:opacity-60"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? "Revoking…" : "Revoke link"}
                </button>
              </form>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
