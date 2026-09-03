// ABOUTME: Serves workspace image assets at immutable content-addressed public URLs.
// ABOUTME: Validates exact SHA-256 paths and preserves each trusted stored media type.
import { isAssetHash } from "@/assets/identity";
import { publishedAssetResponse } from "@/assets/responses";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/assets/[hash]">,
) {
  const { hash } = await params;
  if (!isAssetHash(hash)) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const asset = await (await getRepository()).getPublishedAsset(demoIds.workspace, hash);
  if (!asset) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return publishedAssetResponse(request, asset);
}
