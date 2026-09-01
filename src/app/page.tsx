// ABOUTME: Presents the published OPAS category and article library to public readers.
// ABOUTME: Keeps the help-center hierarchy shallow and excludes every draft record.
import type { Metadata } from "next";
import Link from "next/link";

import { PublicHeader } from "@/app/public-header";
import { loadPublicPageContent } from "@/app/publication-data";
import { Search } from "@/app/search";
import { homeMetadata } from "@/content/publication";
import { publicSiteIdentity } from "@/site";

export const runtime = "nodejs";

export function generateMetadata(): Metadata {
  return homeMetadata();
}

export default async function HomePage() {
  const { categories, publications } = await loadPublicPageContent();
  const identity = publicSiteIdentity();

  return (
    <main>
      <PublicHeader />

      <section className="hero" aria-labelledby="hero-heading">
        <p className="hero-context">{identity.heroContext}</p>
        <h1 id="hero-heading">{identity.heroHeading}</h1>
        <p className="hero-copy">{identity.heroCopy}</p>
        <Search
          suggestedQuestions={publications.slice(0, 3).map(
            ({ article }) =>
              article.title.endsWith("?")
                ? article.title
                : `What should I know about “${article.title}”?`,
          )}
        />
      </section>

      <section className="launch-points" aria-labelledby="categories-heading">
        <div className="section-heading">
          <h2 id="categories-heading">Browse by category</h2>
          <p>
            {publications.length} published{" "}
            {publications.length === 1 ? "answer" : "answers"}
          </p>
        </div>
        {categories.length > 0 ? (
          <ol>
            {categories.map((category, index) => {
              const categoryArticles = publications.filter(
                (publication) => publication.category.id === category.id,
              );

              return (
                <li key={category.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>
                      <Link href={`/${category.slug}`}>{category.name}</Link>
                    </h3>
                    <p>{category.description ?? "Help articles in this category."}</p>
                    <p className="category-count">
                      {categoryArticles.length}{" "}
                      {categoryArticles.length === 1 ? "article" : "articles"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="empty-library">No categories have been published yet.</p>
        )}
      </section>
    </main>
  );
}
