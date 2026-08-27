// ABOUTME: Presents the single-administrator sign-in surface for OPAS management routes.
// ABOUTME: Uses the runtime theme tokens while keeping the credential task focused and direct.
import type { Metadata } from "next";

import { AdminLoginForm } from "@/app/admin/login/form";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Admin sign in",
};

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <section
        aria-labelledby="admin-login-heading"
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

        <h1
          className="mt-10 text-2xl font-bold tracking-[-0.025em] text-balance"
          id="admin-login-heading"
        >
          Sign in to manage your help center
        </h1>
        <p className="mt-3 max-w-[42ch] text-sm leading-6 text-muted text-pretty">
          Use the administrator credentials configured for this deployment.
        </p>

        <AdminLoginForm />
      </section>
    </main>
  );
}
