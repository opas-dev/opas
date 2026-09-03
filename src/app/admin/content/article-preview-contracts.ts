// ABOUTME: Defines the transient administrator result contract for preview sharing.
// ABOUTME: Limits browser-visible state to task feedback and an explicitly requested link.

export type ArticlePreviewShare = Readonly<{
  expiresAt: string;
  externalImageHosts: readonly string[];
  grantId: string;
  revisionId: string;
  url: string;
}>;

export type ArticlePreviewActionState = Readonly<{
  link?: ArticlePreviewShare;
  message: string;
  status: "error" | "success";
}>;

export type ArticlePreviewAction = (
  formData: FormData,
) => Promise<ArticlePreviewActionState>;
