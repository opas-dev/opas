// ABOUTME: Parses team form submissions and maps domain outcomes to bounded administrator feedback.
// ABOUTME: Keeps untrusted form fields and one-time link results out of the Next.js action shell.

import type { MemberActor, MemberRepository } from "@/auth/member-repository";
import {
  changeTeamMemberRole,
  changeTeamMemberStatus,
  issueTeamCredentialReset,
  issueTeamInvitation,
} from "@/auth/team-management";
import type { TeamActionState } from "@/app/admin/team/contracts";

export type TeamActionDependencies = Readonly<{
  actor: MemberActor;
  repository: MemberRepository;
  revalidateTeam?: () => void;
  siteOrigin: string;
}>;

function state(
  status: TeamActionState["status"],
  message: string,
  options: Pick<TeamActionState, "fieldErrors" | "link"> = {},
): TeamActionState {
  return Object.freeze({ status, message, ...options });
}

export function unavailableTeamAction(): TeamActionState {
  return state("error", "Team settings are unavailable. Try again.");
}

function exactFields(
  formData: FormData,
  names: readonly string[],
): Readonly<Record<string, FormDataEntryValue>> | null {
  const keys = [...formData.keys()];
  if (
    keys.length !== names.length ||
    names.some((name) => formData.getAll(name).length !== 1) ||
    keys.some((key) => !names.includes(key))
  ) {
    return null;
  }

  return Object.freeze(
    Object.fromEntries(names.map((name) => [name, formData.get(name)!])),
  );
}

function textField(
  record: Readonly<Record<string, FormDataEntryValue>>,
  name: string,
): string | null {
  const value = record[name];
  return typeof value === "string" ? value : null;
}

function linkResult(
  result: Awaited<ReturnType<typeof issueTeamInvitation>>,
  task: "invitation" | "reset",
): TeamActionState {
  if (result.outcome === "created") {
    return state(
      "success",
      task === "invitation"
        ? "Invitation created. Copy it now; OPAS cannot show it again."
        : "Reset link created and active sessions ended. Copy it now; OPAS cannot show it again.",
      {
        link: Object.freeze({
          expiresAt: result.expiresAt,
          kind: result.kind,
          url: result.url,
        }),
      },
    );
  }
  if (result.outcome === "invalid") {
    const field = result.field === "member" ? "member" : result.field;
    const message =
      result.field === "email"
        ? "Enter a valid email address."
        : result.field === "role"
          ? "Choose one of the available roles."
          : result.field === "member"
            ? "That team member is invalid."
            : "The configured site address is invalid.";
    return state("error", message, {
      fieldErrors: field === "site" ? undefined : { [field]: message },
    });
  }
  if (result.outcome === "conflict") {
    return state("error", "That email already belongs to this team.", {
      fieldErrors: { email: "Choose an email that is not already a member." },
    });
  }
  if (result.outcome === "not_found") {
    return state("error", "That team member no longer exists. Reload and try again.");
  }
  if (result.outcome === "forbidden") {
    return state("error", "This team change is no longer allowed. Reload and try again.");
  }
  return unavailableTeamAction();
}

function mutationResult(
  result: Awaited<ReturnType<typeof changeTeamMemberRole>>,
  task: "disable" | "reactivate" | "role",
  revalidateTeam?: () => void,
): TeamActionState {
  if (result.outcome === "changed") {
    revalidateTeam?.();
    return state(
      "success",
      task === "role"
        ? "Role changed. Existing sessions were ended."
        : task === "disable"
          ? "Access disabled. Active sessions and this member's shared previews were revoked."
          : "Access reactivated. They can sign in with their current credentials.",
    );
  }
  if (result.outcome === "unchanged") {
    return state("success", "No change was needed.");
  }
  if (result.outcome === "invalid") {
    const message =
      result.field === "role"
        ? "Choose one of the available roles."
        : result.field === "status"
          ? "Choose a valid access state."
          : "That team member is invalid.";
    return state("error", message, {
      fieldErrors: result.field === "status" ? undefined : { [result.field]: message },
    });
  }
  if (result.outcome === "last_administrator") {
    return state("error", "Keep at least one active administrator in the workspace.");
  }
  if (result.outcome === "not_found") {
    return state("error", "That team member no longer exists. Reload and try again.");
  }
  if (result.outcome === "forbidden") {
    return state("error", "You cannot change your own access or role.");
  }
  if (result.outcome === "conflict") {
    return state("error", "The team changed at the same time. Reload and try again.");
  }
  return unavailableTeamAction();
}

export async function runInvitationAction(
  formData: FormData,
  dependencies: TeamActionDependencies,
): Promise<TeamActionState> {
  const fields = exactFields(formData, ["email", "role"]);
  if (!fields) return state("error", "The invitation request is invalid.");

  return linkResult(
    await issueTeamInvitation(
      {
        actor: dependencies.actor,
        email: textField(fields, "email"),
        role: textField(fields, "role"),
        siteOrigin: dependencies.siteOrigin,
      },
      dependencies,
    ),
    "invitation",
  );
}

export async function runMemberAction(
  formData: FormData,
  dependencies: TeamActionDependencies,
): Promise<TeamActionState> {
  const intentValue = formData.get("intent");
  const intent = typeof intentValue === "string" ? intentValue : null;
  const expectedFields =
    intent === "change-role"
      ? (["intent", "memberId", "role"] as const)
      : intent === "disable" || intent === "reactivate" || intent === "reset"
        ? (["intent", "memberId"] as const)
        : null;
  if (!expectedFields) return state("error", "The team request is invalid.");
  const fields = exactFields(formData, expectedFields);
  if (!fields) return state("error", "The team request is invalid.");
  const memberId = textField(fields, "memberId");

  if (intent === "reset") {
    return linkResult(
      await issueTeamCredentialReset(
        {
          actor: dependencies.actor,
          memberId,
          siteOrigin: dependencies.siteOrigin,
        },
        dependencies,
      ),
      "reset",
    );
  }
  if (intent === "change-role") {
    return mutationResult(
      await changeTeamMemberRole(
        {
          actor: dependencies.actor,
          memberId,
          role: textField(fields, "role"),
        },
        dependencies,
      ),
      "role",
      dependencies.revalidateTeam,
    );
  }

  return mutationResult(
    await changeTeamMemberStatus(
      {
        actor: dependencies.actor,
        memberId,
        status: intent === "disable" ? "disabled" : "active",
      },
      dependencies,
    ),
    intent === "disable" ? "disable" : "reactivate",
    dependencies.revalidateTeam,
  );
}
