// ABOUTME: Defines the fixed team roles, capabilities, and protected authoring mutations.
// ABOUTME: Enforces role authorization and independent approval before a domain write begins.

export const teamRoles = ["administrator", "editor", "reviewer"] as const;

export type TeamRole = (typeof teamRoles)[number];

export const capabilities = [
  "content:read",
  "draft:edit",
  "import:run",
  "review:submit",
  "preview:manage",
  "review:decide",
  "publication:publish",
  "publication:emergency-publish",
  "article:retire",
  "revision:restore",
  "category:manage",
  "quality:manage",
  "workspace:configure",
  "member:manage",
] as const;

export type Capability = (typeof capabilities)[number];

const roleCapabilities = {
  administrator: capabilities,
  editor: [
    "content:read",
    "draft:edit",
    "import:run",
    "review:submit",
    "preview:manage",
    "revision:restore",
    "category:manage",
  ],
  reviewer: [
    "content:read",
    "preview:manage",
    "review:decide",
    "publication:publish",
    "article:retire",
    "quality:manage",
  ],
} as const satisfies Record<TeamRole, readonly Capability[]>;

export const protectedMutations = [
  "article:create",
  "article:save",
  "article:submit",
  "article:withdraw",
  "article:request-changes",
  "article:approve",
  "article:publish",
  "article:emergency-publish",
  "article:unpublish",
  "article:archive",
  "article:restore",
  "asset:stage",
  "asset:discard",
  "import:plan",
  "import:execute",
  "preview:create",
  "preview:revoke",
  "category:create",
  "category:update",
  "category:delete",
  "quality:run",
  "quality:review",
  "theme:change",
  "topic-policy:change",
  "member:invite",
  "member:disable",
  "member:reactivate",
  "member:reset-credentials",
  "member:change-role",
] as const;

export type ProtectedMutation = (typeof protectedMutations)[number];

export const protectedMutationCapabilities = {
  "article:create": "draft:edit",
  "article:save": "draft:edit",
  "article:submit": "review:submit",
  "article:withdraw": "review:submit",
  "article:request-changes": "review:decide",
  "article:approve": "review:decide",
  "article:publish": "publication:publish",
  "article:emergency-publish": "publication:emergency-publish",
  "article:unpublish": "article:retire",
  "article:archive": "article:retire",
  "article:restore": "revision:restore",
  "asset:stage": "draft:edit",
  "asset:discard": "draft:edit",
  "import:plan": "import:run",
  "import:execute": "import:run",
  "preview:create": "preview:manage",
  "preview:revoke": "preview:manage",
  "category:create": "category:manage",
  "category:update": "category:manage",
  "category:delete": "category:manage",
  "quality:run": "quality:manage",
  "quality:review": "quality:manage",
  "theme:change": "workspace:configure",
  "topic-policy:change": "workspace:configure",
  "member:invite": "member:manage",
  "member:disable": "member:manage",
  "member:reactivate": "member:manage",
  "member:reset-credentials": "member:manage",
  "member:change-role": "member:manage",
} as const satisfies Record<ProtectedMutation, Capability>;

export type AuthorizationFailure = "CAPABILITY_REQUIRED" | "SELF_APPROVAL_FORBIDDEN";

export class AuthorizationError extends Error {
  readonly code: AuthorizationFailure;

  constructor(code: AuthorizationFailure) {
    super(code);
    this.code = code;
  }
}

export function capabilitiesForRole(role: TeamRole): readonly Capability[] {
  return roleCapabilities[role];
}

export function hasCapability(role: TeamRole, capability: Capability): boolean {
  return (roleCapabilities[role] as readonly Capability[]).includes(capability);
}

export function requireCapability(role: TeamRole, capability: Capability): void {
  if (!hasCapability(role, capability)) {
    throw new AuthorizationError("CAPABILITY_REQUIRED");
  }
}

export function capabilityForMutation(mutation: ProtectedMutation): Capability {
  return protectedMutationCapabilities[mutation];
}

export function requireMutationCapability(role: TeamRole, mutation: ProtectedMutation): void {
  requireCapability(role, capabilityForMutation(mutation));
}

export function requireIndependentApproval(
  approverMemberId: string,
  revisionCreatorMemberId: string,
  revisionSubmitterMemberId: string | null,
): void {
  if (
    approverMemberId === revisionCreatorMemberId ||
    approverMemberId === revisionSubmitterMemberId
  ) {
    throw new AuthorizationError("SELF_APPROVAL_FORBIDDEN");
  }
}
