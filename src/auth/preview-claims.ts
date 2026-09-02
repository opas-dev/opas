// ABOUTME: Freezes the signed article-preview claim and cookie contract.
// ABOUTME: Keeps preview grants exact-revision, deployment-specific, and independently keyed.

export const articlePreviewTokenContract = Object.freeze({
  algorithm: "HS256",
  audience: "opas-article-preview",
  issuer: "opas",
  lifetimeSeconds: 7 * 24 * 60 * 60,
  cookiePath: "/preview",
  claims: Object.freeze({
    deploymentId: "did",
    grantId: "jti",
    revisionId: "rid",
    workspaceId: "wid",
  }),
});

export type ArticlePreviewClaims = {
  deploymentId: string;
  grantId: string;
  workspaceId: string;
  revisionId: string;
  issuedAt: Date;
  expiresAt: Date;
};
