// ABOUTME: Defines the transient administrator result contract for preview sharing.
// ABOUTME: Limits browser-visible state to task feedback and an explicitly requested link.

export type ArticlePreviewGrantStatus = Readonly<{
  expiresAt: string;
  grantId: string;
  revisionId: string;
}>;

export type ArticlePreviewAvailability =
  | Readonly<{
      availability: "active";
      grant: ArticlePreviewGrantStatus;
    }>
  | Readonly<{ availability: "inactive" }>;

export type ArticlePreviewShare = ArticlePreviewGrantStatus &
  Readonly<{
    externalImageHosts: readonly string[];
    url: string;
  }>;

export type ArticlePreviewActionState = Readonly<{
  link?: ArticlePreviewShare;
  message: string;
  preview?: ArticlePreviewAvailability;
  status: "error" | "success";
}>;

export type ArticlePreviewStatusActionState =
  | Readonly<{
      preview: ArticlePreviewAvailability;
      status: "success";
    }>
  | Readonly<{
      message: string;
      status: "error";
    }>;

export type ArticlePreviewAction = (
  formData: FormData,
) => Promise<ArticlePreviewActionState>;

export type ArticlePreviewStatusAction = (
  formData: FormData,
) => Promise<ArticlePreviewStatusActionState>;
