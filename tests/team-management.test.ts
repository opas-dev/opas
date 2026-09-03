// ABOUTME: Verifies safe team listing, one-time link issuance, and administrator member mutations.
// ABOUTME: Proves validation, fixed lifetimes, fragment-only bearers, and bounded repository failures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  digestMemberLinkBearer,
  type MemberLinkKind,
} from "@/auth/member-link-claims";
import type {
  CredentialResetIssue,
  InvitationIssue,
  MemberActor,
  MemberMutationOutcome,
  MemberRepository,
  MemberRoleChange,
  MemberStatusChange,
  TeamMemberRecord,
} from "@/auth/member-repository";
import type { RandomBytes } from "@/auth/security-encoding";
import {
  changeTeamMemberRole,
  changeTeamMemberStatus,
  issueTeamCredentialReset,
  issueTeamInvitation,
  listTeamMembers,
  normalizeTeamMemberEmail,
  type TeamManagementDependencies,
} from "@/auth/team-management";

const now = new Date("2026-09-03T14:00:00.000Z");
const hour = 60 * 60 * 1_000;
const actor: MemberActor = Object.freeze({
  memberId: "administrator_one",
  sessionId: "A".repeat(43),
  workspaceId: "workspace_one",
});

type RepositoryCalls = {
  invitation: InvitationIssue[];
  list: Array<Parameters<MemberRepository["listMembers"]>[0]>;
  reset: CredentialResetIssue[];
  role: MemberRoleChange[];
  status: MemberStatusChange[];
};

function member(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
  return Object.freeze({
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    displayName: "Ada Admin",
    email: "ada@example.test",
    lastLoginAt: new Date("2026-09-03T12:00:00.000Z"),
    memberId: "administrator_one",
    role: "administrator",
    status: "active",
    updatedAt: new Date("2026-08-02T09:00:00.000Z"),
    ...overrides,
  });
}

function repository(
  outcomes: Readonly<{
    invitation?: MemberMutationOutcome;
    list?: readonly TeamMemberRecord[] | null;
    reset?: MemberMutationOutcome;
    role?: MemberMutationOutcome;
    status?: MemberMutationOutcome;
    throws?: boolean;
  }> = {},
) {
  const calls: RepositoryCalls = {
    invitation: [],
    list: [],
    reset: [],
    role: [],
    status: [],
  };
  const fail = () => {
    if (outcomes.throws) throw new Error("database secret must not escape");
  };
  const result = {
    async changeMemberRole(request: MemberRoleChange) {
      calls.role.push(request);
      fail();
      return outcomes.role ?? "changed";
    },
    async changeMemberStatus(request: MemberStatusChange) {
      calls.status.push(request);
      fail();
      return outcomes.status ?? "changed";
    },
    async listMembers(request: Parameters<MemberRepository["listMembers"]>[0]) {
      calls.list.push(request);
      fail();
      return outcomes.list === undefined ? [member()] : outcomes.list;
    },
    async replaceCredentialReset(request: CredentialResetIssue) {
      calls.reset.push(request);
      fail();
      return outcomes.reset ?? "changed";
    },
    async replaceInvitation(request: InvitationIssue) {
      calls.invitation.push(request);
      fail();
      return outcomes.invitation ?? "changed";
    },
  } as MemberRepository;

  return { calls, repository: result };
}

function dependencies(
  memberRepository: MemberRepository,
  randomBytes?: RandomBytes,
): TeamManagementDependencies {
  return Object.freeze({
    clock: () => new Date(now),
    randomBytes,
    repository: memberRepository,
  });
}

function sequentialBytes(...bytes: number[]): RandomBytes {
  let index = 0;
  return (length) => new Uint8Array(length).fill(bytes[index++] ?? 255);
}

test("team member email normalization accepts one bounded address and rejects invalid input", () => {
  assert.equal(
    normalizeTeamMemberEmail("  Ada.Example+Docs@Example.TEST  "),
    "ada.example+docs@example.test",
  );

  for (const value of [
    null,
    "",
    "missing-at.example.test",
    "missing-domain@",
    "space in@example.test",
    "nul\u0000@example.test",
    `${"a".repeat(310)}@example.test`,
    `${"a".repeat(1_281)}@example.test`,
  ]) {
    assert.equal(normalizeTeamMemberEmail(value), null, String(value).slice(0, 40));
  }
});

test("administrator invitation stores only a digest and returns the exact fragment URL", async () => {
  const state = repository();
  const result = await issueTeamInvitation(
    {
      actor,
      email: "  Editor@Example.TEST ",
      role: "editor",
      siteOrigin: "https://demo.opas.dev",
    },
    dependencies(state.repository, sequentialBytes(1, 2)),
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  const url = new URL(result.url);
  const bearer = url.hash.slice(1);
  assert.equal(url.origin, "https://demo.opas.dev");
  assert.equal(url.pathname, "/admin/accept/invite");
  assert.equal(url.search, "");
  assert.match(bearer, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(result.expiresAt, "2026-09-05T14:00:00.000Z");
  assert.equal(result.kind, "invite");
  assert.equal(state.calls.invitation.length, 1);
  assert.deepEqual(state.calls.invitation[0], {
    actor,
    createdAt: now,
    email: "editor@example.test",
    expiresAt: new Date(now.getTime() + 48 * hour),
    id: "member_link_AgICAgICAgICAgICAgICAgIC",
    role: "editor",
    tokenDigest: await digestMemberLinkBearer(bearer),
  });
  assert.equal(JSON.stringify(state.calls.invitation).includes(bearer), false);
  assert.equal(JSON.stringify(state.calls.invitation).includes(encodeURIComponent(bearer)), false);
});

test("credential reset stores only a digest and returns a one-hour reset fragment", async () => {
  const state = repository();
  const result = await issueTeamCredentialReset(
    {
      actor,
      memberId: "editor_one",
      siteOrigin: "http://localhost:3000",
    },
    dependencies(state.repository, sequentialBytes(3, 4)),
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  const url = new URL(result.url);
  const bearer = url.hash.slice(1);
  assert.equal(url.href, `http://localhost:3000/admin/accept/reset#${bearer}`);
  assert.equal(result.expiresAt, "2026-09-03T15:00:00.000Z");
  assert.equal(result.kind, "credential_reset");
  assert.equal(state.calls.reset.length, 1);
  assert.deepEqual(state.calls.reset[0], {
    actor,
    createdAt: now,
    expiresAt: new Date(now.getTime() + hour),
    id: "member_link_BAQEBAQEBAQEBAQEBAQEBAQE",
    memberId: "editor_one",
    tokenDigest: await digestMemberLinkBearer(bearer),
  });
  assert.equal(JSON.stringify(state.calls.reset).includes(bearer), false);
});

test("replacement issuance always delegates to the atomic replacement operations", async () => {
  const state = repository();
  const randomBytes = sequentialBytes(5, 6, 7, 8, 9, 10, 11, 12);

  for (let index = 0; index < 2; index += 1) {
    assert.equal(
      (
        await issueTeamInvitation(
          {
            actor,
            email: "same@example.test",
            role: "reviewer",
            siteOrigin: "https://demo.opas.dev",
          },
          dependencies(state.repository, randomBytes),
        )
      ).outcome,
      "created",
    );
    assert.equal(
      (
        await issueTeamCredentialReset(
          {
            actor,
            memberId: "same_member",
            siteOrigin: "https://demo.opas.dev",
          },
          dependencies(state.repository, randomBytes),
        )
      ).outcome,
      "created",
    );
  }

  assert.equal(state.calls.invitation.length, 2);
  assert.equal(state.calls.reset.length, 2);
  assert.notEqual(state.calls.invitation[0]?.tokenDigest, state.calls.invitation[1]?.tokenDigest);
  assert.notEqual(state.calls.reset[0]?.tokenDigest, state.calls.reset[1]?.tokenDigest);
});

test("invitation and reset inputs reject invalid values before persistence", async () => {
  const state = repository();
  const invalidInvitationInputs = [
    { email: "bad", role: "editor", siteOrigin: "https://demo.opas.dev", field: "email" },
    {
      email: "valid@example.test",
      role: "owner",
      siteOrigin: "https://demo.opas.dev",
      field: "role",
    },
    {
      email: "valid@example.test",
      role: "editor",
      siteOrigin: "https://demo.opas.dev/path",
      field: "site",
    },
  ] as const;

  for (const input of invalidInvitationInputs) {
    assert.deepEqual(
      await issueTeamInvitation({ actor, ...input }, dependencies(state.repository)),
      { field: input.field, outcome: "invalid" },
    );
  }
  assert.deepEqual(
    await issueTeamCredentialReset(
      { actor, memberId: "not/valid", siteOrigin: "https://demo.opas.dev" },
      dependencies(state.repository),
    ),
    { field: "member", outcome: "invalid" },
  );
  assert.deepEqual(
    await issueTeamCredentialReset(
      { actor, memberId: "member_one", siteOrigin: "https://demo.opas.dev?leak=yes" },
      dependencies(state.repository),
    ),
    { field: "site", outcome: "invalid" },
  );
  assert.equal(state.calls.invitation.length, 0);
  assert.equal(state.calls.reset.length, 0);
});

test("all and only the fixed roles can be issued", async () => {
  const state = repository();
  const randomBytes = sequentialBytes(10, 11, 12, 13, 14, 15);

  for (const role of ["administrator", "editor", "reviewer"] as const) {
    const result = await issueTeamInvitation(
      {
        actor,
        email: `${role}@example.test`,
        role,
        siteOrigin: "https://demo.opas.dev",
      },
      dependencies(state.repository, randomBytes),
    );
    assert.equal(result.outcome, "created");
  }

  assert.deepEqual(state.calls.invitation.map((request) => request.role), [
    "administrator",
    "editor",
    "reviewer",
  ]);
});

test("team listing returns safe serialized records and preserves repository authorization", async () => {
  const state = repository({
    list: [
      member(),
      member({
        displayName: "Ed Editor",
        email: "ed@example.test",
        lastLoginAt: null,
        memberId: "editor_one",
        role: "editor",
      }),
    ],
  });
  const result = await listTeamMembers(actor, dependencies(state.repository));

  assert.deepEqual(result, {
    members: [
      {
        createdAt: "2026-08-01T09:00:00.000Z",
        displayName: "Ada Admin",
        email: "ada@example.test",
        lastLoginAt: "2026-09-03T12:00:00.000Z",
        memberId: "administrator_one",
        role: "administrator",
        status: "active",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      {
        createdAt: "2026-08-01T09:00:00.000Z",
        displayName: "Ed Editor",
        email: "ed@example.test",
        lastLoginAt: null,
        memberId: "editor_one",
        role: "editor",
        status: "active",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
    ],
    outcome: "listed",
  });
  assert.equal(JSON.stringify(result).includes("password"), false);
  assert.equal(JSON.stringify(result).includes("workspace_one"), false);
  assert.deepEqual(state.calls.list, [{ ...actor, checkedAt: now }]);

  const forbidden = repository({ list: null });
  assert.deepEqual(
    await listTeamMembers(actor, dependencies(forbidden.repository)),
    { outcome: "forbidden" },
  );
});

test("malformed stored records and repository errors collapse to unavailable", async () => {
  const malformed = repository({ list: [member({ email: "not-an-email" })] });
  assert.deepEqual(
    await listTeamMembers(actor, dependencies(malformed.repository)),
    { outcome: "unavailable" },
  );

  const failed = repository({ throws: true });
  assert.deepEqual(
    await issueTeamInvitation(
      {
        actor,
        email: "editor@example.test",
        role: "editor",
        siteOrigin: "https://demo.opas.dev",
      },
      dependencies(failed.repository, sequentialBytes(1, 2)),
    ),
    { outcome: "unavailable" },
  );
  assert.deepEqual(
    await changeTeamMemberRole(
      { actor, memberId: "editor_one", role: "reviewer" },
      dependencies(failed.repository),
    ),
    { outcome: "unavailable" },
  );
});

test("member changes preserve every bounded repository outcome", async () => {
  const outcomes: readonly MemberMutationOutcome[] = [
    "changed",
    "conflict",
    "forbidden",
    "last_administrator",
    "not_found",
    "unchanged",
  ];

  for (const outcome of outcomes) {
    const state = repository({ role: outcome, status: outcome });
    assert.deepEqual(
      await changeTeamMemberRole(
        { actor, memberId: "another_member", role: "reviewer" },
        dependencies(state.repository),
      ),
      { outcome },
    );
    assert.deepEqual(
      await changeTeamMemberStatus(
        { actor, memberId: "another_member", status: "disabled" },
        dependencies(state.repository),
      ),
      { outcome },
    );
    assert.deepEqual(state.calls.role[0], {
      actor,
      changedAt: now,
      memberId: "another_member",
      role: "reviewer",
    });
    assert.deepEqual(state.calls.status[0], {
      actor,
      changedAt: now,
      memberId: "another_member",
      status: "disabled",
    });
  }
});

test("invalid mutations and malformed actors do not reach persistence", async () => {
  const state = repository();
  assert.deepEqual(
    await changeTeamMemberRole(
      { actor, memberId: "editor_one", role: "owner" },
      dependencies(state.repository),
    ),
    { field: "role", outcome: "invalid" },
  );
  assert.deepEqual(
    await changeTeamMemberStatus(
      { actor, memberId: "editor_one", status: "removed" },
      dependencies(state.repository),
    ),
    { field: "status", outcome: "invalid" },
  );
  const malformedActor = { ...actor, sessionId: "short" };
  assert.deepEqual(
    await listTeamMembers(malformedActor, dependencies(state.repository)),
    { outcome: "forbidden" },
  );
  assert.deepEqual(
    await issueTeamCredentialReset(
      { actor: malformedActor, memberId: "editor_one", siteOrigin: "https://demo.opas.dev" },
      dependencies(state.repository),
    ),
    { outcome: "forbidden" },
  );
  assert.equal(state.calls.list.length, 0);
  assert.equal(state.calls.reset.length, 0);
  assert.equal(state.calls.role.length, 0);
  assert.equal(state.calls.status.length, 0);
});

test("link authorization and target failures remain bounded and never include a bearer", async () => {
  for (const [kind, outcome] of [
    ["invite", "conflict"],
    ["invite", "forbidden"],
    ["credential_reset", "forbidden"],
    ["credential_reset", "not_found"],
  ] as const satisfies readonly [MemberLinkKind, MemberMutationOutcome][]) {
    const state = repository({
      invitation: kind === "invite" ? outcome : undefined,
      reset: kind === "credential_reset" ? outcome : undefined,
    });
    const result =
      kind === "invite"
        ? await issueTeamInvitation(
            {
              actor,
              email: "editor@example.test",
              role: "editor",
              siteOrigin: "https://demo.opas.dev",
            },
            dependencies(state.repository, sequentialBytes(20, 21)),
          )
        : await issueTeamCredentialReset(
            {
              actor,
              memberId: "editor_one",
              siteOrigin: "https://demo.opas.dev",
            },
            dependencies(state.repository, sequentialBytes(20, 21)),
          );

    assert.deepEqual(result, { outcome });
    assert.equal(JSON.stringify(result).includes("#"), false);
    assert.equal(JSON.stringify(result).includes("token"), false);
  }
});

test("team management has no bearer logging or durable browser-storage path", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/auth/team-management.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(source, /[?&](?:token|bearer)=/u);
  assert.match(source, /url\.hash = bearer/u);
});
