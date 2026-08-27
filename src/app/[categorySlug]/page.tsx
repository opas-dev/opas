// ABOUTME: Lists published articles for one public help-center category.
// ABOUTME: Resolves the category at request time and never includes private drafts.
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PublicHeader } from "@/app/public-header";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export default async function CategoryPage({ params }: PageProps<"/[categorySlug]">) {
  const { categorySlug } = await params;
  await connection();
  const repository = await getRepository();
  const [categories, articles] = await Promise.all([
    repository.listCategories(demoIds.workspace),
    repository.listPublishedArticles(demoIds.workspace),
  ]);
  const category = categories.find((candidate) => candidate.slug === categorySlug);

  if (!category) {
    notFound();
  }

  const categoryArticles = articles.filter((article) => article.categoryId === category.id);

  return (
    <main>
      <PublicHeader />
      <div className="public-section">
        <nav className="article-nav" aria-label="Breadcrumb">
          <Link href="/">OPAS</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{category.name}</span>
        </nav>
        <header className="category-heading">
          <p>{String(category.position + 1).padStart(2, "0")} · Category</p>
          <h1>{category.name}</h1>
          {category.description ? <p>{category.description}</p> : null}
        </header>

        {categoryArticles.length > 0 ? (
          <ul className="public-article-list">
            {categoryArticles.map((article) => (
              <li key={article.id}>
                <Link href={`/${category.slug}/${article.slug}`}>
                  <span>{article.title}</span>
                  <span aria-hidden="true">→</span>
                </Link>
                <p>
                  <time dateTime={article.updatedAt.toISOString()}>
                    Updated {article.updatedAt.toISOString().slice(0, 10)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-library">No answers are published in this category yet.</p>
        )}
      </div>
    </main>
  );
}
