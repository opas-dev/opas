// ABOUTME: Handles missing or unauthorized private article revisions without disclosure.
// ABOUTME: Returns one neutral route back to the authenticated content library.
import Link from "next/link";

export default function ArticleNotFound() {
  return (
    <main className="min-h-screen bg-background px-4 py-16 text-foreground sm:px-6">
      <div className="mx-auto max-w-xl border-y border-border py-8">
        <p className="m-0 text-sm font-semibold text-primary">Article unavailable</p>
        <h1 className="mb-0 mt-2 text-3xl font-semibold tracking-[-0.03em]">
          This saved content can’t be opened.
        </h1>
        <p className="mb-0 mt-3 text-sm leading-6 text-muted">
          It may no longer exist, or your current role may not have access.
        </p>
        <Link
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-semibold text-foreground no-underline"
          href="/admin/content"
        >
          Back to content
        </Link>
      </div>
    </main>
  );
}
