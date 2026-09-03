// ABOUTME: Holds the article workspace steady while private revisions are loading.
// ABOUTME: Uses a motion-free accessible status that remains compact on narrow screens.

export default function ArticleLoading() {
  return (
    <main className="min-h-screen bg-background px-4 py-12 text-foreground sm:px-6">
      <div className="mx-auto w-full max-w-5xl" aria-busy="true" role="status">
        <p className="m-0 text-sm font-semibold text-primary">Loading article…</p>
        <div className="mt-6 h-10 max-w-xl rounded-md bg-surface-strong" aria-hidden="true" />
        <div className="mt-8 h-12 border-y border-border bg-surface" aria-hidden="true" />
        <div className="mt-8 grid gap-4 sm:grid-cols-2" aria-hidden="true">
          <div className="h-48 rounded-md border border-border bg-surface" />
          <div className="h-48 rounded-md border border-border bg-surface" />
        </div>
      </div>
    </main>
  );
}
