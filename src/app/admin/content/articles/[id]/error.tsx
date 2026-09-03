// ABOUTME: Gives article and history routes a private, retryable error boundary.
// ABOUTME: Focuses the recovery choice without exposing server or revision details.
"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export default function ArticleError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="min-h-screen bg-background px-4 py-16 text-foreground sm:px-6">
      <div className="mx-auto max-w-xl border-y border-border py-8">
        <p className="m-0 text-sm font-semibold text-danger">Article unavailable</p>
        <h1
          className="mb-0 mt-2 text-3xl font-semibold tracking-[-0.03em]"
          ref={heading}
          tabIndex={-1}
        >
          We couldn’t load this saved content.
        </h1>
        <p className="mb-0 mt-3 text-sm leading-6 text-muted">
          Retry the private read. No article or revision was changed.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
            onClick={() => retry()}
            type="button"
          >
            Try again
          </button>
          <Link
            className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-semibold text-foreground no-underline"
            href="/admin/content"
          >
            Content library
          </Link>
        </div>
      </div>
    </main>
  );
}
