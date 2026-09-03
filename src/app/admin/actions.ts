// ABOUTME: Ends the current administrator session through an explicit server-side mutation.
// ABOUTME: Re-authorizes logout before expiring the signed HttpOnly cookie.
"use server";

import { redirect } from "next/navigation";

import { endAdminSession, requireMemberCapability } from "@/auth/admin";
import { demoIds } from "@/db/demo";

export async function logoutAdmin() {
  const member = await requireMemberCapability("content:read", demoIds.workspace);
  await endAdminSession(member);
  redirect("/admin/login");
}
