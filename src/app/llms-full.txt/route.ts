// ABOUTME: Publishes the full public OPAS article corpus as one database-backed document.
// ABOUTME: Keeps draft and invalidly routed content outside the agent-readable surface.
import { loadPublicationContent } from "@/content/publication-data";
import { llmsFullText } from "@/content/publication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { publications } = await loadPublicationContent();

  return new Response(llmsFullText(publications), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
