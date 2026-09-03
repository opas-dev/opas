// ABOUTME: Loads one workspace-scoped article into the authenticated content editor.
// ABOUTME: Returns a real not-found response when the supplied record id is unavailable.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleEditor } from "@/app/admin/content/article-editor";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
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
  const [article, categories] = await Promise.all([
    repository.getArticle(demoIds.workspace, id),
    repository.listCategories(demoIds.workspace),
  ]);

  if (!article) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <Link href="/admin/content" className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
          ← Back to content
        </Link>
        <div className="mb-10 mt-6 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">
            {article.status === "published" ? "Published answer" : "Private draft"}
          </p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            Edit {article.title}
          </h1>
        </div>
        <ArticleEditor
          categories={categories.map(({ id: categoryId, name }) => ({ id: categoryId, name }))}
          article={{
            id: article.id,
            categoryId: article.categoryId,
            title: article.title,
            slug: article.slug,
            mdx: article.mdx,
            status: article.status,
            isFaq: article.isFaq,
            authorName: article.authorName,
          }}
        />
      </div>
    </main>
  );
}
