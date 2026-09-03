// ABOUTME: Defines the small serialized result contract shared by team Server Actions and controls.
// ABOUTME: Limits browser-visible feedback to task messages and an explicitly requested one-time link.

import type { MemberLinkKind } from "@/auth/member-link-claims";

export type TeamActionLink = Readonly<{
  expiresAt: string;
  kind: MemberLinkKind;
  url: string;
}>;

export type TeamActionState = Readonly<{
  fieldErrors?: Readonly<
    Partial<Record<"email" | "member" | "role", string>>
  >;
  link?: TeamActionLink;
  message: string;
  status: "error" | "success";
}>;

export type TeamAction = (formData: FormData) => Promise<TeamActionState>;
