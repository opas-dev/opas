// ABOUTME: Coordinates signed preview issuance, revocation, exchange, and exact-revision reads.
// ABOUTME: Keeps raw bearer tokens outside persistence and rechecks every durable grant use.

import {
  articlePreviewTokenContract,
  createArticlePreviewGrantId,
  createArticlePreviewToken,
  verifyArticlePreviewToken,
  type ArticlePreviewClaims,
} from "@/auth/preview-claims";
import type { ArticlePreviewConfiguration } from "@/auth/preview-environment";
import type { RandomBytes } from "@/auth/security-encoding";
import {
  articlePreviewRemoteImageHosts,
  rewriteArticlePreviewAssetUrls,
} from "@/content/article-preview";
import { validateArticleMdx } from "@/content/mdx-safety";

export type PreviewActor = Readonly<{
  memberId: string;
  sessionId: string;
  workspaceId: string;
}>;

export type ActiveArticlePreviewGrant = Readonly<{
  articleId: string;
  createdAt: Date;
  createdByMemberId: string;
  expiresAt: Date;
  grantId: string;
  revisionId: string;
  workspaceId: string;
}>;

export type ArticlePreviewRevision = ActiveArticlePreviewGrant &
  Readonly<{
    assetHashes: readonly string[];
    authorName: string;
    categoryName: string;
    categorySlug: string;
    isFaq: boolean;
    mdx: string;
    position: number;
    revisionNumber: number;
    revisionSavedAt: Date;
    slug: string;
    title: string;
  }>;

export type ArticlePreviewAsset = ActiveArticlePreviewGrant &
  Readonly<{
    byteSize: number;
    content: Uint8Array;
    hash: string;
    mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  }>;

export type ArticlePreviewDocument = Readonly<{
  articleId: string;
  assetHashes: readonly string[];
  authorName: string;
  categoryName: string;
  categorySlug: string;
  expiresAt: Date;
  grantId: string;
  isFaq: boolean;
  mdx: string;
  position: number;
  remoteImageHosts: readonly string[];
  revisionId: string;
  revisionNumber: number;
  revisionSavedAt: Date;
  slug: string;
  title: string;
  workspaceId: string;
}>;

export type ArticlePreviewRotationRequest = Readonly<{
  actor: PreviewActor;
  createdAt: Date;
  expiresAt: Date;
  grantId: string;
  revisionId: string;
}>;

export type ArticlePreviewRotationOutcome =
  | Readonly<{ outcome: "issued" }>
  | Readonly<{
      code: "ACTOR_FORBIDDEN" | "ARTICLE_ARCHIVED" | "GRANT_ID_COLLISION" | "REVISION_NOT_FOUND";
      outcome: "rejected";
    }>;

export type ArticlePreviewRevocationRequest = Readonly<{
  actor: PreviewActor;
  grantId: string;
  revokedAt: Date;
}>;

export type ManagedArticlePreviewLookup = Readonly<{
  actor: PreviewActor;
  revisionId: string;
}>;

export type ArticlePreviewRevocationOutcome =
  | Readonly<{ outcome: "revoked" }>
  | Readonly<{
      code: "ACTOR_FORBIDDEN" | "GRANT_NOT_FOUND";
      outcome: "rejected";
    }>;

export type ActiveArticlePreviewLookup = Readonly<{
  checkedAt: Date;
  grantId: string;
  revisionId: string;
  workspaceId: string;
}>;

export type ActiveArticlePreviewAssetLookup = ActiveArticlePreviewLookup &
  Readonly<{ hash: string }>;

export interface ArticlePreviewRepository {
  findActiveGrant(
    request: ActiveArticlePreviewLookup,
  ): Promise<ActiveArticlePreviewGrant | null>;
  findManagedGrant(
    request: ManagedArticlePreviewLookup,
  ): Promise<ActiveArticlePreviewGrant | null>;
  readActiveAsset(
    request: ActiveArticlePreviewAssetLookup,
  ): Promise<ArticlePreviewAsset | null>;
  readActiveRevision(
    request: ActiveArticlePreviewLookup,
  ): Promise<ArticlePreviewRevision | null>;
  revokeGrant(
    request: ArticlePreviewRevocationRequest,
  ): Promise<ArticlePreviewRevocationOutcome>;
  rotateGrant(
    request: ArticlePreviewRotationRequest,
  ): Promise<ArticlePreviewRotationOutcome>;
}

export type ArticlePreviewDependencies = Readonly<{
  clock?: () => Date;
  randomBytes?: RandomBytes;
  repository: ArticlePreviewRepository;
}>;

export type ArticlePreviewRepositoryOptions = Readonly<{
  clock?: () => Date;
}>;

export type ArticlePreviewIssueOutcome =
  | Readonly<{
      expiresAt: Date;
      grantId: string;
      outcome: "issued";
      revisionId: string;
      token: string;
      workspaceId: string;
    }>
  | Readonly<{
      code:
        | "ACTOR_FORBIDDEN"
        | "ARTICLE_ARCHIVED"
        | "GRANT_ID_COLLISION_EXHAUSTED"
        | "REVISION_NOT_FOUND";
      outcome: "rejected";
    }>;

const maximumGrantIdAttempts = 3;

export function articlePreviewRepositoryClock(
  options?: ArticlePreviewRepositoryOptions,
) {
  const checkedAt = options?.clock?.() ?? new Date();
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error("Article preview time must be valid.");
  }
  return checkedAt;
}

function grantExpiry(createdAt: Date) {
  const milliseconds = createdAt.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("INVALID_PREVIEW_CLOCK");
  return new Date(
    milliseconds + articlePreviewTokenContract.lifetimeSeconds * 1_000,
  );
}

function grantMatchesClaims(
  grant: ActiveArticlePreviewGrant,
  claims: ArticlePreviewClaims,
) {
  const seconds = (value: Date) => Math.floor(value.getTime() / 1_000);
  return (
    grant.grantId === claims.grantId &&
    grant.workspaceId === claims.workspaceId &&
    grant.revisionId === claims.revisionId &&
    seconds(grant.createdAt) === seconds(claims.issuedAt) &&
    seconds(grant.expiresAt) === seconds(claims.expiresAt)
  );
}

async function verifiedClaims(
  token: string | undefined,
  configuration: ArticlePreviewConfiguration,
  now: Date,
) {
  return verifyArticlePreviewToken(
    token,
    configuration.signingSecret,
    configuration.deploymentId,
    now,
  );
}

export async function issueArticlePreview(
  actor: PreviewActor,
  revisionId: string,
  configuration: ArticlePreviewConfiguration,
  dependencies: ArticlePreviewDependencies,
): Promise<ArticlePreviewIssueOutcome> {
  const createdAt = dependencies.clock?.() ?? new Date();
  const expiresAt = grantExpiry(createdAt);

  for (let attempt = 0; attempt < maximumGrantIdAttempts; attempt += 1) {
    const grantId = createArticlePreviewGrantId(dependencies.randomBytes);
    const signed = await createArticlePreviewToken(
      {
        databaseExpiresAt: expiresAt,
        grantId,
        revisionId,
        workspaceId: actor.workspaceId,
      },
      configuration.signingSecret,
      configuration.deploymentId,
      createdAt,
    );
    const result = await dependencies.repository.rotateGrant({
      actor,
      createdAt,
      expiresAt,
      grantId,
      revisionId,
    });
    if (result.outcome === "issued") {
      return Object.freeze({
        expiresAt: signed.claims.expiresAt,
        grantId,
        outcome: "issued",
        revisionId,
        token: signed.token,
        workspaceId: actor.workspaceId,
      });
    }
    if (result.code !== "GRANT_ID_COLLISION") {
      return Object.freeze({ outcome: "rejected", code: result.code });
    }
  }

  return Object.freeze({
    code: "GRANT_ID_COLLISION_EXHAUSTED",
    outcome: "rejected",
  });
}

export function readManagedArticlePreviewGrant(
  actor: PreviewActor,
  revisionId: string,
  dependencies: Pick<ArticlePreviewDependencies, "repository">,
) {
  return dependencies.repository.findManagedGrant({ actor, revisionId });
}

export async function exchangeArticlePreview(
  token: string | undefined,
  configuration: ArticlePreviewConfiguration,
  dependencies: ArticlePreviewDependencies,
) {
  const checkedAt = dependencies.clock?.() ?? new Date();
  const claims = await verifiedClaims(token, configuration, checkedAt);
  if (!claims) return null;
  const grant = await dependencies.repository.findActiveGrant({
    checkedAt,
    grantId: claims.grantId,
    revisionId: claims.revisionId,
    workspaceId: claims.workspaceId,
  });
  if (!grant || !grantMatchesClaims(grant, claims)) return null;
  return Object.freeze({ claims, databaseExpiresAt: grant.expiresAt, token: token as string });
}

export async function resolveArticlePreview(
  token: string | undefined,
  configuration: ArticlePreviewConfiguration,
  dependencies: ArticlePreviewDependencies,
): Promise<ArticlePreviewDocument | null> {
  const checkedAt = dependencies.clock?.() ?? new Date();
  const claims = await verifiedClaims(token, configuration, checkedAt);
  if (!claims) return null;
  const revision = await dependencies.repository.readActiveRevision({
    checkedAt,
    grantId: claims.grantId,
    revisionId: claims.revisionId,
    workspaceId: claims.workspaceId,
  });
  if (!revision || !grantMatchesClaims(revision, claims)) return null;

  await validateArticleMdx(revision.mdx, revision.title);
  return Object.freeze({
    articleId: revision.articleId,
    assetHashes: Object.freeze([...revision.assetHashes]),
    authorName: revision.authorName,
    categoryName: revision.categoryName,
    categorySlug: revision.categorySlug,
    expiresAt: revision.expiresAt,
    grantId: revision.grantId,
    isFaq: revision.isFaq,
    mdx: rewriteArticlePreviewAssetUrls(revision.mdx),
    position: revision.position,
    remoteImageHosts: articlePreviewRemoteImageHosts(revision.mdx),
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    revisionSavedAt: revision.revisionSavedAt,
    slug: revision.slug,
    title: revision.title,
    workspaceId: revision.workspaceId,
  });
}

export async function resolveArticlePreviewAsset(
  token: string | undefined,
  hash: string,
  configuration: ArticlePreviewConfiguration,
  dependencies: ArticlePreviewDependencies,
): Promise<ArticlePreviewAsset | null> {
  const checkedAt = dependencies.clock?.() ?? new Date();
  const claims = await verifiedClaims(token, configuration, checkedAt);
  if (!claims) return null;
  const asset = await dependencies.repository.readActiveAsset({
    checkedAt,
    grantId: claims.grantId,
    hash,
    revisionId: claims.revisionId,
    workspaceId: claims.workspaceId,
  });
  return asset && grantMatchesClaims(asset, claims) ? asset : null;
}

export function revokeArticlePreview(
  actor: PreviewActor,
  grantId: string,
  dependencies: ArticlePreviewDependencies,
) {
  return dependencies.repository.revokeGrant({
    actor,
    grantId,
    revokedAt: dependencies.clock?.() ?? new Date(),
  });
}
