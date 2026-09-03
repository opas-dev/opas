// ABOUTME: Routes an authenticated administrator to the current OPAS management surface.
// ABOUTME: Performs an authoritative session check before choosing the admin destination.
import { redirect } from "next/navigation";

import { requireMemberCapability } from "@/auth/admin";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export default async function AdminPage() {
  await requireMemberCapability("content:read", demoIds.workspace);
  redirect("/admin/content");
}
