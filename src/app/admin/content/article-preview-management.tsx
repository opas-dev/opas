// ABOUTME: Connects the signed-preview controls to capability-checked Server Actions.
// ABOUTME: Gives article pages one isolated integration point for exact saved revisions.

import {
  createArticlePreviewAction,
  revokeArticlePreviewAction,
} from "@/app/admin/content/article-preview-actions";
import { ArticlePreviewControls } from "@/app/admin/content/article-preview-controls";

export function ArticlePreviewManagement(
  props: Readonly<{ revisionId: string; revisionNumber: number }>,
) {
  return (
    <ArticlePreviewControls
      {...props}
      createPreview={createArticlePreviewAction}
      revokePreview={revokeArticlePreviewAction}
    />
  );
}
