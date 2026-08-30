// ABOUTME: Describes whether an article save consumed, discarded, or retained its staged images.
// ABOUTME: Keeps client manifest cleanup aligned with the repository's persistence-failure contract.
export type ArticleAssetManifestStatus = "discarded" | "uncertain";

export function failedArticleAssetManifestStatus(
  manifestId: string | undefined,
  error: unknown,
): ArticleAssetManifestStatus | undefined {
  if (!manifestId) {
    return undefined;
  }

  return error instanceof AggregateError ? "uncertain" : "discarded";
}

export function articleAssetManifestNeedsReset(state: {
  status: "idle" | "error" | "success";
  revision: number;
  assetManifestStatus?: ArticleAssetManifestStatus;
}) {
  return (
    (state.status === "success" && state.revision > 0) ||
    state.assetManifestStatus === "discarded" ||
    state.assetManifestStatus === "uncertain"
  );
}
