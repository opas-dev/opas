// ABOUTME: Defines the immutable article snapshot format and its deterministic identity.
// ABOUTME: Keeps migration, save, preview, comparison, and publication hashes portable.

const encoder = new TextEncoder();
const assetHashPattern = /^[a-f\d]{64}$/u;

export const articleRevisionFormat = "opas.article-revision.v1" as const;

export const articleChangeKinds = [
  "manual",
  "import",
  "rollback",
  "migration",
  "seed",
] as const;

export type ArticleChangeKind = (typeof articleChangeKinds)[number];

export type ArticleRevisionSnapshot = {
  workspaceId: string;
  articleId: string;
  categoryId: string;
  categorySlug: string;
  categoryName: string;
  slug: string;
  title: string;
  mdx: string;
  isFaq: boolean;
  authorName: string;
  position: number;
  assetHashes: readonly string[];
};

function canonicalAssetHashes(assetHashes: readonly string[]) {
  const hashes = [...new Set(assetHashes)].sort();
  if (hashes.some((hash) => !assetHashPattern.test(hash))) {
    throw new Error("Article revision assets must be lowercase SHA-256 hashes.");
  }
  return hashes;
}

export function serializeArticleRevision(snapshot: ArticleRevisionSnapshot) {
  return JSON.stringify([
    articleRevisionFormat,
    snapshot.workspaceId,
    snapshot.articleId,
    snapshot.categoryId,
    snapshot.categorySlug,
    snapshot.categoryName,
    snapshot.slug,
    snapshot.title,
    snapshot.mdx,
    snapshot.isFaq,
    snapshot.authorName,
    snapshot.position,
    canonicalAssetHashes(snapshot.assetHashes),
  ]);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function articleRevisionHash(snapshot: ArticleRevisionSnapshot) {
  return sha256(serializeArticleRevision(snapshot));
}

export async function migrationArticleRevisionId(
  workspaceId: string,
  articleId: string,
) {
  const digest = await sha256(
    JSON.stringify(["opas.migration-article-revision-id.v1", workspaceId, articleId]),
  );
  return `revision_${digest}`;
}
