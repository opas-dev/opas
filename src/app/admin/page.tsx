// ABOUTME: Routes an authenticated administrator to the current OPAS management surface.
// ABOUTME: Performs an authoritative session check before choosing the admin destination.
import { redirect } from "next/navigation";

import { requireAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export default async function AdminPage() {
  await requireAdmin();
  redirect("/admin/content");
}
