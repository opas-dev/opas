// ABOUTME: Loads one authorized working revision into the authenticated content editor.
// ABOUTME: Keeps private authoring, exact preview, and live publication state visibly separate.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleEditor } from "@/app/admin/content/article-editor";
import { ArticlePreviewManagement } from "@/app/admin/content/article-preview-management";
import {
  archiveArticleAction,
  restoreArchivedArticleAction,
} from "@/app/admin/content/article-recovery-actions";
import { ArticleLifecycleControls } from "@/app/admin/content/article-recovery-controls";
import {
  approveAndPublishArticleRevisionAction,
  approveArticleRevisionAction,
  emergencyPublishArticleAction,
  publishArticleRevisionAction,
  requestArticleChangesAction,
  submitArticleForReviewAction,
  unpublishArticleAction,
  withdrawArticleReviewAction,
} from "@/app/admin/content/actions";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { hasCapability } from "@/auth/capabilities";
import { getRepository } from "@/db";
import { getCategoryAuthoringRepository } from "@/db/category-authoring-database";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Edit article",
  description: "Edit an OPAS help-center article.",
};

export default async function EditArticlePage({ params }: PageProps<"/admin/content/articles/[id]">) {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const { id } = await params;
  const repository = await getRepository();
  const categoryRepository = await getCategoryAuthoringRepository();
  const [head, categories] = await Promise.all([
    repository.getArticleWorkingHead({
      actor: { memberId: admin.memberId, sessionId: admin.sessionId },
      articleId: id,
      workspaceId: demoIds.workspace,
    }),
    categoryRepository.listCategories(demoIds.workspace),
  ]);

  if (!head) {
    notFound();
  }

  const archived = head.archivedAt !== null;
  const canEdit = hasCapability(admin.role, "draft:edit") && !archived;
  const canSubmit = hasCapability(admin.role, "review:submit") && !archived;
  const canReviewIndependently =
    hasCapability(admin.role, "review:decide") &&
    head.createdByMemberId !== admin.memberId &&
    head.submittedByMemberId !== admin.memberId &&
    !archived;
  const canPublish = hasCapability(admin.role, "publication:publish") && !archived;
  const canManagePreview = hasCapability(admin.role, "preview:manage") && !archived;
  const lifecycle = (
    <ArticleLifecycleControls
      archiveAction={archiveArticleAction}
      canArchive={hasCapability(admin.role, "article:retire") && !archived}
      canRestoreArchived={hasCapability(admin.role, "revision:restore") && archived}
      isArchived={archived}
      restoreArchivedAction={restoreArchivedArticleAction}
      snapshot={{
        articleId: head.article.id,
        publicStatus: head.publicStatus,
        reviewState: head.reviewState,
        revisionId: head.revisionId,
        revisionNumber: head.revisionNumber,
      }}
    />
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <Link href="/admin/content" className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
          ← Content library
        </Link>
        <div className="mb-10 mt-6 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">
            {archived
              ? "Archived answer"
              : `Working revision ${head.revisionNumber}`}
          </p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            {archived ? "Archived" : canEdit ? "Edit" : "Review"} {head.article.title}
          </h1>
        </div>
        <nav aria-label="Article sections" className="mb-8 flex border-b border-border">
          <Link
            aria-current="page"
            className="min-h-11 border-b-2 border-primary px-3 py-2 text-sm font-semibold text-foreground no-underline"
            href={`/admin/content/articles/${head.article.id}`}
          >
            Article
          </Link>
          <Link
            className="min-h-11 px-3 py-2 text-sm font-semibold text-muted no-underline hover:text-foreground"
            href={`/admin/content/articles/${head.article.id}/history`}
          >
            History
          </Link>
        </nav>
        {archived ? <div className="mb-8">{lifecycle}</div> : null}
        <ArticleEditor
          canEdit={canEdit}
          categories={categories.map(({ id: categoryId, name }) => ({ id: categoryId, name }))}
          article={{
            id: head.article.id,
            categoryId: head.article.categoryId,
            title: head.article.title,
            slug: head.article.slug,
            mdx: head.article.mdx,
            isFaq: head.article.isFaq,
            authorName: head.article.authorName,
          }}
          isArchived={archived}
          workflow={{
            articleId: head.article.id,
            publicStatus: head.publicStatus,
            publishedRevisionNumber: head.publishedRevisionNumber,
            reviewState: head.reviewState,
            revisionId: head.revisionId,
            revisionNumber: head.revisionNumber,
          }}
          workflowActions={{
            approve: approveArticleRevisionAction,
            approveAndPublish: approveAndPublishArticleRevisionAction,
            emergencyPublish: emergencyPublishArticleAction,
            publish: publishArticleRevisionAction,
            requestChanges: requestArticleChangesAction,
            submit: submitArticleForReviewAction,
            unpublish: unpublishArticleAction,
            withdraw: withdrawArticleReviewAction,
          }}
          workflowPermissions={{
            canEmergencyPublish:
              hasCapability(admin.role, "publication:emergency-publish") && !archived,
            canPublish,
            canReview: canReviewIndependently,
            canSubmit,
            canUnpublish: hasCapability(admin.role, "article:retire") && !archived,
            canWithdraw:
              canSubmit && head.submittedByMemberId === admin.memberId,
          }}
        />
        {canManagePreview ? (
          <div className="mt-8">
            <ArticlePreviewManagement
              revisionId={head.revisionId}
              revisionNumber={head.revisionNumber}
            />
          </div>
        ) : null}
        {!archived ? <div className="mt-12">{lifecycle}</div> : null}
      </div>
    </main>
  );
}
