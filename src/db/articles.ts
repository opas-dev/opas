// ABOUTME: Exposes published article reads to database-neutral application routes.
// ABOUTME: Preserves a focused article entry point while the repository selects the driver.
import { getRepository } from "@/db";

export async function findPublishedArticle(workspaceId: string, slug: string) {
  return (await getRepository()).findPublishedArticle(workspaceId, slug);
}
