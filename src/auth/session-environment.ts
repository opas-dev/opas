// ABOUTME: Validates the deployment identity and signing secret used by named-member sessions.
// ABOUTME: Derives one canonical deployment scope from the configured public site hostname.
import { canonicalDeploymentId } from "@/auth/security-encoding";
import { resolveSiteOrigin } from "@/site";

export type AdminSessionConfig = Readonly<{
  deploymentId: string;
  sessionSecret: string;
}>;

export type AdminSessionEnvironment = Readonly<
  Partial<Record<"ADMIN_SESSION_SECRET" | "OPAS_SITE_URL", string | undefined>>
>;

export function parseAdminSessionEnvironment(
  environment: AdminSessionEnvironment,
): AdminSessionConfig {
  const sessionSecret = environment.ADMIN_SESSION_SECRET ?? "";

  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }

  const deploymentId = canonicalDeploymentId(
    new URL(resolveSiteOrigin(environment.OPAS_SITE_URL)).hostname,
  );

  return { deploymentId, sessionSecret };
}
