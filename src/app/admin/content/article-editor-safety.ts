// ABOUTME: Defines stable article snapshots and filters navigation clicks that can discard edits.
// ABOUTME: Keeps dirty-state and same-document navigation decisions deterministic and testable.

export type ArticleEditorSnapshotValues = {
  title: string;
  categoryId: string;
  slug: string;
  authorName: string;
  isFaq: boolean;
  source: string;
};

export type ArticleEditorNavigationIntent = {
  currentUrl: string;
  href: string;
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  download: boolean;
  target: string;
};

export function articleEditorSnapshot(values: ArticleEditorSnapshotValues) {
  return JSON.stringify([
    values.title,
    values.categoryId,
    values.slug,
    values.authorName,
    values.isFaq,
    values.source,
  ]);
}

export function articleEditorNavigationNeedsConfirmation(
  intent: ArticleEditorNavigationIntent,
) {
  if (
    intent.button !== 0 ||
    intent.altKey ||
    intent.ctrlKey ||
    intent.metaKey ||
    intent.shiftKey ||
    intent.download ||
    (intent.target !== "" && intent.target !== "_self")
  ) {
    return false;
  }

  let currentUrl: URL;
  let nextUrl: URL;
  try {
    currentUrl = new URL(intent.currentUrl);
    nextUrl = new URL(intent.href, currentUrl);
  } catch {
    return false;
  }

  if (nextUrl.origin !== currentUrl.origin) {
    return false;
  }

  return (
    nextUrl.pathname !== currentUrl.pathname ||
    nextUrl.search !== currentUrl.search
  );
}
