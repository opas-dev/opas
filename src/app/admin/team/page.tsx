// ABOUTME: Presents the administrator-only team roster and named-member management controls.
// ABOUTME: Rechecks database authorization before passing safe member views to the client surface.
import type { Metadata } from "next";

import {
  createTeamInvitationAction,
  manageTeamMemberAction,
} from "@/app/admin/team/actions";
import { TeamConsole } from "@/app/admin/team/team-console";
import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { getMemberRepository } from "@/auth/member-database";
import { listTeamMembers } from "@/auth/team-management";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Team",
  description: "Manage named access to the OPAS workspace.",
};

export default async function TeamAdminPage() {
  const administrator = await requireMemberCapability("member:manage", demoIds.workspace);
  const result = await listTeamMembers(administrator, {
    repository: await getMemberRepository(),
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader member={administrator} active="team" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="max-w-3xl border-b border-border pb-8">
          <p className="m-0 text-sm font-semibold text-primary">Workspace access</p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            Give each teammate the access they need.
          </h1>
          <p className="mb-0 mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">
            Invite named members, keep roles small, and remove access without losing attribution.
            Every role or status change takes effect on the next request.
          </p>
        </div>

        {result.outcome === "listed" ? (
          <TeamConsole
            createInvitation={createTeamInvitationAction}
            currentMemberId={administrator.memberId}
            manageMember={manageTeamMemberAction}
            members={result.members}
          />
        ) : (
          <section className="mt-10 rounded-lg border border-danger bg-surface p-6" role="alert">
            <h2 className="m-0 text-lg font-semibold">Team settings are unavailable</h2>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              Your session or workspace access changed. Reload this page or sign in again.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
