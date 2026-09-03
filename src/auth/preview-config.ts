// ABOUTME: Reads the deployment-specific secret used only for signed article previews.
// ABOUTME: Keeps the preview key out of client bundles and administrator session signing.

import "server-only";

import {
  parseArticlePreviewEnvironment,
  type ArticlePreviewConfiguration,
} from "@/auth/preview-environment";

export type { ArticlePreviewConfiguration } from "@/auth/preview-environment";

export function getArticlePreviewConfiguration(): ArticlePreviewConfiguration {
  return parseArticlePreviewEnvironment(process.env);
}
