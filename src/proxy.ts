// ABOUTME: Performs the fast cookie check that gates every OPAS administrator route.
// ABOUTME: Redirects between login and protected pages while leaf actions re-authorize writes.
import type { NextRequest } from "next/server";

import { authorizeAdminRoute } from "@/auth/admin-route";

export async function proxy(request: NextRequest) {
  const { getAdminConfig } = await import("@/auth/config");
  const { sessionSecret } = getAdminConfig();
  return authorizeAdminRoute(request, sessionSecret);
}

export const config = {
  matcher: ["/admin/:path*"],
};
