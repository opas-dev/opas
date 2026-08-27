// ABOUTME: Proves that OPAS can compile database-backed MDX during a live request.
// ABOUTME: Reads the seeded public article through the selected deployment database.
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { RuntimeMdx } from "@/content/runtime-mdx";
import { findPublishedArticle } from "@/db/articles";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export default async function RuntimeMdxPage() {
  await connection();

  const article = await findPublishedArticle(demoIds.workspace, "runtime-mdx");

  if (!article) {
    notFound();
  }

  return (
    <main className="article-shell">
      <nav className="article-nav" aria-label="Breadcrumb">
        <Link href="/">OPAS</Link>
        <span aria-hidden="true">/</span>
        <span>Runtime spike</span>
      </nav>
      <article className="article-content">
        <RuntimeMdx source={article.mdx} />
      </article>
    </main>
  );
}
