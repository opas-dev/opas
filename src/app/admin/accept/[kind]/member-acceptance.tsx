// ABOUTME: Clears one-time member-link fragments and guides invitees through account setup.
// ABOUTME: Keeps bearer values in one bounded same-origin exchange and never renders or stores them.
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

import type { MemberLinkKind } from "@/auth/member-link-claims";

type AcceptanceView = Readonly<{
  email: string;
  expiresAt: string;
  kind: MemberLinkKind;
  role: "administrator" | "editor" | "reviewer" | null;
}>;

type AcceptanceState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; view: AcceptanceView }>
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

const exchangeTasks = new Map<string, Promise<boolean>>();

function clearFragmentAndReadBearer() {
  if (!window.location.hash) return null;
  const bearer = window.location.hash.slice(1);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return bearer.length > 0 && bearer.length <= 128 ? bearer : "";
}

function exchangeFragment(pathname: string) {
  const activeTask = exchangeTasks.get(pathname);
  if (activeTask) return activeTask;

  const bearer = clearFragmentAndReadBearer();
  if (bearer === null) return Promise.resolve(true);
  if (bearer === "") return Promise.resolve(false);

  const task = fetch(`${pathname}/exchange`, {
    body: JSON.stringify({ bearer }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
    referrerPolicy: "no-referrer",
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => exchangeTasks.delete(pathname));
  exchangeTasks.set(pathname, task);
  return task;
}

async function loadAcceptance(pathname: string) {
  const response = await fetch(`${pathname}/session`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("MEMBER_ACCEPTANCE_UNAVAILABLE");
  const payload = (await response.json()) as { acceptance?: AcceptanceView };
  return payload.acceptance ?? null;
}

function readableRole(role: AcceptanceView["role"]) {
  if (!role) return null;
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

export function MemberAcceptance({ kind }: Readonly<{ kind: MemberLinkKind }>) {
  const [state, setState] = useState<AcceptanceState>({ status: "loading" });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let current = true;
    const pathname = window.location.pathname;

    void (async () => {
      try {
        if (!(await exchangeFragment(pathname))) {
          if (current) setState({ status: "invalid" });
          return;
        }
        const view = await loadAcceptance(pathname);
        if (current) {
          setState(view ? { status: "ready", view } : { status: "invalid" });
        }
      } catch {
        if (current) setState({ status: "unavailable" });
      }
    })();

    return () => {
      current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status !== "ready" || pending) return;

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const passwordConfirmation = String(form.get("passwordConfirmation") ?? "");
    if (password !== passwordConfirmation) {
      setError("The passwords do not match.");
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }

    setError("");
    setPending(true);
    try {
      const body = kind === "invite"
        ? {
            displayName: String(form.get("displayName") ?? ""),
            password,
          }
        : { password };
      const response = await fetch(`${window.location.pathname}/complete`, {
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        referrerPolicy: "no-referrer",
      });
      const payload = (await response.json()) as {
        error?: string;
        field?: "displayName" | "password";
        outcome?: string;
      };
      if (response.ok && payload.outcome === "accepted") {
        setState({ status: "accepted" });
        return;
      }
      if (response.status === 401) {
        setState({ status: "invalid" });
        return;
      }
      if (payload.error === "invalid-input") {
        setError(
          payload.field === "displayName"
            ? "Enter a display name of 100 characters or fewer."
            : "Use at least 15 characters for your password.",
        );
      } else {
        setError("We could not complete this request. Try again.");
      }
    } catch {
      setError("We could not complete this request. Try again.");
    } finally {
      setPending(false);
      queueMicrotask(() => errorRef.current?.focus());
    }
  }

  if (state.status === "loading") {
    return (
      <p aria-live="polite" className="mt-8 text-sm text-muted">
        Checking your secure link…
      </p>
    );
  }

  if (state.status === "invalid") {
    return (
      <div className="mt-8 space-y-4" role="alert">
        <p className="font-semibold">This link is no longer available.</p>
        <p className="text-sm leading-6 text-muted">
          It may have expired, been replaced, or already been used. Ask your OPAS
          administrator for a fresh link.
        </p>
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div className="mt-8 space-y-4" role="alert">
        <p className="font-semibold">We could not check this link.</p>
        <p className="text-sm leading-6 text-muted">
          Refresh the page to try again. Your link has not been used.
        </p>
      </div>
    );
  }

  if (state.status === "accepted") {
    return (
      <div className="mt-8 space-y-5" role="status">
        <p className="text-lg font-semibold">
          {kind === "invite" ? "Your account is ready." : "Your password is updated."}
        </p>
        <Link
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          href="/admin/login"
        >
          Continue to sign in
        </Link>
      </div>
    );
  }

  const role = readableRole(state.view.role);
  return (
    <form className="mt-8 space-y-5" onSubmit={submit}>
      <div className="rounded-md border border-border bg-surface px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
          Team account
        </p>
        <p className="mt-1 break-all text-sm font-semibold">{state.view.email}</p>
        {role ? <p className="mt-1 text-sm text-muted">Role: {role}</p> : null}
      </div>

      {kind === "invite" ? (
        <div className="space-y-2">
          <label className="block text-sm font-semibold" htmlFor="displayName">
            Display name
          </label>
          <input
            autoComplete="name"
            autoFocus
            className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 outline-none transition-colors hover:border-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
            disabled={pending}
            id="displayName"
            maxLength={100}
            name="displayName"
            required
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor="password">
          {kind === "invite" ? "Create password" : "New password"}
        </label>
        <input
          autoComplete="new-password"
          autoFocus={kind !== "invite"}
          className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 outline-none transition-colors hover:border-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          id="password"
          maxLength={2048}
          minLength={15}
          name="password"
          required
          type="password"
        />
        <p className="text-xs leading-5 text-muted">Use at least 15 characters.</p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor="passwordConfirmation">
          Confirm password
        </label>
        <input
          autoComplete="new-password"
          className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 outline-none transition-colors hover:border-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          id="passwordConfirmation"
          maxLength={2048}
          minLength={15}
          name="passwordConfirmation"
          required
          type="password"
        />
      </div>

      {error ? (
        <p
          aria-live="assertive"
          className="rounded-sm border border-danger bg-surface px-3 py-2 text-sm"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {error}
        </p>
      ) : null}

      <button
        className="min-h-12 w-full rounded-md bg-primary px-4 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending
          ? "Saving…"
          : kind === "invite"
            ? "Create account"
            : "Update password"}
      </button>
    </form>
  );
}
