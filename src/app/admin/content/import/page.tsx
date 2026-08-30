// ABOUTME: Hosts authenticated dry-run and activation controls for knowledge imports.
// ABOUTME: Keeps source review next to OPAS content administration without exposing files.
import type { Metadata } from "next";
import Link from "next/link";

import { ImportPanel } from "@/app/admin/content/import/import-panel";
import { AdminHeader } from "@/app/admin/header";
import { requireAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Import knowledge",
  description: "Review and import a Markdown or GitBook knowledge source.",
};

export default async function ImportContentPage() {
  const admin = await requireAdmin();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader email={admin.email} active="content" />
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <Link
          href="/admin/content"
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          ← Back to content
        </Link>
        <div className="mb-8 mt-6 max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">Knowledge migration</p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            See every change before it ships.
          </h1>
          <p className="mb-0 mt-4 text-base leading-7 text-muted text-pretty">
            OPAS preserves source order, rewrites local links and images, and stops the whole
            import when any supported content would be lost.
          </p>
        </div>
        <ImportPanel />
      </div>
    </main>
  );
}
