// ABOUTME: Defines named-member activation contracts for private knowledge imports.
// ABOUTME: Keeps create-only conflicts and immutable revision inputs portable across databases.
import type { MemberActor } from "@/auth/member-repository";
import { referencedArticleAssetHashes } from "@/content/article-assets";
import { articleRevisionHash } from "@/content/article-revision";
import { validateArticleMdx } from "@/content/mdx-safety";
import { prepareAssetSelection } from "@/db/assets";

const identifierPattern = /^[A-Za-z0-9_-]{1,100}$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reservedCategorySlugs = new Set(["admin", "api", "spike"]);
const encoder = new TextEncoder();

function validPosition(position: number) {
  return Number.isInteger(position) && position >= 0 && position <= 10_000;
}

function validTrimmedText(value: string, maximum: number) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= maximum
  );
}

function validSlug(value: string) {
  return (
    typeof value === "string" &&
    value.length <= 120 &&
    slugPattern.test(value)
  );
}

export type KnowledgeImportCategory = Readonly<{
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
}>;

export type KnowledgeImportArticle = Readonly<{
  id: string;
  revisionId: string;
  categoryId: string;
  categorySlug: string;
  categoryName: string;
  slug: string;
  title: string;
  mdx: string;
  isFaq: boolean;
  authorName: string;
  position: number;
  revisionHash: string;
  changeSummary: string | null;
  assetHashes: readonly string[];
}>;

export type KnowledgeImport = Readonly<{
  actor: MemberActor;
  manifestId: string;
  categories: readonly KnowledgeImportCategory[];
  articles: readonly KnowledgeImportArticle[];
}>;

export type KnowledgeImportSlugClaims = Readonly<{
  articleSlugs: readonly string[];
  categorySlugs: readonly string[];
}>;

export type KnowledgeImportConflictCode =
  | "ACTOR_FORBIDDEN"
  | "ARTICLE_CONFLICT"
  | "ASSET_UNAVAILABLE"
  | "CATEGORY_CONFLICT";

export type KnowledgeImportActivationResult =
  | Readonly<{ status: "activated" }>
  | Readonly<{ status: "conflict"; code: KnowledgeImportConflictCode }>;

export type KnowledgeImportRepository = Readonly<{
  activateKnowledgeImport(
    knowledgeImport: KnowledgeImport,
  ): Promise<KnowledgeImportActivationResult>;
  listKnowledgeImportSlugClaims(actor: MemberActor): Promise<KnowledgeImportSlugClaims>;
}>;

export class KnowledgeImportAuthorizationError extends Error {
  readonly code = "KNOWLEDGE_IMPORT_FORBIDDEN";

  constructor() {
    super("KNOWLEDGE_IMPORT_FORBIDDEN");
    this.name = "KnowledgeImportAuthorizationError";
  }
}

export function knowledgeImportTimestamp(clock: () => Date) {
  const timestamp = clock();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new Error("KNOWLEDGE_IMPORT_CLOCK_INVALID");
  }
  return new Date(timestamp.getTime());
}

export async function assertKnowledgeImportIntegrity(
  knowledgeImport: KnowledgeImport,
): Promise<void> {
  if (
    !validTrimmedText(knowledgeImport.manifestId, 100) ||
    knowledgeImport.categories.length < 1 ||
    knowledgeImport.categories.length > 100 ||
    knowledgeImport.articles.length < 1 ||
    knowledgeImport.articles.length > 100
  ) {
    throw new Error("KNOWLEDGE_IMPORT_INVALID");
  }

  const categoryIds = new Set<string>();
  const categorySlugs = new Set<string>();
  const categories = new Map<string, KnowledgeImportCategory>();
  for (const category of knowledgeImport.categories) {
    if (
      !identifierPattern.test(category.id) ||
      !validTrimmedText(category.name, 100) ||
      (category.description !== null &&
        !validTrimmedText(category.description, 300)) ||
      !validPosition(category.position) ||
      categoryIds.has(category.id) ||
      categorySlugs.has(category.slug) ||
      !validSlug(category.slug) ||
      reservedCategorySlugs.has(category.slug)
    ) {
      throw new Error("KNOWLEDGE_IMPORT_INVALID");
    }
    categoryIds.add(category.id);
    categorySlugs.add(category.slug);
    categories.set(category.id, category);
  }

  const articleIds = new Set<string>();
  const articleSlugs = new Set<string>();
  const revisionIds = new Set<string>();
  const usedCategoryIds = new Set<string>();
  const importAssetHashes = new Set<string>();
  for (const article of knowledgeImport.articles) {
    const category = categories.get(article.categoryId);
    if (
      !category ||
      !identifierPattern.test(article.id) ||
      !identifierPattern.test(article.revisionId) ||
      !validSlug(article.slug) ||
      !validTrimmedText(article.title, 160) ||
      !validTrimmedText(article.authorName, 100) ||
      typeof article.isFaq !== "boolean" ||
      !validPosition(article.position) ||
      typeof article.mdx !== "string" ||
      article.mdx.length < 1 ||
      encoder.encode(article.mdx).byteLength > 100_000 ||
      (article.changeSummary !== null &&
        !validTrimmedText(article.changeSummary, 500)) ||
      category.slug !== article.categorySlug ||
      category.name !== article.categoryName ||
      articleIds.has(article.id) ||
      articleSlugs.has(article.slug) ||
      revisionIds.has(article.revisionId) ||
      article.slug !== article.slug.trim().toLocaleLowerCase("en-US")
    ) {
      throw new Error("KNOWLEDGE_IMPORT_INVALID");
    }
    articleIds.add(article.id);
    articleSlugs.add(article.slug);
    revisionIds.add(article.revisionId);
    usedCategoryIds.add(article.categoryId);

    const { hashes } = prepareAssetSelection({ hashes: article.assetHashes });
    if (
      hashes.length !== article.assetHashes.length ||
      hashes.some((hash, index) => hash !== article.assetHashes[index])
    ) {
      throw new Error("KNOWLEDGE_IMPORT_INVALID");
    }
    await validateArticleMdx(article.mdx, article.title);
    const referencedHashes = referencedArticleAssetHashes(article.mdx);
    if (
      referencedHashes.length !== hashes.length ||
      referencedHashes.some((hash, index) => hash !== hashes[index])
    ) {
      throw new Error("KNOWLEDGE_IMPORT_INVALID");
    }
    for (const hash of hashes) importAssetHashes.add(hash);

    const revisionHash = await articleRevisionHash({
      workspaceId: knowledgeImport.actor.workspaceId,
      articleId: article.id,
      categoryId: article.categoryId,
      categorySlug: article.categorySlug,
      categoryName: article.categoryName,
      slug: article.slug,
      title: article.title,
      mdx: article.mdx,
      isFaq: article.isFaq,
      authorName: article.authorName,
      position: article.position,
      assetHashes: article.assetHashes,
    });
    if (revisionHash !== article.revisionHash) {
      throw new Error("KNOWLEDGE_IMPORT_INVALID");
    }
  }
  if (
    usedCategoryIds.size !== categories.size ||
    importAssetHashes.size > 100
  ) {
    throw new Error("KNOWLEDGE_IMPORT_INVALID");
  }
}
