// ABOUTME: Returns the small classic script that mounts the isolated OPAS assistant iframe.
// ABOUTME: Keeps configuration in the script origin and prevents MIME sniffing or stale variants.
import { embedLoaderScript } from "@/embed/loader";

export const runtime = "nodejs";

export function GET() {
  return new Response(embedLoaderScript, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
