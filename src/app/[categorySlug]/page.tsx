// ABOUTME: Lists published articles for one public help-center category.
// ABOUTME: Resolves the category at request time and never includes private drafts.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PublicHeader } from "@/app/public-header";
import { loadPublicPageContent } from "@/app/publication-data";
import { categoryMetadata } from "@/content/publication";

export const runtime = "nodejs";

export async function generateMetadata({
  params,
}: PageProps<"/[categorySlug]">): Promise<Metadata> {
  const { categorySlug } = await params;
  const { categories } = await loadPublicPageContent();
  const category = categories.find((candidate) => candidate.slug === categorySlug);

  if (!category) {
    notFound();
  }

  return categoryMetadata(category) ?? {};
}

export default async function CategoryPage({ params }: PageProps<"/[categorySlug]">) {
  const { categorySlug } = await params;
  const { categories, publications } = await loadPublicPageContent();
  const category = categories.find((candidate) => candidate.slug === categorySlug);

  if (!category) {
    notFound();
  }

  const categoryArticles = publications.filter(
    (publication) => publication.category.id === category.id,
  );

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
            {categoryArticles.map((publication) => (
              <li key={publication.article.id}>
                <Link href={publication.path}>
                  <span>{publication.article.title}</span>
                  <span aria-hidden="true">→</span>
                </Link>
                <p>
                  <time dateTime={publication.article.updatedAt.toISOString()}>
                    Updated {publication.article.updatedAt.toISOString().slice(0, 10)}
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
