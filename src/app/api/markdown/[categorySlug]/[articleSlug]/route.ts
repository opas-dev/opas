// ABOUTME: Serves one published article as its canonical database-stored Markdown document.
// ABOUTME: Revalidates the workspace, category, publication state, and both public slugs.
import { loadPublicationContent } from "@/content/publication-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/markdown/[categorySlug]/[articleSlug]">,
) {
  const { categorySlug, articleSlug } = await params;
  const { publications } = await loadPublicationContent();
  const publication = publications.find(
    (candidate) =>
      candidate.category.slug === categorySlug &&
      candidate.article.slug === articleSlug,
  );

  if (!publication) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(publication.markdown, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
