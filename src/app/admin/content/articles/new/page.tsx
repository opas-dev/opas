// ABOUTME: Starts a safe draft article in the authenticated OPAS content editor.
// ABOUTME: Derives the available category choices from the trusted demo workspace.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ArticleEditor } from "@/app/admin/content/article-editor";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "New article",
  description: "Author a new OPAS help-center article.",
};

export default async function NewArticlePage() {
  const admin = await requireMemberCapability("draft:edit", demoIds.workspace);
  const categories = await (await getRepository()).listCategories(demoIds.workspace);

  if (categories.length === 0) {
    redirect("/admin/content");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={admin} active="content" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <Link href="/admin/content" className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
          ← Back to content
        </Link>
        <div className="mb-10 mt-6 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">New answer</p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            Write the shortest useful answer.
          </h1>
        </div>
        <ArticleEditor
          categories={categories.map(({ id, name }) => ({ id, name }))}
          article={{
            categoryId: categories[0].id,
            title: "Untitled article",
            slug: "",
            mdx: "# Untitled article\n\nWrite a clear answer here.",
            status: "draft",
            isFaq: false,
            authorName: "OPAS",
          }}
        />
      </div>
    </main>
  );
}
