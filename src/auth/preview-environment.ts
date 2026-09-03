// ABOUTME: Validates the isolated signing configuration used by anonymous article previews.
// ABOUTME: Binds each preview token and cookie to one canonical deployment hostname.

import { canonicalDeploymentId } from "@/auth/security-encoding";
import { resolveSiteOrigin } from "@/site";

export type ArticlePreviewConfiguration = Readonly<{
  deploymentId: string;
  signingSecret: string;
}>;

export type ArticlePreviewEnvironment = Readonly<
  Partial<
    Record<"OPAS_PREVIEW_SIGNING_SECRET" | "OPAS_SITE_URL", string | undefined>
  >
>;

export function parseArticlePreviewEnvironment(
  environment: ArticlePreviewEnvironment,
): ArticlePreviewConfiguration {
  const signingSecret = environment.OPAS_PREVIEW_SIGNING_SECRET ?? "";
  if (new TextEncoder().encode(signingSecret).byteLength < 32) {
    throw new Error("OPAS_PREVIEW_SIGNING_SECRET must contain at least 32 bytes.");
  }

  const deploymentId = canonicalDeploymentId(
    new URL(resolveSiteOrigin(environment.OPAS_SITE_URL)).hostname,
  );
  return { deploymentId, signingSecret };
}
