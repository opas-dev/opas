// ABOUTME: Verifies the fixed team capability matrix and protected mutation contract.
// ABOUTME: Guards the independent-approval rule for every role, including administrators.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizationError,
  capabilities,
  capabilitiesForRole,
  capabilityForMutation,
  protectedMutationCapabilities,
  protectedMutations,
  requireIndependentApproval,
  requireMutationCapability,
  teamRoles,
  type Capability,
  type TeamRole,
} from "@/auth/capabilities";

const expectedCapabilities: Record<TeamRole, readonly Capability[]> = {
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
};

test("roles have exactly the documented fixed capability sets", () => {
  assert.deepEqual(teamRoles, ["administrator", "editor", "reviewer"]);

  for (const role of teamRoles) {
    assert.deepEqual(capabilitiesForRole(role), expectedCapabilities[role], role);
  }
});

test("every Phase 16 protected mutation maps to exactly one documented capability", () => {
  assert.deepEqual(
    Object.keys(protectedMutationCapabilities).sort(),
    [...protectedMutations].sort(),
  );

  for (const mutation of protectedMutations) {
    const capability = capabilityForMutation(mutation);
    assert.ok(capabilities.includes(capability), `${mutation} maps to a documented capability`);
  }
});

test("protected mutations reject roles without their required capability", () => {
  for (const role of teamRoles) {
    for (const mutation of protectedMutations) {
      const capability = capabilityForMutation(mutation);
      const canPerformMutation = expectedCapabilities[role].includes(capability);

      if (canPerformMutation) {
        assert.doesNotThrow(() => requireMutationCapability(role, mutation), `${role}: ${mutation}`);
      } else {
        assert.throws(
          () => requireMutationCapability(role, mutation),
          (error: unknown) =>
            error instanceof AuthorizationError && error.code === "CAPABILITY_REQUIRED",
          `${role}: ${mutation}`,
        );
      }
    }
  }
});

test("normal approval requires a member other than both the creator and submitter", () => {
  assert.doesNotThrow(() => requireIndependentApproval("reviewer-2", "editor-1", "editor-1"));
  assert.doesNotThrow(() => requireIndependentApproval("administrator-2", "editor-1", null));

  for (const administratorId of ["administrator-1", "administrator-2"]) {
    assert.throws(
      () => requireIndependentApproval(administratorId, administratorId, "editor-1"),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "SELF_APPROVAL_FORBIDDEN",
    );
    assert.throws(
      () => requireIndependentApproval(administratorId, "editor-1", administratorId),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "SELF_APPROVAL_FORBIDDEN",
    );
  }

  assert.throws(
    () => requireIndependentApproval("reviewer-1", "reviewer-1", "editor-1"),
    (error: unknown) => error instanceof AuthorizationError && error.code === "SELF_APPROVAL_FORBIDDEN",
  );
});
