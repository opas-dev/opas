// ABOUTME: Renders the responsive team roster, invitation form, and per-member access controls.
// ABOUTME: Keeps one-time links in transient component state with explicit copy feedback.
"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";

import type {
  TeamAction,
  TeamActionLink,
  TeamActionState,
} from "@/app/admin/team/contracts";
import type { TeamMemberView } from "@/auth/team-management";

type TeamConsoleProps = Readonly<{
  createInvitation: TeamAction;
  currentMemberId: string;
  manageMember: TeamAction;
  members: readonly TeamMemberView[];
}>;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function actionStatus(result: TeamActionState | null) {
  if (!result) return null;
  return (
    <p
      className={`m-0 rounded-md px-3 py-2 text-sm leading-5 ${
        result.status === "error"
          ? "bg-danger text-danger-foreground"
          : "bg-success text-success-foreground"
      }`}
      role={result.status === "error" ? "alert" : "status"}
      aria-live="polite"
      aria-atomic="true"
    >
      {result.message}
    </p>
  );
}

export function OneTimeLink({ id, link }: { id: string; link: TeamActionLink }) {
  const input = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [link.url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopyStatus("Copied to clipboard.");
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopyStatus("Select the link and copy it manually.");
    }
  }

  return (
    <div className="rounded-md border border-primary bg-secondary p-4">
      <label htmlFor={id} className="block text-sm font-semibold">
        {link.kind === "invite" ? "Invitation link" : "Credential reset link"}
      </label>
      <p className="mb-0 mt-1 text-xs leading-5 text-muted">
        Visible once · expires {dateFormatter.format(new Date(link.expiresAt))}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          ref={input}
          id={id}
          type="text"
          value={link.url}
          readOnly
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-background px-3 font-mono text-xs"
        />
        <button
          type="button"
          onClick={copyLink}
          className="min-h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Copy link
        </button>
      </div>
      <p className="mb-0 mt-2 min-h-5 text-xs font-medium text-muted" role="status" aria-live="polite">
        {copyStatus}
      </p>
    </div>
  );
}

function useTeamSubmission(action: TeamAction) {
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const [result, setResult] = useState<TeamActionState | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setResult(null);
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      try {
        setResult(await action(formData));
      } catch {
        setResult({
          message: "The request could not be completed. Reload and try again.",
          status: "error",
        });
      } finally {
        submitting.current = false;
      }
    });
  }

  return { pending, result, submit };
}

function InvitationPanel({ action }: { action: TeamAction }) {
  const { pending, result, submit } = useTeamSubmission(action);

  return (
    <section aria-labelledby="invite-member-heading" className="rounded-lg border border-border bg-surface p-5 sm:p-6">
      <div className="max-w-2xl">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
          Add a teammate
        </p>
        <h2 id="invite-member-heading" className="mb-0 mt-2 text-xl font-semibold tracking-[-0.02em]">
          Create a one-time invitation
        </h2>
        <p className="mb-0 mt-2 text-sm leading-6 text-muted">
          Share the link out of band. It expires after 48 hours and replaces any earlier invitation
          for the same email.
        </p>
      </div>

      <form onSubmit={submit} className="mt-6">
        <fieldset disabled={pending} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end">
          <legend className="sr-only">New team invitation</legend>
          <div>
            <label htmlFor="team-invite-email" className="block text-sm font-semibold">
              Email
            </label>
            <input
              id="team-invite-email"
              name="email"
              type="email"
              required
              maxLength={320}
              autoComplete="off"
              aria-invalid={Boolean(result?.fieldErrors?.email)}
              aria-describedby={result?.fieldErrors?.email ? "team-invite-email-error" : undefined}
              className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 aria-invalid:border-danger"
            />
            {result?.fieldErrors?.email ? (
              <p id="team-invite-email-error" className="mb-0 mt-1 text-sm text-danger">
                {result.fieldErrors.email}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="team-invite-role" className="block text-sm font-semibold">
              Role
            </label>
            <select
              id="team-invite-role"
              name="role"
              defaultValue="editor"
              aria-invalid={Boolean(result?.fieldErrors?.role)}
              aria-describedby={result?.fieldErrors?.role ? "team-invite-role-error" : undefined}
              className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 aria-invalid:border-danger"
            >
              <option value="editor">Editor</option>
              <option value="reviewer">Reviewer</option>
              <option value="administrator">Administrator</option>
            </select>
            {result?.fieldErrors?.role ? (
              <p id="team-invite-role-error" className="mb-0 mt-1 text-sm text-danger">
                {result.fieldErrors.role}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create invitation"}
          </button>
        </fieldset>
      </form>

      {result ? (
        <div className="mt-4 space-y-3">
          {actionStatus(result)}
          {result.link ? <OneTimeLink id="team-invitation-result" link={result.link} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function roleLabel(role: TeamMemberView["role"]) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function MemberPanel({
  action,
  current,
  member,
}: {
  action: TeamAction;
  current: boolean;
  member: TeamMemberView;
}) {
  const { pending, result, submit } = useTeamSubmission(action);
  const disabled = member.status === "disabled";

  return (
    <li
      className="rounded-lg border border-border bg-surface p-5 sm:p-6"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-lg font-semibold tracking-[-0.01em]">{member.displayName}</h3>
            {current ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">
                You
              </span>
            ) : null}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                disabled
                  ? "bg-surface-strong text-muted"
                  : "bg-success text-success-foreground"
              }`}
            >
              {disabled ? "Disabled" : "Active"}
            </span>
          </div>
          <p className="mb-0 mt-1 break-words text-sm text-muted">{member.email}</p>
          <p className="mb-0 mt-2 text-xs text-muted">
            {roleLabel(member.role)} · Joined {dateFormatter.format(new Date(member.createdAt))}
            {member.lastLoginAt
              ? ` · Last signed in ${dateFormatter.format(new Date(member.lastLoginAt))}`
              : " · Never signed in"}
          </p>
        </div>
      </div>

      {current ? (
        <p className="mb-0 mt-5 border-t border-border pt-4 text-sm leading-6 text-muted">
          Ask another administrator to change your role or access.
        </p>
      ) : (
        <div className="mt-5 grid gap-5 border-t border-border pt-5 lg:grid-cols-2">
          <form onSubmit={submit} className="space-y-3">
            <input type="hidden" name="intent" value="change-role" />
            <input type="hidden" name="memberId" value={member.memberId} />
            <label htmlFor={`team-role-${member.memberId}`} className="block text-sm font-semibold">
              Role
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                key={member.role}
                id={`team-role-${member.memberId}`}
                name="role"
                defaultValue={member.role}
                disabled={pending}
                aria-invalid={Boolean(result?.fieldErrors?.role)}
                aria-describedby={`${`team-role-note-${member.memberId}`}${
                  result?.fieldErrors?.role ? ` team-role-error-${member.memberId}` : ""
                }`}
                className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 aria-invalid:border-danger"
              >
                <option value="administrator">Administrator</option>
                <option value="editor">Editor</option>
                <option value="reviewer">Reviewer</option>
              </select>
              <button
                type="submit"
                disabled={pending}
                className="min-h-11 rounded-md border border-border-strong bg-background px-4 text-sm font-semibold disabled:cursor-wait disabled:opacity-60"
              >
                {pending ? "Saving…" : "Save role"}
              </button>
            </div>
            <p id={`team-role-note-${member.memberId}`} className="m-0 text-xs leading-5 text-muted">
              Changing a role ends this member&apos;s active sessions.
            </p>
            {result?.fieldErrors?.role ? (
              <p id={`team-role-error-${member.memberId}`} className="m-0 text-sm text-danger">
                {result.fieldErrors.role}
              </p>
            ) : null}
          </form>

          <div>
            <p className="m-0 text-sm font-semibold">Access and credentials</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {disabled ? (
                <form onSubmit={submit}>
                  <input type="hidden" name="intent" value="reactivate" />
                  <input type="hidden" name="memberId" value={member.memberId} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
                  >
                    {pending ? "Reactivating…" : "Reactivate access"}
                  </button>
                </form>
              ) : (
                <details className="rounded-md border border-border bg-background">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center px-4 text-sm font-semibold text-danger marker:hidden">
                    Disable access
                  </summary>
                  <form onSubmit={submit} className="border-t border-border p-3">
                    <input type="hidden" name="intent" value="disable" />
                    <input type="hidden" name="memberId" value={member.memberId} />
                    <p className="m-0 max-w-sm text-xs leading-5 text-muted">
                      Ends active sessions and preview links created by {member.displayName}.
                    </p>
                    <button
                      type="submit"
                      disabled={pending}
                      className="mt-3 min-h-11 rounded-md bg-danger px-4 text-sm font-semibold text-danger-foreground disabled:cursor-wait disabled:opacity-60"
                    >
                      {pending ? "Disabling…" : `Confirm disable ${member.displayName}`}
                    </button>
                  </form>
                </details>
              )}

              <details className="rounded-md border border-border bg-background">
                <summary className="flex min-h-11 cursor-pointer list-none items-center px-4 text-sm font-semibold marker:hidden">
                  Create reset link
                </summary>
                <form onSubmit={submit} className="border-t border-border p-3">
                  <input type="hidden" name="intent" value="reset" />
                  <input type="hidden" name="memberId" value={member.memberId} />
                  <p className="m-0 max-w-sm text-xs leading-5 text-muted">
                    Ends active sessions now. The one-time link expires after one hour.
                  </p>
                  <button
                    type="submit"
                    disabled={pending}
                    className="mt-3 min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
                  >
                    {pending ? "Creating…" : `Create reset for ${member.displayName}`}
                  </button>
                </form>
              </details>
            </div>
          </div>
        </div>
      )}

      {!current && result ? (
        <div className="mt-4 space-y-3">
          {actionStatus(result)}
          {result.link ? (
            <OneTimeLink id={`team-member-link-${member.memberId}`} link={result.link} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function TeamConsole({
  createInvitation,
  currentMemberId,
  manageMember,
  members,
}: TeamConsoleProps) {
  return (
    <div className="mt-10 space-y-10">
      <InvitationPanel action={createInvitation} />

      <section aria-labelledby="team-members-heading">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
          <div>
            <h2 id="team-members-heading" className="m-0 text-xl font-semibold tracking-[-0.02em]">
              Team members
            </h2>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted">
              {members.length} {members.length === 1 ? "member" : "members"}. Disabled members stay
              visible so their content history remains attributable.
            </p>
          </div>
        </div>

        <ul className="m-0 mt-5 grid list-none gap-4 p-0">
          {members.map((member) => (
            <MemberPanel
              key={member.memberId}
              action={manageMember}
              current={member.memberId === currentMemberId}
              member={member}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
