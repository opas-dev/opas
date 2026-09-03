// ABOUTME: Presents the authorized article library as separate working and live states.
// ABOUTME: Keeps review, draft, published, and archived work easy to find by task.
import type { Metadata } from "next";
import Link from "next/link";

import {
  articleLibraryCounts,
  articleLibraryFilters,
  articleMatchesLibraryFilter,
  articleNextAction,
  articleWorkingStateLabel,
  resolveArticleLibraryFilter,
  type ArticleLibraryFilter,
} from "@/app/admin/content/article-library";
import { CategoryEditor } from "@/app/admin/content/category-editor";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { hasCapability } from "@/auth/capabilities";
import { getRepository } from "@/db";
import { getCategoryAuthoringRepository } from "@/db/category-authoring-database";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Content",
  description: "Manage OPAS help-center categories and articles.",
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const filterEmptyCopy: Record<ArticleLibraryFilter, readonly [string, string]> = {
  archived: [
    "Nothing archived",
    "Archived answers stay here with their full history until someone restores them.",
  ],
  drafts: [
    "No private work waiting",
    "Create an article or import existing knowledge. Nothing appears publicly until it is published.",
  ],
  "needs-review": [
    "No reviews waiting",
    "Submitted revisions appear here. Published answers and private drafts are unchanged.",
  ],
  published: [
    "Nothing published yet",
    "Approved revisions appear here after a publisher makes them live.",
  ],
};

export default async function ContentAdminPage({
  searchParams,
}: PageProps<"/admin/content">) {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const repository = await getRepository();
  const categoryRepository = await getCategoryAuthoringRepository();
  const [categories, library, query] = await Promise.all([
    categoryRepository.listCategories(demoIds.workspace),
    repository.listArticleLibrary({
      actor: { memberId: admin.memberId, sessionId: admin.sessionId },
      workspaceId: demoIds.workspace,
    }),
    searchParams,
  ]);
  const activeFilter = resolveArticleLibraryFilter(query.view, admin.role);
  const counts = articleLibraryCounts(library);
  const articles = library.filter((article) =>
    articleMatchesLibraryFilter(article, activeFilter),
  );
  const articleCounts = library.reduce<Map<string, number>>((totals, article) => {
    totals.set(article.categoryId, (totals.get(article.categoryId) ?? 0) + 1);
    return totals;
  }, new Map());
  const canCreate = hasCapability(admin.role, "draft:edit");
  const canImport = hasCapability(admin.role, "import:run");
  const canManageCategories = hasCapability(admin.role, "category:manage");
  const [emptyTitle, emptyDescription] = filterEmptyCopy[activeFilter];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-7 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <p className="m-0 text-sm font-semibold text-primary">Content library</p>
            <h1 className="mb-0 mt-2 text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl">
              What needs your attention?
            </h1>
            <p className="mb-0 mt-3 text-base leading-7 text-muted text-pretty">
              Working revisions stay private. The live revision changes only after an explicit
              publish action.
            </p>
          </div>
          {canCreate || canImport ? (
            <div className="flex flex-wrap gap-2">
              {canImport ? (
                <Link
                  href="/admin/content/import"
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-semibold text-foreground no-underline"
                >
                  Import
                </Link>
              ) : null}
              {canCreate && categories.length > 0 ? (
                <Link
                  href="/admin/content/articles/new"
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground no-underline"
                >
                  New article
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>

        <nav aria-label="Filter articles" className="mt-7 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {articleLibraryFilters.map((filter) => {
            const active = filter.id === activeFilter;
            return (
              <Link
                key={filter.id}
                aria-current={active ? "page" : undefined}
                href={`/admin/content?view=${filter.id}`}
                className={`flex min-h-12 items-center justify-between gap-2 rounded-md border px-3 text-sm font-semibold no-underline sm:px-4 ${
                  active
                    ? "border-primary bg-secondary text-secondary-foreground"
                    : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground"
                }`}
              >
                <span>{filter.label}</span>
                <span className="tabular-nums" aria-label={`${counts[filter.id]} articles`}>
                  {counts[filter.id]}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-8 grid gap-12 lg:grid-cols-[minmax(0,1.45fr)_minmax(17rem,0.55fr)] lg:items-start">
          <section aria-labelledby="articles-heading" className="min-w-0">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 id="articles-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                  {articleLibraryFilters.find(({ id }) => id === activeFilter)!.label}
                </h2>
                <p className="mb-0 mt-1.5 text-sm leading-6 text-muted">
                  {articles.length} {articles.length === 1 ? "answer" : "answers"}
                </p>
              </div>
            </div>

            {articles.length > 0 ? (
              <ul className="m-0 list-none divide-y divide-border border-y border-border p-0">
                {articles.map((article) => {
                  const workingLabel = articleWorkingStateLabel(article);
                  const liveLabel =
                    article.publicStatus === "published" && article.publishedRevisionNumber
                      ? `Live revision ${article.publishedRevisionNumber}`
                      : "Not live";
                  const nextAction = articleNextAction(article, admin);
                  return (
                    <li key={article.articleId} className="py-5 first:pt-4 sm:py-6">
                      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="m-0 text-xs font-semibold text-muted">
                            {article.categoryName} <span aria-hidden="true">·</span>{" "}
                            <span className="font-mono font-normal">/{article.slug}</span>
                          </p>
                          <h3 className="mb-0 mt-2 text-lg font-semibold tracking-[-0.015em] text-balance">
                            <Link
                              href={`/admin/content/articles/${article.articleId}`}
                              className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                            >
                              {article.title}
                            </Link>
                          </h3>
                          <dl className="mb-0 mt-4 grid gap-3 text-sm sm:max-w-xl sm:grid-cols-2">
                            <div>
                              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                                Working
                              </dt>
                              <dd className="m-0 mt-1 font-medium">
                                Revision {article.workingRevisionNumber} · {workingLabel}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                                Public
                              </dt>
                              <dd className="m-0 mt-1 font-medium">{liveLabel}</dd>
                            </div>
                          </dl>
                          <p className="mb-0 mt-3 text-xs text-muted">
                            Updated {dateFormatter.format(article.updatedAt)}
                            {article.archivedAt
                              ? ` · Archived ${dateFormatter.format(article.archivedAt)}`
                              : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-row items-center justify-between gap-3 sm:flex-col sm:items-end">
                          <span className="text-xs font-semibold text-muted">{nextAction}</span>
                          <Link
                            href={`/admin/content/articles/${article.articleId}`}
                            className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-semibold text-foreground no-underline"
                          >
                            Open
                          </Link>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="border-y border-dashed border-border-strong py-8">
                <p className="m-0 font-semibold">{emptyTitle}</p>
                <p className="mb-0 mt-2 max-w-xl text-sm leading-6 text-muted">
                  {emptyDescription}
                </p>
              </div>
            )}
          </section>

          <aside aria-labelledby="categories-heading" className="lg:border-l lg:border-border lg:pl-8">
            <div className="mb-5">
              <h2 id="categories-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                Categories
              </h2>
              <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                {canManageCategories
                  ? "Order and group the paths readers browse."
                  : "The paths readers browse in the help center."}
              </p>
            </div>
            {canManageCategories ? (
              <div className="space-y-3">
                <CategoryEditor />
                {categories.map((category) => (
                  <CategoryEditor
                    key={category.id}
                    category={category}
                    articleCount={articleCounts.get(category.id) ?? 0}
                  />
                ))}
              </div>
            ) : categories.length > 0 ? (
              <ul className="m-0 list-none divide-y divide-border border-y border-border p-0">
                {categories.map((category) => (
                  <li key={category.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <span className="font-medium">{category.name}</span>
                    <span className="text-muted tabular-nums">
                      {articleCounts.get(category.id) ?? 0}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm leading-6 text-muted">No categories yet.</p>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
