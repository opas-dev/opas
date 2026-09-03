// ABOUTME: Exposes administrator-authorized Server Actions for team invitations and member changes.
// ABOUTME: Resolves actor and workspace identity on the server before invoking the bounded action runtime.
"use server";

import { revalidatePath } from "next/cache";

import {
  runInvitationAction,
  runMemberAction,
  unavailableTeamAction,
  type TeamActionDependencies,
} from "@/app/admin/team/action-runtime";
import type { TeamActionState } from "@/app/admin/team/contracts";
import { requireMemberCapability } from "@/auth/admin";
import { getMemberRepository } from "@/auth/member-database";
import type { MemberActor } from "@/auth/member-repository";
import { demoIds } from "@/db/demo";
import { resolveSiteOrigin } from "@/site";

async function teamDependencies(actor: MemberActor): Promise<TeamActionDependencies> {
  return {
    actor,
    repository: await getMemberRepository(),
    revalidateTeam: () => revalidatePath("/admin/team"),
    siteOrigin: resolveSiteOrigin(),
  };
}

export async function createTeamInvitationAction(
  formData: FormData,
): Promise<TeamActionState> {
  const actor = await requireMemberCapability("member:manage", demoIds.workspace);
  try {
    return await runInvitationAction(formData, await teamDependencies(actor));
  } catch {
    return unavailableTeamAction();
  }
}

export async function manageTeamMemberAction(
  formData: FormData,
): Promise<TeamActionState> {
  const actor = await requireMemberCapability("member:manage", demoIds.workspace);
  try {
    return await runMemberAction(formData, await teamDependencies(actor));
  } catch {
    return unavailableTeamAction();
  }
}
