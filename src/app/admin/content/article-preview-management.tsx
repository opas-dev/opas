// ABOUTME: Connects the signed-preview controls to capability-checked Server Actions.
// ABOUTME: Gives article pages one isolated integration point for exact saved revisions.

import {
  createArticlePreviewAction,
  readArticlePreviewStatusAction,
  revokeArticlePreviewAction,
} from "@/app/admin/content/article-preview-actions";
import { ArticlePreviewControls } from "@/app/admin/content/article-preview-controls";

export async function ArticlePreviewManagement(
  props: Readonly<{ revisionId: string; revisionNumber: number }>,
) {
  const formData = new FormData();
  formData.set("revisionId", props.revisionId);
  const initialStatus = await readArticlePreviewStatusAction(formData);

  return (
    <ArticlePreviewControls
      {...props}
      createPreview={createArticlePreviewAction}
      initialStatus={initialStatus}
      revokePreview={revokeArticlePreviewAction}
    />
  );
}
