// ABOUTME: Lists published articles for one public help-center category.
// ABOUTME: Resolves the category at request time and never includes private drafts.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PublicHeader } from "@/app/public-header";
import { loadPublicPageContent } from "@/app/publication-data";
import { Search } from "@/app/search";
import { categoryMetadata } from "@/content/publication";
import { publicSiteIdentity } from "@/site";

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
  const identity = publicSiteIdentity();

  return (
    <>
      <PublicHeader />
      <main id="main-content">
        <div className="public-section">
          <nav className="article-nav" aria-label="Breadcrumb">
            <Link href="/">{identity.productName}</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{category.name}</span>
          </nav>
          <div className="category-hero">
            <header className="category-heading">
              <p>
                {categoryArticles.length}{" "}
                {categoryArticles.length === 1 ? "published guide" : "published guides"}
              </p>
              <h1>{category.name}</h1>
              {category.description ? <p>{category.description}</p> : null}
            </header>
            <Search
              suggestedQuestions={categoryArticles.slice(0, 3).map(
                ({ article }) =>
                  article.title.endsWith("?")
                    ? article.title
                    : `What should I know about “${article.title}”?`,
              )}
            />
          </div>

          {categoryArticles.length > 0 ? (
            <section className="category-articles" aria-labelledby="category-articles-heading">
              <div className="section-heading">
                <h2 id="category-articles-heading">Guides in this topic</h2>
                <p>Choose a guide or ask above.</p>
              </div>
              <ul className="public-article-list">
                {categoryArticles.map((publication) => (
                  <li key={publication.article.id}>
                    <Link href={publication.path}>
                      <span>{publication.article.title}</span>
                      <span aria-hidden="true">↗</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="empty-library">No answers are published in this category yet.</p>
          )}
        </div>
      </main>
    </>
  );
}
