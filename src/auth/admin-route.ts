// ABOUTME: Applies optimistic signed-session routing decisions to administrator requests.
// ABOUTME: Leaves login and acceptance public while clearing invalid protected-route cookies.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  databaseSessionCookieName,
  verifyDatabaseSessionToken,
} from "@/auth/database-session";

const loginPath = "/admin/login";

function clearInvalidSession(response: NextResponse, cookieName: string) {
  response.cookies.set(cookieName, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: true,
  });

  return response;
}

export async function authorizeAdminRoute(
  request: NextRequest,
  sessionSecret: string,
  deploymentId: string,
) {
  const isLogin =
    request.nextUrl.pathname === loginPath ||
    request.nextUrl.pathname === `${loginPath}/`;
  const isAcceptance =
    request.nextUrl.pathname === "/admin/accept" ||
    request.nextUrl.pathname.startsWith("/admin/accept/");

  if (isLogin || isAcceptance) {
    return NextResponse.next();
  }

  const cookieName = databaseSessionCookieName(deploymentId);
  const token = request.cookies.get(cookieName)?.value;

  if (!token) {
    return NextResponse.redirect(new URL(loginPath, request.url));
  }

  const session = await verifyDatabaseSessionToken(
    token,
    sessionSecret,
    deploymentId,
  );

  if (!session) {
    return clearInvalidSession(
      NextResponse.redirect(new URL(loginPath, request.url)),
      cookieName,
    );
  }

  return NextResponse.next();
}
