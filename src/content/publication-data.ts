// ABOUTME: Loads the complete public help-center library from the active repository.
// ABOUTME: Applies one publication boundary before content reaches pages or machine-readable routes.
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";
import { isPublicSlug } from "@/site";

import { joinPublishedArticles } from "./publication";

export async function loadPublicationContent() {
  const repository = await getRepository();
  const [categories, articles] = await Promise.all([
    repository.listCategories(demoIds.workspace),
    repository.listPublishedArticles(demoIds.workspace),
  ]);
  const publicCategories = categories.filter(
    (category) =>
      category.workspaceId === demoIds.workspace && isPublicSlug(category.slug),
  );

  return {
    categories: publicCategories,
    publications: joinPublishedArticles({
      workspaceId: demoIds.workspace,
      categories: publicCategories,
      articles,
    }),
  };
}
