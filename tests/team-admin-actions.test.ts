// ABOUTME: Verifies the administrator team action boundary validates exact form shapes and returns bounded results.
// ABOUTME: Confirms capability checks stay server-side and one-time bearers only appear in explicit fragment results.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runInvitationAction,
  runMemberAction,
} from "@/app/admin/team/action-runtime";
import type {
  InvitationIssue,
  MemberActor,
  MemberRepository,
  MemberRoleChange,
  MemberStatusChange,
} from "@/auth/member-repository";

const actor: MemberActor = Object.freeze({
  memberId: "admin_one",
  sessionId: "A".repeat(43),
  workspaceId: "workspace_one",
});

function repository(outcome: "changed" | "forbidden" | "last_administrator" = "changed") {
  const invitations: InvitationIssue[] = [];
  const roles: MemberRoleChange[] = [];
  const statuses: MemberStatusChange[] = [];
  const value = {
    async changeMemberRole(request: MemberRoleChange) {
      roles.push(request);
      return outcome;
    },
    async changeMemberStatus(request: MemberStatusChange) {
      statuses.push(request);
      return outcome;
    },
    async replaceInvitation(request: InvitationIssue) {
      invitations.push(request);
      return outcome;
    },
  } as MemberRepository;
  return { invitations, repository: value, roles, statuses };
}

test("invitation action accepts only the exact bounded form and returns a fragment link once", async () => {
  const state = repository();
  const formData = new FormData();
  formData.set("email", "  Editor@Example.TEST ");
  formData.set("role", "editor");
  const result = await runInvitationAction(formData, {
    actor,
    repository: state.repository,
    siteOrigin: "https://demo.opas.dev",
  });

  assert.equal(result.status, "success");
  assert.equal(result.link?.kind, "invite");
  assert.match(result.link?.url ?? "", /^https:\/\/demo\.opas\.dev\/admin\/accept\/invite#[A-Za-z0-9_-]{43}$/u);
  assert.equal(new URL(result.link?.url ?? "https://invalid.test").search, "");
  assert.equal(state.invitations[0]?.email, "editor@example.test");
  const bearer = result.link?.url.split("#")[1] ?? "";
  assert.equal(JSON.stringify(state.invitations).includes(bearer), false);

  formData.set("unexpected", "value");
  assert.deepEqual(
    await runInvitationAction(formData, {
      actor,
      repository: state.repository,
      siteOrigin: "https://demo.opas.dev",
    }),
    { message: "The invitation request is invalid.", status: "error" },
  );
  assert.equal(state.invitations.length, 1);
});

test("member actions strictly parse intent, revalidate changes, and preserve repository outcomes", async () => {
  const state = repository();
  let revalidations = 0;
  const role = new FormData();
  role.set("intent", "change-role");
  role.set("memberId", "editor_one");
  role.set("role", "reviewer");
  const changed = await runMemberAction(role, {
    actor,
    repository: state.repository,
    revalidateTeam: () => revalidations += 1,
    siteOrigin: "https://demo.opas.dev",
  });
  assert.equal(changed.message, "Role changed. Existing sessions were ended.");
  assert.equal(revalidations, 1);
  assert.equal(state.roles[0]?.memberId, "editor_one");

  const disabled = new FormData();
  disabled.set("intent", "disable");
  disabled.set("memberId", "editor_one");
  assert.match(
    (await runMemberAction(disabled, {
      actor,
      repository: state.repository,
      revalidateTeam: () => revalidations += 1,
      siteOrigin: "https://demo.opas.dev",
    })).message,
    /sessions.*preview/u,
  );
  assert.equal(state.statuses[0]?.status, "disabled");
  assert.equal(revalidations, 2);

  const malformed = new FormData();
  malformed.set("intent", "disable");
  malformed.set("memberId", "editor_one");
  malformed.set("role", "administrator");
  assert.equal((await runMemberAction(malformed, {
    actor,
    repository: state.repository,
    siteOrigin: "https://demo.opas.dev",
  })).status, "error");
  assert.equal(state.statuses.length, 1);

  for (const [outcome, message] of [
    ["forbidden", "You cannot change your own access or role."],
    ["last_administrator", "Keep at least one active administrator in the workspace."],
  ] as const) {
    assert.equal((await runMemberAction(role, {
      actor,
      repository: repository(outcome).repository,
      siteOrigin: "https://demo.opas.dev",
    })).message, message);
  }
});

test("team route and actions require member management capability without bearer side channels", async () => {
  const [actions, page, client] = await Promise.all([
    readFile(new URL("../src/app/admin/team/actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/team/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/team/team-console.tsx", import.meta.url), "utf8"),
  ]);

  assert.equal(actions.match(/requireMemberCapability\("member:manage", demoIds\.workspace\)/gu)?.length, 2);
  assert.match(
    page,
    /requireMemberCapability\(\s*"member:manage",\s*demoIds\.workspace/u,
  );
  assert.match(page, /listTeamMembers\(administrator/u);
  assert.doesNotMatch(`${actions}\n${page}`, /console\.|searchParams/u);
  assert.doesNotMatch(client, /useActionState|localStorage|sessionStorage|indexedDB|console\./u);
  assert.match(client, /submitting\.current/u);
  assert.match(client, /navigator\.clipboard\.writeText\(link\.url\)/u);
});
