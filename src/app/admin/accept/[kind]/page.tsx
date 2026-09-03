// ABOUTME: Presents the secure account invitation and credential-reset entry page.
// ABOUTME: Renders no member or bearer data before the client completes same-origin exchange.
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MemberAcceptance } from "@/app/admin/accept/[kind]/member-acceptance";
import { parseMemberAcceptanceKind } from "@/auth/member-acceptance";

export const runtime = "nodejs";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Complete team access",
};

export default async function MemberAcceptancePage({
  params,
}: Readonly<{ params: Promise<{ kind: string }> }>) {
  const kind = parseMemberAcceptanceKind((await params).kind);
  if (!kind) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <section
        aria-labelledby="member-acceptance-heading"
        className="w-full max-w-md rounded-lg border border-border bg-surface-elevated p-6 sm:p-8"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-sm bg-primary text-xs font-bold text-primary-foreground"
          >
            O
          </span>
          <span className="text-sm font-bold tracking-[0.12em]">OPAS</span>
        </div>

        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
          Secure team access
        </p>
        <h1
          className="mt-2 text-2xl font-bold tracking-[-0.025em] text-balance"
          id="member-acceptance-heading"
        >
          {kind === "invite" ? "Join your OPAS team" : "Choose a new password"}
        </h1>
        <p className="mt-3 max-w-[42ch] text-sm leading-6 text-muted text-pretty">
          {kind === "invite"
            ? "Set up your named account to start working in the help center."
            : "This secure link can be used once to update your team account."}
        </p>

        <MemberAcceptance kind={kind} />
      </section>
    </main>
  );
}
