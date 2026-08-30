// ABOUTME: Serves staged and draft article images only to an authenticated administrator.
// ABOUTME: Keeps canonical public asset URLs private until a referenced article is published.
import { isAssetHash } from "@/assets/identity";
import { storedAssetResponse } from "@/assets/responses";
import { requireAdmin } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: RouteContext<"/admin/content/assets/[hash]">,
) {
  await requireAdmin();
  const { hash } = await params;
  if (!isAssetHash(hash)) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const asset = await (await getRepository()).getAsset(demoIds.workspace, hash);
  if (!asset) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return storedAssetResponse(request, asset, "private, no-store");
}
