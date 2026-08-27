// ABOUTME: Manages the administrator cookie and performs authoritative request-time authorization.
// ABOUTME: Gives pages and Server Actions one server-only guard before accessing admin capabilities.
import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getAdminConfig } from "@/auth/config";
import {
  adminSessionCookie,
  adminSessionLifetimeSeconds,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "@/auth/session";

const loginPath = "/admin/login";

export async function startAdminSession() {
  const { sessionSecret } = getAdminConfig();
  const { expiresAt, token } = await createAdminSessionToken(sessionSecret);
  const cookieStore = await cookies();

  cookieStore.set(adminSessionCookie, token, {
    expires: expiresAt,
    httpOnly: true,
    maxAge: adminSessionLifetimeSeconds,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export async function endAdminSession() {
  const cookieStore = await cookies();

  cookieStore.set(adminSessionCookie, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export async function requireAdmin(): Promise<{ email: string }> {
  const config = getAdminConfig();
  const token = (await cookies()).get(adminSessionCookie)?.value;
  const session = await verifyAdminSessionToken(token, config.sessionSecret);

  if (!session) {
    redirect(loginPath);
  }

  return { email: config.email };
}
