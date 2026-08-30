// ABOUTME: Renders the shared authenticated navigation for OPAS administration pages.
// ABOUTME: Keeps content, analytics, theme, public-site, and sign-out destinations consistent.
import Link from "next/link";

import { logoutAdmin } from "@/app/admin/actions";

type AdminHeaderProps = {
  email: string;
  active: "content" | "analytics" | "quality" | "theme";
};

const navigation = [
  { id: "content", href: "/admin/content", label: "Content" },
  { id: "analytics", href: "/admin/analytics", label: "Analytics" },
  { id: "quality", href: "/admin/quality", label: "Quality" },
  { id: "theme", href: "/admin/theme", label: "Theme" },
] as const;

export function AdminHeader({ email, active }: AdminHeaderProps) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/admin" className="flex min-w-0 items-center gap-3 no-underline">
          <span className="grid size-8 place-items-center rounded-sm bg-primary text-xs font-bold text-primary-foreground">
            O
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">OPAS Admin</span>
            <span className="block max-w-44 truncate text-xs text-muted sm:max-w-none">{email}</span>
          </span>
        </Link>
        <nav aria-label="Administrator" className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {navigation.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm font-semibold no-underline transition-colors duration-200 ${
                active === item.id
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted hover:bg-surface-strong hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/"
            className="rounded-md px-3 py-2 text-sm font-semibold no-underline text-muted transition-colors duration-200 hover:bg-surface-strong hover:text-foreground"
          >
            View site
          </Link>
          <form action={logoutAdmin}>
            <button
              type="submit"
              className="rounded-md px-3 py-2 text-sm font-semibold text-muted transition-colors duration-200 hover:bg-surface-strong hover:text-foreground"
            >
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
