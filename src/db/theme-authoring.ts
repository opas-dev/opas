// ABOUTME: Defines exact runtime-theme mutations with named actors and numeric CAS.
// ABOUTME: Keeps workspace appearance writes behind explicit no-write outcomes.
import type { MemberActor } from "@/auth/member-repository";

export type AuthoringTheme = Readonly<{
  config: unknown;
  createdAt: Date;
  id: string;
  name: string;
  updatedAt: Date;
  version: number;
  workspaceId: string;
}>;

export type UpdateThemeRequest = Readonly<{
  actor: MemberActor;
  expectedThemeVersion: number;
  theme: Readonly<{
    config: unknown;
    id: string;
    name: string;
    workspaceId: string;
  }>;
}>;

export type ThemeMutationResult =
  | Readonly<{
      status: "updated" | "unchanged";
      theme: AuthoringTheme;
    }>
  | Readonly<{
      status: "conflict";
      code: "STALE_THEME";
      currentVersion: number;
    }>
  | Readonly<{
      status: "rejected";
      code: "ACTOR_FORBIDDEN" | "INVALID_THEME_VERSION" | "THEME_NOT_FOUND";
    }>;

export interface ThemeAuthoringRepository {
  getTheme(workspaceId: string): Promise<AuthoringTheme | null>;
  updateTheme(request: UpdateThemeRequest): Promise<ThemeMutationResult>;
}

export type ThemeAuthoringRepositoryOptions = Readonly<{
  clock?: () => Date;
}>;

export function themeAuthoringTime(options?: ThemeAuthoringRepositoryOptions) {
  const changedAt = options?.clock?.() ?? new Date();
  if (!Number.isFinite(changedAt.getTime())) {
    throw new Error("Theme mutation time must be valid.");
  }
  return changedAt;
}

export function validExpectedThemeVersion(version: number) {
  return Number.isSafeInteger(version) && version >= 1;
}
