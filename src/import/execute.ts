// ABOUTME: Stages one approved knowledge plan and activates all of its records atomically.
// ABOUTME: Maps planner output to repository records while cleaning every failed manifest.
import { prepareArticleEvidence } from "@/content/article-evidence";
import type { KnowledgeImportArticle, Repository } from "@/db/repository";
import type { KnowledgeImportPlan } from "@/import/planner";

type ImportRepository = Pick<
  Repository,
  | "activateKnowledgeImport"
  | "cleanupExpiredAssets"
  | "createAssetManifest"
  | "discardAssetManifest"
  | "stageAsset"
>;

type ImportExecutionOptions = {
  repository: ImportRepository;
  workspaceId: string;
  plan: KnowledgeImportPlan;
  now?: Date;
  createId?: () => string;
};

export class ImportExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportExecutionError";
  }
}

export const knowledgeImportManifestLifetimeMilliseconds = 60 * 60 * 1000;

export async function executeKnowledgeImport({
  repository,
  workspaceId,
  plan,
  now = new Date(),
  createId = () => crypto.randomUUID(),
}: ImportExecutionOptions) {
  if (!plan.ready) {
    throw new ImportExecutionError("A blocked import plan cannot be activated.");
  }

  await repository.cleanupExpiredAssets(workspaceId, now);
  const manifest = await repository.createAssetManifest(
    workspaceId,
    new Date(now.getTime() + knowledgeImportManifestLifetimeMilliseconds),
  );

  try {
    for (const asset of plan.assets) {
      const staged = await repository.stageAsset(workspaceId, manifest.id, {
        mediaType: asset.mediaType,
        content: asset.content,
      });
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

      const savedArticle = {
        id: `article_${createId()}`,
        categoryId,
        slug: article.slug,
        title: article.title,
        mdx: article.mdx,
        status: article.status,
        isFaq: article.isFaq,
        authorName: article.authorName,
        position: article.position,
        publishedAt: article.status === "published" ? now : null,
        assetHashes: article.assetHashes,
      };
      articles.push({
        ...savedArticle,
        evidence: await prepareArticleEvidence(
          { ...savedArticle, workspaceId },
          article.categorySlug,
          { availableAt: now, createId },
        ),
      });
    }

    await repository.activateKnowledgeImport({
      workspaceId,
      manifestId: manifest.id,
      categories,
      articles,
    });
  } catch (error) {
    try {
      await repository.discardAssetManifest(workspaceId, manifest.id);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The knowledge import and staged asset cleanup both failed.",
      );
    }
    throw error;
  }
}
