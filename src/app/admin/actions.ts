// ABOUTME: Ends the current administrator session through an explicit server-side mutation.
// ABOUTME: Re-authorizes logout before expiring the signed HttpOnly cookie.
"use server";

import { redirect } from "next/navigation";

import { endAdminSession, requireAdmin } from "@/auth/admin";

export async function logoutAdmin() {
  await requireAdmin();
  await endAdminSession();
  redirect("/admin/login");
}
