// ABOUTME: Renders one sanitized published article with metadata and structured data.
// ABOUTME: Verifies both category and article slugs before exposing content to readers.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PublicHeader } from "@/app/public-header";
import { loadPublicPageContent } from "@/app/publication-data";
import {
  articleJsonLd,
  articleMetadata,
  faqJsonLd,
  serializeJsonLd,
} from "@/content/publication";
import { RuntimeMdx } from "@/content/runtime-mdx";

export const runtime = "nodejs";

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

async function findPublication(categorySlug: string, articleSlug: string) {
  const { publications } = await loadPublicPageContent();
  return publications.find(
    (candidate) =>
      candidate.category.slug === categorySlug &&
      candidate.article.slug === articleSlug,
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/[categorySlug]/[articleSlug]">): Promise<Metadata> {
  const { categorySlug, articleSlug } = await params;
  const publication = await findPublication(categorySlug, articleSlug);

  if (!publication) {
    notFound();
  }

  return articleMetadata(publication);
}

export default async function ArticlePage({
  params,
}: PageProps<"/[categorySlug]/[articleSlug]">) {
  const { categorySlug, articleSlug } = await params;
  const publication = await findPublication(categorySlug, articleSlug);

  if (!publication) {
    notFound();
  }

  const { article, category } = publication;
  const faqData = faqJsonLd(publication);

  return (
    <main>
      <script
        id="opas-article-jsonld"
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(articleJsonLd(publication)),
        }}
      />
      {faqData ? (
        <script
          id="opas-faq-jsonld"
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqData) }}
        />
      ) : null}
      <PublicHeader />
      <div className="article-shell">
        <nav className="article-nav" aria-label="Breadcrumb">
          <Link href="/">OPAS</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/${category.slug}`}>{category.name}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{article.title}</span>
        </nav>
        <article className="article-content">
          <RuntimeMdx source={article.mdx} />
          <footer className="article-meta">
            <span>Written by {article.authorName}</span>
            <time dateTime={article.updatedAt.toISOString()}>
              Last updated {dateFormatter.format(article.updatedAt)}
            </time>
          </footer>
        </article>
      </div>
    </main>
  );
}
