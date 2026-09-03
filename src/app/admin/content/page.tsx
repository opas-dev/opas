// ABOUTME: Lists the demo workspace categories and articles for authenticated administrators.
// ABOUTME: Connects category management and article authoring without exposing workspace identity.
import type { Metadata } from "next";
import Link from "next/link";

import { CategoryEditor } from "@/app/admin/content/category-editor";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
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

export default async function ContentAdminPage() {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const repository = await getRepository();
  const categoryRepository = await getCategoryAuthoringRepository();
  const [categories, articles] = await Promise.all([
    categoryRepository.listCategories(demoIds.workspace),
    repository.listArticles(demoIds.workspace),
  ]);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const articleCounts = articles.reduce<Map<string, number>>((counts, article) => {
    counts.set(article.categoryId, (counts.get(article.categoryId) ?? 0) + 1);
    return counts;
  }, new Map());

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-8 sm:flex-row sm:items-end">
          <div className="max-w-3xl">
            <p className="m-0 text-sm font-semibold text-primary">Content library</p>
            <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
              Publish clear answers without rebuilding.
            </h1>
            <p className="mb-0 mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">
              Keep the public hierarchy shallow: categories first, then focused articles. Drafts
              remain private until you publish them.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/admin/content/import"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground no-underline"
            >
              Import knowledge
            </Link>
            {categories.length > 0 ? (
              <Link
                href="/admin/content/articles/new"
                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground no-underline"
              >
                New article
              </Link>
            ) : null}
          </div>
        </div>

        <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-start">
          <section aria-labelledby="categories-heading">
            <div className="mb-5">
              <h2 id="categories-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                Categories
              </h2>
              <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                Position controls the order readers see on the home page.
              </p>
            </div>
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
          </section>

          <section aria-labelledby="articles-heading">
            <div className="mb-5 flex items-end justify-between gap-4">
              <div>
                <h2 id="articles-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                  Articles
                </h2>
                <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                  {articles.length} {articles.length === 1 ? "answer" : "answers"} in this workspace.
                </p>
              </div>
            </div>

            {articles.length > 0 ? (
              <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border bg-surface p-0">
                {articles.map((article) => {
                  const category = categoriesById.get(article.categoryId);
                  const publicHref =
                    article.status === "published" && category
                      ? `/${category.slug}/${article.slug}`
                      : null;

                  return (
                    <li key={article.id} className="p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                article.status === "published"
                                  ? "bg-success text-success-foreground"
                                  : "bg-surface-strong text-muted"
                              }`}
                            >
                              {article.status === "published" ? "Published" : "Draft"}
                            </span>
                            <span className="text-xs text-muted">{category?.name ?? "Unknown category"}</span>
                          </div>
                          <h3 className="mb-0 mt-2 text-lg font-semibold tracking-[-0.01em]">
                            <Link
                              href={`/admin/content/articles/${article.id}`}
                              className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                            >
                              {article.title}
                            </Link>
                          </h3>
                          <p className="mb-0 mt-2 text-xs text-muted">
                            Updated {dateFormatter.format(article.updatedAt)} · /{article.slug}
                          </p>
                        </div>
                        {publicHref ? (
                          <Link
                            href={publicHref}
                            className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-muted no-underline hover:border-border-strong hover:text-foreground"
                          >
                            View live
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-border-strong bg-surface p-6">
                <p className="m-0 font-semibold">No articles yet</p>
                <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                  {categories.length > 0
                    ? "Create the first draft, preview it, then publish when it is ready."
                    : "Create a category first, then add its first article."}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
