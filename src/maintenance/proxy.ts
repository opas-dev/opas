// ABOUTME: Restricts a retained rollback artifact to public read traffic and health.
// ABOUTME: Returns an explicit maintenance response without importing administrator code.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { embedParentOrigins } from "@/embed/config";
import { createEmbedContentSecurityPolicy } from "@/security/headers";

export const maintenanceCode = "MAINTENANCE_AUTHORING_DISABLED" as const;

function maintenanceResponse() {
  return NextResponse.json(
    {
      code: maintenanceCode,
      message: "OPAS authoring is temporarily unavailable. Public help remains online.",
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "60",
        "X-Robots-Tag": "noindex, nofollow",
      },
      status: 503,
    },
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/preview" ||
    pathname.startsWith("/preview/") ||
    pathname === "/api/internal" ||
    pathname.startsWith("/api/internal/") ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return maintenanceResponse();
  }

  const response = NextResponse.next();
  if (pathname === "/embed") {
    response.headers.set(
      "Content-Security-Policy",
      createEmbedContentSecurityPolicy(embedParentOrigins()),
    );
  }
  return response;
}

export const config = {
  matcher: ["/:path*"],
};
