// ABOUTME: Defines exact category authoring requests and their no-write outcomes.
// ABOUTME: Carries named actors and numeric versions across every category mutation.
import type { MemberActor } from "@/auth/member-repository";

export type AuthoringCategory = Readonly<{
  description: string | null;
  id: string;
  name: string;
  position: number;
  slug: string;
  version: number;
  workspaceId: string;
}>;

export type CategoryValues = Omit<AuthoringCategory, "version">;

export type CreateCategoryRequest = Readonly<{
  actor: MemberActor;
  category: CategoryValues;
  expectedCategoryVersion: 0;
}>;

export type UpdateCategoryRequest = Readonly<{
  actor: MemberActor;
  category: CategoryValues;
  expectedCategoryVersion: number;
}>;

export type DeleteCategoryRequest = Readonly<{
  actor: MemberActor;
  category: Readonly<{
    id: string;
    workspaceId: string;
  }>;
  expectedCategoryVersion: number;
}>;

export type CategoryMutationFailure =
  | Readonly<{
      status: "conflict";
      code: "CATEGORY_EXISTS" | "CATEGORY_SLUG_CONFLICT" | "STALE_CATEGORY";
      currentVersion?: number;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "ACTOR_FORBIDDEN"
        | "CATEGORY_NOT_FOUND"
        | "CATEGORY_REFERENCED"
        | "INVALID_CATEGORY_VERSION"
        | "LIVE_CATEGORY_SLUG";
    }>;

export type CategorySaveResult =
  | Readonly<{
      status: "created" | "updated" | "unchanged";
      category: AuthoringCategory;
    }>
  | CategoryMutationFailure;

export type CategoryDeleteResult =
  | Readonly<{
      status: "deleted";
      categoryId: string;
    }>
  | CategoryMutationFailure;

export type CategoryMutationResult = CategorySaveResult | CategoryDeleteResult;

export interface CategoryAuthoringRepository {
  createCategory(request: CreateCategoryRequest): Promise<CategorySaveResult>;
  deleteCategory(request: DeleteCategoryRequest): Promise<CategoryDeleteResult>;
  listCategories(workspaceId: string): Promise<readonly AuthoringCategory[]>;
  updateCategory(request: UpdateCategoryRequest): Promise<CategorySaveResult>;
}

export type CategoryAuthoringRepositoryOptions = Readonly<{
  clock?: () => Date;
}>;

export function categoryAuthoringTime(
  options?: CategoryAuthoringRepositoryOptions,
) {
  const changedAt = options?.clock?.() ?? new Date();
  if (!Number.isFinite(changedAt.getTime())) {
    throw new Error("Category mutation time must be valid.");
  }
  return changedAt;
}

export function validExpectedCategoryVersion(version: number, creating = false) {
  return creating
    ? version === 0
    : Number.isSafeInteger(version) && version >= 1;
}

export function categoryChangeEventId(
  revisionId: string,
  categoryVersion: number,
) {
  return `category_changed:${categoryVersion}:${revisionId}`;
}
