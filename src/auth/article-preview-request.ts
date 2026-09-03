// ABOUTME: Resolves server-only configuration and persistence for preview HTTP routes.
// ABOUTME: Keeps the portable request boundary free of deployment and database imports.
import "server-only";

import { getArticlePreviewRepository } from "@/auth/article-preview-database";
import type { ArticlePreviewHttpDependencies } from "@/auth/article-preview-http";
import { getArticlePreviewConfiguration } from "@/auth/preview-config";
import { resolveSiteOrigin } from "@/site";

export async function getArticlePreviewHttpDependencies(): Promise<ArticlePreviewHttpDependencies> {
  return {
    configuration: getArticlePreviewConfiguration(),
    repository: await getArticlePreviewRepository(),
    siteOrigin: resolveSiteOrigin(),
  };
}
