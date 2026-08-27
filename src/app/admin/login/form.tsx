// ABOUTME: Captures administrator credentials with accessible validation and pending feedback.
// ABOUTME: Keeps authentication interaction isolated in the smallest client-side boundary.
"use client";

import { useActionState } from "react";

import { loginAdmin, type LoginState } from "@/app/admin/login/actions";

const initialState: LoginState = { message: "" };

export function AdminLoginForm() {
  const [state, formAction, pending] = useActionState(loginAdmin, initialState);

  return (
    <form action={formAction} className="mt-8 space-y-5">
      <div className="space-y-2">
        <label className="block text-sm font-semibold text-foreground" htmlFor="email">
          Email
        </label>
        <input
          autoComplete="username"
          autoFocus
          className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 text-foreground outline-none transition-colors placeholder:text-muted hover:border-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          id="email"
          inputMode="email"
          maxLength={320}
          name="email"
          required
          type="email"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-semibold text-foreground" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="current-password"
          className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 text-foreground outline-none transition-colors hover:border-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          id="password"
          maxLength={1024}
          name="password"
          required
          type="password"
        />
      </div>

      {state.message ? (
        <p
          aria-live="polite"
          className="rounded-sm border border-danger bg-surface px-3 py-2 text-sm text-foreground"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      <button
        className="min-h-12 w-full rounded-md bg-primary px-4 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
