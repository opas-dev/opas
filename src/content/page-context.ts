// ABOUTME: Resolves public paths and allowed parent URLs to server-owned article identities.
// ABOUTME: Keeps current-page context bounded and limited to the published publication snapshot.

export const maximumPublishedPagePathUtf8Bytes = 512;

const maximumPublishedPageTitleUtf8Bytes = 640;
const articlePathPattern =
  /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const encoder = new TextEncoder();

export type PublishedPageIdentity = Readonly<{
  articleId: string;
  path: string;
  title: string;
}>;

export type PublishedPageCandidate = Readonly<{
  article: Readonly<{ id: string; title: string }>;
  path: string;
}>;

function validText(value: unknown, maximumUtf8Bytes: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    encoder.encode(value).byteLength <= maximumUtf8Bytes &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

export function isPublishedPageIdentity(value: unknown): value is PublishedPageIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    "articleId" in record &&
    "path" in record &&
    "title" in record &&
    validText(record.articleId, 1_000) &&
    typeof record.path === "string" &&
    encoder.encode(record.path).byteLength <= maximumPublishedPagePathUtf8Bytes &&
    articlePathPattern.test(record.path) &&
    validText(record.title, maximumPublishedPageTitleUtf8Bytes)
  );
}

export function resolvePublishedArticlePath(
  path: unknown,
  publications: readonly PublishedPageCandidate[],
): PublishedPageIdentity | null {
  if (
    typeof path !== "string" ||
    encoder.encode(path).byteLength > maximumPublishedPagePathUtf8Bytes ||
    !articlePathPattern.test(path)
  ) {
    return null;
  }
  const publication = publications.find((candidate) => candidate.path === path);
  if (!publication) return null;

  const identity = Object.freeze({
    articleId: publication.article.id,
    path: publication.path,
    title: publication.article.title,
  });
  return isPublishedPageIdentity(identity) ? identity : null;
}

export function resolvePublishedArticleUrl(
  pageUrl: unknown,
  parentOrigin: string,
  publications: readonly PublishedPageCandidate[],
): PublishedPageIdentity | null {
  if (typeof pageUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== parentOrigin
  ) {
    return null;
  }
  return resolvePublishedArticlePath(url.pathname, publications);
}
