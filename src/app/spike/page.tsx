// ABOUTME: Proves that OPAS can compile database-backed MDX during a live request.
// ABOUTME: Reads the seeded public article through the Postgres Drizzle repository.
import { createCompiler } from "@fumadocs/mdx-remote";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { demoIds } from "@/db/demo";
import { findPublishedArticle } from "@/db/postgres/articles";

export const runtime = "nodejs";

const compiler = createCompiler({
  preset: "minimal",
  outputFormat: "function-body",
});

export default async function RuntimeMdxPage() {
  await connection();

  const article = await findPublishedArticle(demoIds.workspace, "runtime-mdx");

  if (!article) {
    notFound();
  }

  const { body: MdxContent } = await compiler.compile({ source: article.mdx });

  return (
    <main className="article-shell">
      <nav className="article-nav" aria-label="Breadcrumb">
        <Link href="/">OPAS</Link>
        <span aria-hidden="true">/</span>
        <span>Runtime spike</span>
      </nav>
      <article className="article-content">
        <MdxContent />
      </article>
    </main>
  );
}
