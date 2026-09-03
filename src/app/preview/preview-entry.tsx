// ABOUTME: Clears signed-preview fragments before performing one same-origin exchange.
// ABOUTME: Keeps bearer values out of URLs, browser storage, rendered markup, and diagnostics.
"use client";

import { useEffect, useState } from "react";

type PreviewEntryState = "checking" | "invalid" | "unavailable";

const exchangeTasks = new Map<string, Promise<boolean>>();

function clearFragmentAndReadBearer() {
  if (!window.location.hash) return null;
  const bearer = window.location.hash.slice(1);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return bearer.length > 0 && bearer.length <= 2_048 ? bearer : "";
}

function exchangeFragment(pathname: string) {
  const activeTask = exchangeTasks.get(pathname);
  if (activeTask) return activeTask;

  const bearer = clearFragmentAndReadBearer();
  if (bearer === null) return Promise.resolve(true);
  if (bearer === "") return Promise.resolve(false);

  const task = fetch(`${pathname}/exchange`, {
    body: JSON.stringify({ bearer }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
    referrerPolicy: "no-referrer",
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => exchangeTasks.delete(pathname));
  exchangeTasks.set(pathname, task);
  return task;
}

async function recheckSession(pathname: string) {
  const response = await fetch(`${pathname}/session`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error("ARTICLE_PREVIEW_UNAVAILABLE");
  return true;
}

export function ArticlePreviewEntry() {
  const [state, setState] = useState<PreviewEntryState>("checking");

  useEffect(() => {
    let current = true;
    const pathname = window.location.pathname;

    void (async () => {
      try {
        if (!(await exchangeFragment(pathname))) {
          if (current) setState("invalid");
          return;
        }
        if (!(await recheckSession(pathname))) {
          if (current) setState("invalid");
          return;
        }
        window.location.replace(pathname);
      } catch {
        if (current) setState("unavailable");
      }
    })();

    return () => {
      current = false;
    };
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-12 text-foreground">
      <section
        aria-labelledby="preview-entry-heading"
        className="w-full max-w-md rounded-lg border border-border bg-surface-elevated p-6 sm:p-8"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-sm bg-primary text-xs font-bold text-primary-foreground"
          >
            O
          </span>
          <span className="text-sm font-bold tracking-[0.12em]">OPAS</span>
        </div>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.08em] text-primary">
          Private preview
        </p>
        <h1
          className="mt-2 text-2xl font-bold tracking-[-0.025em] text-balance"
          id="preview-entry-heading"
        >
          {state === "checking"
            ? "Opening this saved revision"
            : state === "invalid"
              ? "This preview is no longer available"
              : "We could not open this preview"}
        </h1>
        <p aria-live="polite" className="mt-3 text-sm leading-6 text-muted text-pretty">
          {state === "checking"
            ? "Checking the secure link before showing private content…"
            : state === "invalid"
              ? "It may have expired, been replaced, or been revoked. Ask the author for a fresh link."
              : "Refresh the page to try again. The link may still be valid."}
        </p>
        {state === "unavailable" ? (
          <button
            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
        ) : null}
      </section>
    </main>
  );
}
