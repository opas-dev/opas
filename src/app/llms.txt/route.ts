// ABOUTME: Publishes a compact database-backed index of OPAS help content for AI agents.
// ABOUTME: Emits stable absolute Markdown links grouped by their public categories.
import { loadPublicationContent } from "@/content/publication-data";
import { llmsText } from "@/content/publication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { publications } = await loadPublicationContent();

  return new Response(llmsText(publications), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
