// ABOUTME: Exposes capability-checked Server Actions for preview creation and revocation.
// ABOUTME: Resolves deployment configuration and database identity only on the server.
"use server";

import {
  runCreateArticlePreviewAction,
  runRevokeArticlePreviewAction,
  unavailableArticlePreviewAction,
} from "@/app/admin/content/article-preview-action-runtime";
import type { ArticlePreviewActionState } from "@/app/admin/content/article-preview-contracts";
import { requireMemberCapability } from "@/auth/admin";
import { getArticlePreviewRepository } from "@/auth/article-preview-database";
import { getArticlePreviewConfiguration } from "@/auth/preview-config";
import { demoIds } from "@/db/demo";
import { resolveSiteOrigin } from "@/site";

async function actionDependencies(
  actor: Awaited<ReturnType<typeof requireMemberCapability>>,
) {
  return {
    actor,
    configuration: getArticlePreviewConfiguration(),
    repository: await getArticlePreviewRepository(),
    siteOrigin: resolveSiteOrigin(),
  };
}

export async function createArticlePreviewAction(
  formData: FormData,
): Promise<ArticlePreviewActionState> {
  const actor = await requireMemberCapability("preview:manage", demoIds.workspace);
  try {
    return await runCreateArticlePreviewAction(
      formData,
      await actionDependencies(actor),
    );
  } catch {
    return unavailableArticlePreviewAction();
  }
}

export async function revokeArticlePreviewAction(
  formData: FormData,
): Promise<ArticlePreviewActionState> {
  const actor = await requireMemberCapability("preview:manage", demoIds.workspace);
  try {
    return await runRevokeArticlePreviewAction(
      formData,
      await actionDependencies(actor),
    );
  } catch {
    return unavailableArticlePreviewAction();
  }
}
