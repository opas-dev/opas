// ABOUTME: Initializes evidence for a bounded set of published articles missing an indexed revision.
// ABOUTME: Prepares provider-independent chunks and lets the repository reject stale snapshots atomically.
import { prepareArticleEvidence } from "@/content/article-evidence";
import { articleEvidenceInitializationMaximumCount } from "@/db/evidence";
import type { Repository } from "@/db/repository";

export type ArticleEvidenceInitializationRepository = Pick<
  Repository,
  "initializeArticleEvidence" | "listUnindexedPublishedArticles"
>;

type ArticleEvidenceInitializationOptions = {
  configuredSiteUrl?: string;
  createId?: () => string;
  initializedAt?: Date;
  limit?: number;
  repository: ArticleEvidenceInitializationRepository;
  workspaceId: string;
};

type CompleteArticleEvidenceInitializationOptions = Omit<
  ArticleEvidenceInitializationOptions,
  "limit"
> & {
  maximumBatches?: number;
};

export type ArticleEvidenceInitializationSummary = {
  examinedArticleCount: number;
  initializedArticleCount: number;
};

export async function initializeMissingArticleEvidence({
  configuredSiteUrl,
  createId,
  initializedAt = new Date(),
  limit = articleEvidenceInitializationMaximumCount,
  repository,
  workspaceId,
}: ArticleEvidenceInitializationOptions): Promise<ArticleEvidenceInitializationSummary> {
  const articles = await repository.listUnindexedPublishedArticles(
    workspaceId,
    limit,
  );
  let initializedArticleCount = 0;

  for (const article of articles) {
    const evidence = await prepareArticleEvidence(article, article.categorySlug, {
      availableAt: initializedAt,
      ...(configuredSiteUrl === undefined ? {} : { configuredSiteUrl }),
      ...(createId === undefined ? {} : { createId }),
    });
    if (!evidence) {
      continue;
    }
    if (
      await repository.initializeArticleEvidence({
        article,
        evidence,
        initializedAt,
      })
    ) {
      initializedArticleCount += 1;
    }
  }

  return {
    examinedArticleCount: articles.length,
    initializedArticleCount,
  };
}

export async function initializeAllMissingArticleEvidence({
  maximumBatches = 100,
  ...options
}: CompleteArticleEvidenceInitializationOptions): Promise<ArticleEvidenceInitializationSummary> {
  if (!Number.isInteger(maximumBatches) || maximumBatches < 1 || maximumBatches > 100) {
    throw new Error("Evidence initialization batch limit is invalid");
  }
  let examinedArticleCount = 0;
  let initializedArticleCount = 0;

  for (let batch = 0; batch < maximumBatches; batch += 1) {
    const result = await initializeMissingArticleEvidence(options);
    examinedArticleCount += result.examinedArticleCount;
    initializedArticleCount += result.initializedArticleCount;
    if (
      result.examinedArticleCount < articleEvidenceInitializationMaximumCount ||
      result.initializedArticleCount === 0
    ) {
      break;
    }
  }

  return { examinedArticleCount, initializedArticleCount };
}
