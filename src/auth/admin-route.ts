// ABOUTME: Applies signed-session routing decisions to administrator requests.
// ABOUTME: Keeps Proxy focused on redirects and invalid-cookie cleanup without reading deployment secrets.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { adminSessionCookie, verifyAdminSessionToken } from "@/auth/session";

const loginPath = "/admin/login";
const adminHomePath = "/admin/theme";

function clearInvalidSession(response: NextResponse) {
  response.cookies.set(adminSessionCookie, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}

export async function authorizeAdminRoute(request: NextRequest, sessionSecret: string) {
  const isLogin = request.nextUrl.pathname === loginPath;
  const token = request.cookies.get(adminSessionCookie)?.value;

  if (!token) {
    return isLogin
      ? NextResponse.next()
      : NextResponse.redirect(new URL(loginPath, request.url));
  }

  const session = await verifyAdminSessionToken(token, sessionSecret);

  if (!session) {
    const response = isLogin
      ? NextResponse.next()
      : NextResponse.redirect(new URL(loginPath, request.url));
    return clearInvalidSession(response);
  }

  if (isLogin) {
    return NextResponse.redirect(new URL(adminHomePath, request.url));
  }

  return NextResponse.next();
}
