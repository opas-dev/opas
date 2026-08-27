// ABOUTME: Generates the public OPAS sitemap from the current database publication snapshot.
// ABOUTME: Includes the home page, safe category pages, and published article pages only.
import type { MetadataRoute } from "next";

import { loadPublicPageContent } from "@/app/publication-data";
import { absoluteSiteUrl, publicCategoryPath } from "@/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { categories, publications } = await loadPublicPageContent();
  const categoryEntries = categories.flatMap((category) => {
    const path = publicCategoryPath(category.slug);
    return path ? [{ url: absoluteSiteUrl(path) }] : [];
  });

  return [
    { url: absoluteSiteUrl("/") },
    ...categoryEntries,
    ...publications.map((publication) => ({
      url: absoluteSiteUrl(publication.path),
      lastModified: publication.article.updatedAt,
    })),
  ];
}
