// ABOUTME: Renders the shared authenticated navigation for OPAS administration pages.
// ABOUTME: Shows current member identity and only the navigation their active role can use.
import Link from "next/link";

import { logoutAdmin } from "@/app/admin/actions";
import { hasCapability, type Capability, type TeamRole } from "@/auth/capabilities";
import type { ActiveMemberSession } from "@/auth/member-repository";

type AdminHeaderProps = {
  active: "content" | "analytics" | "quality" | "team" | "theme";
  member: Pick<ActiveMemberSession, "displayName" | "email" | "role">;
};

const navigation = [
  { id: "content", href: "/admin/content", label: "Content" },
  { id: "analytics", href: "/admin/analytics", label: "Analytics" },
  { id: "quality", href: "/admin/quality", label: "Quality" },
  {
    capability: "workspace:configure",
    id: "theme",
    href: "/admin/theme",
    label: "Theme",
  },
  {
    capability: "member:manage",
    id: "team",
    href: "/admin/team",
    label: "Team",
  },
] as const satisfies readonly {
  capability?: Capability;
  href: string;
  id: AdminHeaderProps["active"];
  label: string;
}[];

const roleLabels: Record<TeamRole, string> = {
  administrator: "Administrator",
  editor: "Editor",
  reviewer: "Reviewer",
};

export function AdminHeader({ member, active }: AdminHeaderProps) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/admin" className="flex min-w-0 items-center gap-3 no-underline">
          <span className="grid size-8 place-items-center rounded-sm bg-primary text-xs font-bold text-primary-foreground">
            O
          </span>
          <span className="min-w-0">
            <span className="block max-w-52 truncate text-sm font-semibold">
              {member.displayName}
            </span>
            <span className="block max-w-52 truncate text-xs text-muted">
              {roleLabels[member.role]} · {member.email}
            </span>
          </span>
        </Link>
        <nav aria-label="Administrator" className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {navigation.filter(
            (item) => !("capability" in item) || hasCapability(member.role, item.capability),
          ).map((item) => (
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
