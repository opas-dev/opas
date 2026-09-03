// ABOUTME: Orchestrates one-time administrator bootstrap and operator-owned account recovery.
// ABOUTME: Keeps plaintext passwords and one-time bearers outside database and public command results.

import {
  createMemberLinkBearer,
  digestMemberLinkBearer,
  memberLinkContract,
  type MemberLinkKind,
} from "@/auth/member-link-claims";
import {
  createMemberPasswordVerifier,
  type MemberPasswordVerifier,
} from "@/auth/member-password";
import {
  assertAuthIdentifier,
  createRandomBytes,
  encodeBase64Url,
  type RandomBytes,
} from "@/auth/security-encoding";

export type OperatorWorkspaceCreation = Readonly<{
  id: string;
  name: string;
  slug: string;
}>;

export type OperatorBootstrapRecord = Readonly<{
  createdAt: Date;
  displayName: string;
  memberId: string;
  normalizedEmail: string;
  password: MemberPasswordVerifier;
  workspaceCreation: OperatorWorkspaceCreation | null;
  workspaceReference: string;
}>;

export type OperatorBootstrapOutcome =
  | Readonly<{
      memberId: string;
      outcome: "created";
      workspaceCreated: boolean;
      workspaceId: string;
    }>
  | Readonly<{
      outcome:
        | "already_bootstrapped"
        | "ambiguous"
        | "conflict"
        | "not_empty"
        | "not_found"
        | "partial_state";
    }>;

export type OperatorRecoveryTarget =
  | Readonly<{ kind: "invite"; normalizedEmail: string }>
  | Readonly<{
      kind: "credential_reset";
      memberReference: Readonly<{
        field: "id" | "normalized_email";
        value: string;
      }>;
    }>;

export type OperatorRecoveryRecord = Readonly<{
  createdAt: Date;
  expiresAt: Date;
  recordId: string;
  target: OperatorRecoveryTarget;
  tokenDigest: string;
  workspaceReference: string;
}>;

export type OperatorRecoveryOutcome =
  | Readonly<{
      outcome: "created";
      workspaceId: string;
    }>
  | Readonly<{
      outcome: "ambiguous" | "collision" | "not_found" | "partial_state";
    }>;

export interface OperatorIdentityRepository {
  bootstrap(request: OperatorBootstrapRecord): Promise<OperatorBootstrapOutcome>;
  issueRecovery(request: OperatorRecoveryRecord): Promise<OperatorRecoveryOutcome>;
  revokeUndeliveredRecovery(request: OperatorRecoveryRecord): Promise<void>;
}

export type OperatorBootstrapInput = Readonly<{
  adminEmail: string;
  adminPassword: string;
  displayName: string;
  workspaceCreation?: OperatorWorkspaceCreation;
  workspaceReference: string;
}>;

export type OperatorRecoveryInput = Readonly<{
  email?: string;
  kind: MemberLinkKind;
  member?: string;
  siteOrigin: string;
  workspaceReference: string;
}>;

export type OperatorRecoveryArtifact = Readonly<{
  expiresAt: Date;
  kind: MemberLinkKind;
  recordId: string;
  url: string;
  workspaceId: string;
}>;

export type OperatorBootstrapResult = Readonly<{
  memberId: string;
  outcome: "created";
  workspaceCreated: boolean;
  workspaceId: string;
}>;

export type OperatorRecoveryResult = Readonly<{
  expiresAt: string;
  kind: MemberLinkKind;
  outcome: "created";
  recordId: string;
  workspaceId: string;
}>;

export type OperatorIdentityFailure =
  | "BOOTSTRAP_ALREADY_COMPLETED"
  | "BOOTSTRAP_CONFLICT"
  | "BOOTSTRAP_PARTIAL_STATE"
  | "INVALID_ADMIN_EMAIL"
  | "INVALID_DISPLAY_NAME"
  | "INVALID_RECOVERY_INPUT"
  | "INVALID_RECOVERY_SITE"
  | "INVALID_WORKSPACE"
  | "RECOVERY_COLLISION_EXHAUSTED"
  | "RECOVERY_CLEANUP_FAILED"
  | "RECOVERY_DELIVERY_FAILED"
  | "RECOVERY_PARTIAL_STATE"
  | "WORKSPACE_AMBIGUOUS"
  | "WORKSPACE_NOT_EMPTY"
  | "WORKSPACE_NOT_FOUND";

export class OperatorIdentityError extends Error {
  readonly code: OperatorIdentityFailure;

  constructor(code: OperatorIdentityFailure) {
    super(code);
    this.code = code;
    this.name = "OperatorIdentityError";
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const workspaceSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const recoveryCollisionAttempts = 3;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function displayName(value: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    codePointLength(normalized) < 1 ||
    codePointLength(normalized) > 100 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new OperatorIdentityError("INVALID_DISPLAY_NAME");
  }
  return normalized;
}

function workspaceReference(value: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    codePointLength(normalized) < 1 ||
    codePointLength(normalized) > 128 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new OperatorIdentityError("INVALID_WORKSPACE");
  }
  return normalized;
}

function workspaceCreation(
  value: OperatorWorkspaceCreation | undefined,
  reference: string,
): OperatorWorkspaceCreation | null {
  if (!value) return null;

  let id: string;
  try {
    id = assertAuthIdentifier(value.id);
  } catch {
    throw new OperatorIdentityError("INVALID_WORKSPACE");
  }
  const slug = value.slug.trim();
  const name = value.name.trim();
  if (
    slug !== value.slug ||
    !workspaceSlugPattern.test(slug) ||
    name !== value.name ||
    codePointLength(name) < 1 ||
    codePointLength(name) > 100 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    (reference !== id && reference !== slug)
  ) {
    throw new OperatorIdentityError("INVALID_WORKSPACE");
  }
  return Object.freeze({ id, name, slug });
}

export function normalizeOperatorEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    codePointLength(normalized) > 320 ||
    new TextEncoder().encode(normalized).byteLength > 1_280 ||
    !emailPattern.test(normalized)
  ) {
    throw new OperatorIdentityError("INVALID_ADMIN_EMAIL");
  }
  return normalized;
}

function memberReference(value: string): Extract<
  OperatorRecoveryTarget,
  { kind: "credential_reset" }
>["memberReference"] {
  if (value.includes("@")) {
    return Object.freeze({
      field: "normalized_email" as const,
      value: normalizeOperatorEmail(value),
    });
  }

  try {
    return Object.freeze({ field: "id" as const, value: assertAuthIdentifier(value) });
  } catch {
    throw new OperatorIdentityError("INVALID_RECOVERY_INPUT");
  }
}

function operatorId(prefix: "member" | "member_link", randomBytes?: RandomBytes) {
  return assertAuthIdentifier(
    `${prefix}_${encodeBase64Url(createRandomBytes(18, randomBytes))}`,
  );
}

function recoverySiteOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new OperatorIdentityError("INVALID_RECOVERY_SITE");
  }
}

function bootstrapFailure(outcome: Exclude<OperatorBootstrapOutcome, { outcome: "created" }>) {
  if (outcome.outcome === "already_bootstrapped") {
    return new OperatorIdentityError("BOOTSTRAP_ALREADY_COMPLETED");
  }
  if (outcome.outcome === "ambiguous") {
    return new OperatorIdentityError("WORKSPACE_AMBIGUOUS");
  }
  if (outcome.outcome === "not_empty") {
    return new OperatorIdentityError("WORKSPACE_NOT_EMPTY");
  }
  if (outcome.outcome === "not_found") {
    return new OperatorIdentityError("WORKSPACE_NOT_FOUND");
  }
  if (outcome.outcome === "partial_state") {
    return new OperatorIdentityError("BOOTSTRAP_PARTIAL_STATE");
  }
  return new OperatorIdentityError("BOOTSTRAP_CONFLICT");
}

function recoveryFailure(outcome: Exclude<OperatorRecoveryOutcome, { outcome: "created" }>) {
  if (outcome.outcome === "ambiguous") {
    return new OperatorIdentityError("WORKSPACE_AMBIGUOUS");
  }
  if (outcome.outcome === "not_found") {
    return new OperatorIdentityError("WORKSPACE_NOT_FOUND");
  }
  return new OperatorIdentityError("RECOVERY_PARTIAL_STATE");
}

export async function bootstrapOperatorAdministrator(
  repository: OperatorIdentityRepository,
  input: OperatorBootstrapInput,
  options: Readonly<{
    clock?: () => Date;
    randomBytes?: RandomBytes;
  }> = {},
): Promise<OperatorBootstrapResult> {
  const reference = workspaceReference(input.workspaceReference);
  const creation = workspaceCreation(input.workspaceCreation, reference);
  const password = await createMemberPasswordVerifier(
    input.adminPassword,
    options.randomBytes,
  );
  const result = await repository.bootstrap({
    createdAt: options.clock?.() ?? new Date(),
    displayName: displayName(input.displayName),
    memberId: operatorId("member", options.randomBytes),
    normalizedEmail: normalizeOperatorEmail(input.adminEmail),
    password,
    workspaceCreation: creation,
    workspaceReference: reference,
  });

  if (result.outcome !== "created") throw bootstrapFailure(result);
  return result;
}

export async function issueOperatorRecovery(
  repository: OperatorIdentityRepository,
  input: OperatorRecoveryInput,
  deliver: (artifact: OperatorRecoveryArtifact) => Promise<void>,
  options: Readonly<{
    clock?: () => Date;
    randomBytes?: RandomBytes;
  }> = {},
): Promise<OperatorRecoveryResult> {
  const reference = workspaceReference(input.workspaceReference);
  const origin = recoverySiteOrigin(input.siteOrigin);
  const target: OperatorRecoveryTarget =
    input.kind === "invite" && input.email && input.member === undefined
      ? Object.freeze({
          kind: "invite" as const,
          normalizedEmail: normalizeOperatorEmail(input.email),
        })
      : input.kind === "credential_reset" && input.member && input.email === undefined
        ? Object.freeze({
            kind: "credential_reset" as const,
            memberReference: memberReference(input.member),
          })
        : (() => {
            throw new OperatorIdentityError("INVALID_RECOVERY_INPUT");
          })();
  const createdAt = options.clock?.() ?? new Date();
  const lifetimeSeconds = memberLinkContract.recordLifetimeSeconds[input.kind];
  const expiresAt = new Date(createdAt.getTime() + lifetimeSeconds * 1_000);

  for (let attempt = 0; attempt < recoveryCollisionAttempts; attempt += 1) {
    const recordId = operatorId("member_link", options.randomBytes);
    const bearer = createMemberLinkBearer(options.randomBytes);
    const tokenDigest = await digestMemberLinkBearer(bearer);
    if (!tokenDigest) throw new OperatorIdentityError("INVALID_RECOVERY_INPUT");

    const request = {
      createdAt,
      expiresAt,
      recordId,
      target,
      tokenDigest,
      workspaceReference: reference,
    } as const;
    const outcome = await repository.issueRecovery(request);
    if (outcome.outcome === "collision") continue;
    if (outcome.outcome !== "created") throw recoveryFailure(outcome);

    const url = new URL(
      input.kind === "invite" ? "/admin/accept/invite" : "/admin/accept/reset",
      origin,
    );
    url.hash = bearer;
    try {
      await deliver({
        expiresAt,
        kind: input.kind,
        recordId,
        url: url.href,
        workspaceId: outcome.workspaceId,
      });
    } catch {
      try {
        await repository.revokeUndeliveredRecovery(request);
      } catch {
        throw new OperatorIdentityError("RECOVERY_CLEANUP_FAILED");
      }
      throw new OperatorIdentityError("RECOVERY_DELIVERY_FAILED");
    }

    return Object.freeze({
      expiresAt: expiresAt.toISOString(),
      kind: input.kind,
      outcome: "created" as const,
      recordId,
      workspaceId: outcome.workspaceId,
    });
  }

  throw new OperatorIdentityError("RECOVERY_COLLISION_EXHAUSTED");
}
