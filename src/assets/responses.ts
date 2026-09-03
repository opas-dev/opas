// ABOUTME: Builds byte-exact image responses from validated database asset records.
// ABOUTME: Shares ETag, MIME, and cache headers across public and authenticated delivery.
import type { Asset } from "@/db/repository";

export function publishedAssetResponse(request: Request, asset: Asset) {
  const response = storedAssetResponse(request, asset, "no-store");
  response.headers.set("CDN-Cache-Control", "no-store");
  response.headers.set("Vercel-CDN-Cache-Control", "no-store");
  return response;
}

export function storedAssetResponse(
  request: Request,
  asset: Asset,
  cacheControl: string,
) {
  const entityTag = `"${asset.hash}"`;
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Length": String(asset.byteSize),
    "Content-Type": asset.mediaType,
    ETag: entityTag,
    "X-Content-Type-Options": "nosniff",
  };

  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some((candidate) => candidate.trim() === entityTag)
  ) {
    return new Response(null, { status: 304, headers });
  }

  const content = new ArrayBuffer(asset.byteSize);
  new Uint8Array(content).set(asset.content);
  return new Response(content, { headers });
}
