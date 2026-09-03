// ABOUTME: Verifies the team console renders accessible roster controls and transient one-time link handling.
// ABOUTME: Covers current-member safeguards, status clarity, destructive confirmation, and responsive form semantics.

import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { OneTimeLink, TeamConsole } from "@/app/admin/team/team-console";
import type { TeamAction } from "@/app/admin/team/contracts";
import type { TeamMemberView } from "@/auth/team-management";

const action: TeamAction = async () => ({ message: "Done.", status: "success" });
const members: readonly TeamMemberView[] = [
  {
    createdAt: "2026-08-01T09:00:00.000Z",
    displayName: "Ada Admin",
    email: "ada@example.test",
    lastLoginAt: "2026-09-03T12:00:00.000Z",
    memberId: "admin_one",
    role: "administrator",
    status: "active",
    updatedAt: "2026-09-03T12:00:00.000Z",
  },
  {
    createdAt: "2026-08-02T09:00:00.000Z",
    displayName: "Eli Editor",
    email: "eli@example.test",
    lastLoginAt: null,
    memberId: "editor_one",
    role: "editor",
    status: "disabled",
    updatedAt: "2026-09-03T12:00:00.000Z",
  },
];

test("team console exposes labeled fixed-role controls and protects the current member", () => {
  const markup = renderToStaticMarkup(
    <TeamConsole
      createInvitation={action}
      currentMemberId="admin_one"
      manageMember={action}
      members={members}
    />,
  );

  assert.match(markup, /<section[^>]+aria-labelledby="invite-member-heading"/u);
  assert.match(markup, /type="email"[^>]+required=""[^>]+maxLength="320"/u);
  assert.match(markup, /<option value="editor" selected="">Editor<\/option>/u);
  assert.match(markup, /<ul[^>]+list-none/u);
  assert.match(markup, /Ada Admin[\s\S]*You[\s\S]*Ask another administrator/u);
  assert.doesNotMatch(markup, /name="memberId" value="admin_one"/u);
  assert.match(markup, /Eli Editor[\s\S]*Disabled[\s\S]*Never signed in/u);
  assert.match(markup, /Reactivate access/u);
  assert.match(markup, /Create reset link[\s\S]*expires after one hour/u);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML/u);
});

test("one-time bearer renders as a read-only copy field, never a navigable link", () => {
  const url = "https://demo.opas.dev/admin/accept/reset#SECRET_BEARER";
  const markup = renderToStaticMarkup(
    <OneTimeLink
      id="one-time-result"
      link={{
        expiresAt: "2026-09-03T15:00:00.000Z",
        kind: "credential_reset",
        url,
      }}
    />,
  );

  assert.match(markup, /Credential reset link/u);
  assert.match(markup, /value="https:\/\/demo\.opas\.dev\/admin\/accept\/reset#SECRET_BEARER"/u);
  assert.match(markup, /readOnly=""/u);
  assert.match(markup, /Copy link/u);
  assert.match(markup, /Visible once/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.doesNotMatch(markup, /<a\b|href=|\?SECRET_BEARER/u);
});
