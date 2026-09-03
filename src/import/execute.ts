// ABOUTME: Stages one approved knowledge plan for a named member and activates it atomically.
// ABOUTME: Creates attributed private revisions while cleaning failed authorized asset manifests.
import type { MemberActor } from "@/auth/member-repository";
import { referencedArticleAssetHashes } from "@/content/article-assets";
import { articleRevisionHash } from "@/content/article-revision";
import { AuthoringPausedError, normalizeAuthoringError } from "@/db/authoring-controls";
import { prepareAsset, prepareAssetSelection } from "@/db/assets";
import type {
  KnowledgeImportArticle,
  KnowledgeImportConflictCode,
} from "@/db/knowledge-import";
import type { Repository } from "@/db/repository";
import { archiveLimits } from "@/import/archive";
import type { KnowledgeImportPlan } from "@/import/planner";

type ImportRepository = Pick<
  Repository,
  | "activateKnowledgeImport"
  | "cleanupAuthorizedExpiredAssets"
  | "createAuthorizedAssetManifest"
  | "discardAuthorizedAssetManifest"
  | "stageAuthorizedAsset"
>;

type ImportExecutionOptions = {
  repository: ImportRepository;
  actor: MemberActor;
  plan: KnowledgeImportPlan;
  clock?: () => Date;
  createId?: () => string;
};

export class ImportExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportExecutionError";
  }
}

export class ImportExecutionConflictError extends ImportExecutionError {
  readonly code: KnowledgeImportConflictCode;

  constructor(code: KnowledgeImportConflictCode) {
    super(code);
    this.name = "ImportExecutionConflictError";
    this.code = code;
  }
}

async function assertExecutablePlan(plan: KnowledgeImportPlan) {
  if (
    plan.categories.length < 1 ||
    plan.categories.length > 100 ||
    plan.articles.length < 1 ||
    plan.articles.length > 100 ||
    plan.assets.length > 100
  ) {
    throw new ImportExecutionError("The import plan exceeds the activation limits.");
  }

  const categorySlugs = new Set(plan.categories.map(({ slug }) => slug));
  const usedCategorySlugs = new Set(plan.articles.map(({ categorySlug }) => categorySlug));
  const articleSlugs = new Set(plan.articles.map(({ slug }) => slug));
  if (
    categorySlugs.size !== plan.categories.length ||
    articleSlugs.size !== plan.articles.length ||
    usedCategorySlugs.size !== categorySlugs.size ||
    [...usedCategorySlugs].some((slug) => !categorySlugs.has(slug))
  ) {
    throw new ImportExecutionError("The import plan has inconsistent category or article claims.");
  }

  const assetHashes = new Set<string>();
  let assetBytes = 0;
  for (const asset of plan.assets) {
    const prepared = await prepareAsset({
      mediaType: asset.mediaType,
      content: asset.content,
    });
    assetBytes += prepared.byteSize;
    if (
      prepared.hash !== asset.hash ||
      prepared.byteSize !== asset.byteSize ||
      assetHashes.has(asset.hash)
    ) {
      throw new ImportExecutionError("The import plan has inconsistent assets.");
    }
    assetHashes.add(asset.hash);
  }
  if (assetBytes > archiveLimits.totalBytes) {
    throw new ImportExecutionError("The import plan exceeds the asset byte limit.");
  }

  const referencedHashes = new Set<string>();
  for (const article of plan.articles) {
    const { hashes } = prepareAssetSelection({ hashes: article.assetHashes });
    const mdxHashes = referencedArticleAssetHashes(article.mdx);
    if (
      hashes.length !== article.assetHashes.length ||
      hashes.some((hash, index) => hash !== article.assetHashes[index]) ||
      mdxHashes.length !== hashes.length ||
      mdxHashes.some((hash, index) => hash !== hashes[index])
    ) {
      throw new ImportExecutionError("The import plan has inconsistent article assets.");
    }
    for (const hash of hashes) referencedHashes.add(hash);
  }
  if (
    referencedHashes.size !== assetHashes.size ||
    [...referencedHashes].some((hash) => !assetHashes.has(hash))
  ) {
    throw new ImportExecutionError("The import plan has inconsistent asset references.");
  }
}

export const knowledgeImportManifestLifetimeMilliseconds = 60 * 60 * 1000;

export async function executeKnowledgeImport({
  repository,
  actor,
  plan,
  clock = () => new Date(),
  createId = () => crypto.randomUUID(),
}: ImportExecutionOptions) {
  if (!plan.ready) {
    throw new ImportExecutionError("A blocked import plan cannot be activated.");
  }
  await assertExecutablePlan(plan);

  const startedAt = clock();
  const initialRequest = { ...actor, checkedAt: startedAt };
  await repository.cleanupAuthorizedExpiredAssets(initialRequest);
  const manifest = await repository.createAuthorizedAssetManifest(
    initialRequest,
    new Date(startedAt.getTime() + knowledgeImportManifestLifetimeMilliseconds),
  );

  try {
    for (const asset of plan.assets) {
      const staged = await repository.stageAuthorizedAsset(
        { ...actor, checkedAt: clock() },
        manifest.id,
        {
          mediaType: asset.mediaType,
          content: asset.content,
        },
      );
      if (staged.hash !== asset.hash) {
        throw new ImportExecutionError(
          `The staged asset hash for ${asset.sourcePaths[0] ?? "an imported image"} changed.`,
        );
      }
    }

    const categories = plan.categories.map((category) => ({
      id: `category_${createId()}`,
      name: category.name,
      slug: category.slug,
      description: null,
      position: category.position,
    }));
    const categoryIds = new Map(
      plan.categories.map((category, index) => [category.slug, categories[index].id]),
    );
    const articles: KnowledgeImportArticle[] = [];
    for (const article of plan.articles) {
      const categoryId = categoryIds.get(article.categorySlug);
      if (!categoryId) {
        throw new ImportExecutionError(
          `Article ${article.sourcePath} has no planned category.`,
        );
      }

      const id = `article_${createId()}`;
      const revisionId = `revision_${createId()}`;
      const savedArticle = {
        id,
        revisionId,
        categoryId,
        categorySlug: article.categorySlug,
        categoryName: categories.find((category) => category.id === categoryId)!.name,
        slug: article.slug,
        title: article.title,
        mdx: article.mdx,
        isFaq: article.isFaq,
        authorName: article.authorName,
        position: article.position,
        assetHashes: article.assetHashes,
        changeSummary: `Imported from ${article.sourcePath}`.slice(0, 500),
      };
      articles.push({
        ...savedArticle,
        revisionHash: await articleRevisionHash({
          workspaceId: actor.workspaceId,
          articleId: savedArticle.id,
          categoryId: savedArticle.categoryId,
          categorySlug: savedArticle.categorySlug,
          categoryName: savedArticle.categoryName,
          slug: savedArticle.slug,
          title: savedArticle.title,
          mdx: savedArticle.mdx,
          isFaq: savedArticle.isFaq,
          authorName: savedArticle.authorName,
          position: savedArticle.position,
          assetHashes: savedArticle.assetHashes,
        }),
      });
    }

    const result = await repository.activateKnowledgeImport({
      actor,
      manifestId: manifest.id,
      categories,
      articles,
    });
    if (result.status === "conflict") {
      throw new ImportExecutionConflictError(result.code);
    }
  } catch (error) {
    const failure = normalizeAuthoringError(error);
    if (failure instanceof AuthoringPausedError) throw failure;
    try {
      await repository.discardAuthorizedAssetManifest(
        { ...actor, checkedAt: clock() },
        manifest.id,
      );
    } catch (cleanupError) {
      throw normalizeAuthoringError(
        new AggregateError(
          [error, cleanupError],
          "The knowledge import and staged asset cleanup both failed.",
        ),
      );
    }
    throw error;
  }
}
