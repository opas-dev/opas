// ABOUTME: Defines the task-oriented article-library filters and row guidance.
// ABOUTME: Keeps working, live, and archived states distinct for every team role.

import type { TeamRole } from "@/auth/capabilities";
import { hasCapability } from "@/auth/capabilities";
import type { ArticleLibraryItem } from "@/db/article-drafts";

export const articleLibraryFilters = [
  { id: "needs-review", label: "Needs review" },
  { id: "drafts", label: "Drafts" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" },
] as const;

export type ArticleLibraryFilter = (typeof articleLibraryFilters)[number]["id"];

export function resolveArticleLibraryFilter(
  value: string | string[] | undefined,
  role: TeamRole,
): ArticleLibraryFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (articleLibraryFilters.some((filter) => filter.id === candidate)) {
    return candidate as ArticleLibraryFilter;
  }
  return role === "reviewer" ? "needs-review" : "drafts";
}

export function articleMatchesLibraryFilter(
  article: ArticleLibraryItem,
  filter: ArticleLibraryFilter,
) {
  if (filter === "archived") return article.archivedAt !== null;
  if (article.archivedAt !== null) return false;
  if (filter === "needs-review") return article.reviewState === "in_review";
  if (filter === "published") return article.publicStatus === "published";
  return (
    article.publicStatus === "draft" ||
    article.publishedRevisionNumber !== article.workingRevisionNumber ||
    article.reviewState !== "published"
  );
}

export function articleLibraryCounts(items: readonly ArticleLibraryItem[]) {
  return Object.fromEntries(
    articleLibraryFilters.map(({ id }) => [
      id,
      items.filter((item) => articleMatchesLibraryFilter(item, id)).length,
    ]),
  ) as Record<ArticleLibraryFilter, number>;
}

export function articleNextAction(
  article: ArticleLibraryItem,
  member: Readonly<{ memberId: string; role: TeamRole }>,
) {
  if (article.archivedAt) {
    return hasCapability(member.role, "revision:restore")
      ? "Restore private draft"
      : "Waiting for an editor";
  }
  if (article.reviewState === "in_review") {
    const canReviewIndependently =
      hasCapability(member.role, "review:decide") &&
      article.createdByMemberId !== member.memberId &&
      article.submittedByMemberId !== member.memberId;
    return canReviewIndependently
      ? `Review revision ${article.workingRevisionNumber}`
      : "Waiting for another reviewer";
  }
  if (article.reviewState === "approved") {
    return hasCapability(member.role, "publication:publish")
      ? `Publish revision ${article.workingRevisionNumber}`
      : "Ready for publishing";
  }
  if (article.reviewState === "published") return "No action needed";
  return hasCapability(member.role, "draft:edit")
    ? "Continue editing"
    : "Waiting for an editor";
}

export function articleWorkingStateLabel(article: ArticleLibraryItem) {
  return {
    approved: "Approved",
    changes_requested: "Changes requested",
    editing: "Editing",
    in_review: "In review",
    published: "Published",
  }[article.reviewState];
}
