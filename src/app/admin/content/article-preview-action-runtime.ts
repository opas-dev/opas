// ABOUTME: Parses preview-management forms and maps grant outcomes to bounded feedback.
// ABOUTME: Returns each signed fragment link only from its explicit creation request.

import type {
  ArticlePreviewActionState,
  ArticlePreviewAvailability,
  ArticlePreviewGrantStatus,
  ArticlePreviewStatusActionState,
} from "@/app/admin/content/article-preview-contracts";
import {
  issueArticlePreview,
  readManagedArticlePreviewGrant,
  resolveArticlePreview,
  revokeArticlePreview,
  type ArticlePreviewRepository,
  type PreviewActor,
} from "@/auth/article-preview";
import type { ArticlePreviewConfiguration } from "@/auth/preview-environment";
import type { RandomBytes } from "@/auth/security-encoding";
import { assertAuthIdentifier } from "@/auth/security-encoding";
import { getAuthoringPausedFailure } from "@/authoring/failures";

export type ArticlePreviewActionDependencies = Readonly<{
  actor: PreviewActor;
  clock?: () => Date;
  configuration: ArticlePreviewConfiguration;
  randomBytes?: RandomBytes;
  repository: ArticlePreviewRepository;
  siteOrigin: string;
}>;

function state(
  status: ArticlePreviewActionState["status"],
  message: string,
  link?: ArticlePreviewActionState["link"],
  preview?: ArticlePreviewActionState["preview"],
): ArticlePreviewActionState {
  return Object.freeze({
    status,
    message,
    ...(link ? { link } : {}),
    ...(preview ? { preview } : {}),
  });
}

export function unavailableArticlePreviewAction() {
  return state("error", "Preview sharing is unavailable. Try again.");
}

function exactTextFields(formData: FormData, names: readonly string[]) {
  const keys = [...formData.keys()];
  if (
    keys.length !== names.length ||
    keys.some((key) => !names.includes(key)) ||
    names.some((name) => formData.getAll(name).length !== 1)
  ) {
    return null;
  }

  const fields: Record<string, string> = {};
  for (const name of names) {
    const value = formData.get(name);
    if (typeof value !== "string") return null;
    try {
      fields[name] = assertAuthIdentifier(value);
    } catch {
      return null;
    }
  }
  return fields;
}

function exactTextField(formData: FormData, name: string) {
  return exactTextFields(formData, [name])?.[name] ?? null;
}

function issueFailure(code: string) {
  if (code === "ARTICLE_ARCHIVED") {
    return state("error", "Restore this article before sharing a preview.");
  }
  if (code === "REVISION_NOT_FOUND") {
    return state("error", "That saved revision no longer exists. Reload and try again.");
  }
  if (code === "ACTOR_FORBIDDEN") {
    return state("error", "Your session can no longer create previews. Sign in again.");
  }
  if (code === "GRANT_ID_COLLISION_EXHAUSTED") {
    return state("error", "A secure preview link could not be created. Try again.");
  }
  return unavailableArticlePreviewAction();
}

function grantStatus(
  grant: Readonly<{ expiresAt: Date; grantId: string; revisionId: string }>,
): ArticlePreviewGrantStatus {
  return Object.freeze({
    expiresAt: grant.expiresAt.toISOString(),
    grantId: grant.grantId,
    revisionId: grant.revisionId,
  });
}

async function managedAvailability(
  revisionId: string,
  dependencies: ArticlePreviewActionDependencies,
): Promise<ArticlePreviewAvailability | undefined> {
  try {
    const activeGrant = await readManagedArticlePreviewGrant(
      dependencies.actor,
      revisionId,
      dependencies,
    );
    return activeGrant
      ? Object.freeze({
          availability: "active" as const,
          grant: grantStatus(activeGrant),
        })
      : Object.freeze({ availability: "inactive" as const });
  } catch {
    return undefined;
  }
}

export function unavailableArticlePreviewStatusAction(): ArticlePreviewStatusActionState {
  return Object.freeze({
    message: "Preview status is unavailable. Reload to try again.",
    status: "error",
  });
}

export async function runReadArticlePreviewStatusAction(
  formData: FormData,
  dependencies: ArticlePreviewActionDependencies,
): Promise<ArticlePreviewStatusActionState> {
  const revisionId = exactTextField(formData, "revisionId");
  if (!revisionId) {
    return Object.freeze({
      message: "The preview status request is invalid. Reload and try again.",
      status: "error",
    });
  }

  const preview = await managedAvailability(revisionId, dependencies);
  if (preview) {
    return Object.freeze({
      preview,
      status: "success" as const,
    });
  }
  return unavailableArticlePreviewStatusAction();
}

async function revokeUnsharedGrant(
  grantId: string,
  dependencies: ArticlePreviewActionDependencies,
) {
  try {
    await revokeArticlePreview(dependencies.actor, grantId, dependencies);
  } catch {
    // The bearer was never returned, so a failed cleanup can only leave an unreachable grant.
  }
}

export async function runCreateArticlePreviewAction(
  formData: FormData,
  dependencies: ArticlePreviewActionDependencies,
): Promise<ArticlePreviewActionState> {
  const revisionId = exactTextField(formData, "revisionId");
  if (!revisionId) {
    return state("error", "The saved revision is invalid. Reload and try again.");
  }

  let url;
  try {
    url = new URL("/preview", dependencies.siteOrigin);
  } catch {
    return unavailableArticlePreviewAction();
  }
  if (url.origin !== dependencies.siteOrigin || url.pathname !== "/preview") {
    return unavailableArticlePreviewAction();
  }

  try {
    const issued = await issueArticlePreview(
      dependencies.actor,
      revisionId,
      dependencies.configuration,
      dependencies,
    );
    if (issued.outcome !== "issued") return issueFailure(issued.code);

    let preview;
    try {
      preview = await resolveArticlePreview(
        issued.token,
        dependencies.configuration,
        dependencies,
      );
    } catch {
      await revokeUnsharedGrant(issued.grantId, dependencies);
      return unavailableArticlePreviewAction();
    }
    if (!preview) {
      await revokeUnsharedGrant(issued.grantId, dependencies);
      return state(
        "error",
        "Another preview replaced this link. Create a fresh link to share.",
        undefined,
        await managedAvailability(revisionId, dependencies),
      );
    }

    url.hash = issued.token;
    const currentGrant = grantStatus(issued);
    return state(
      "success",
      "Preview link created. Copy it now; OPAS cannot show it again.",
      Object.freeze({
        ...currentGrant,
        externalImageHosts: preview.remoteImageHosts,
        url: url.href,
      }),
      Object.freeze({ availability: "active", grant: currentGrant }),
    );
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    return paused
      ? state("error", paused.message)
      : unavailableArticlePreviewAction();
  }
}

export async function runRevokeArticlePreviewAction(
  formData: FormData,
  dependencies: ArticlePreviewActionDependencies,
): Promise<ArticlePreviewActionState> {
  const fields = exactTextFields(formData, ["grantId", "revisionId"]);
  if (!fields) {
    return state("error", "The preview request is invalid. Reload and try again.");
  }

  try {
    const outcome = await revokeArticlePreview(
      dependencies.actor,
      fields.grantId,
      dependencies,
    );
    if (outcome.outcome === "revoked") {
      return state(
        "success",
        "Preview link revoked.",
        undefined,
        await managedAvailability(fields.revisionId, dependencies),
      );
    }
    return outcome.code === "GRANT_NOT_FOUND"
      ? state(
          "error",
          "That preview was already unavailable. The current status is shown above.",
          undefined,
          await managedAvailability(fields.revisionId, dependencies),
        )
      : state("error", "Your session can no longer revoke previews. Sign in again.");
  } catch {
    return unavailableArticlePreviewAction();
  }
}
