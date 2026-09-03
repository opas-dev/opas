// ABOUTME: Authenticates named members through durable admission and database credentials.
// ABOUTME: Returns one generic failure state without exposing identity or rate-limit details.
"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { startAdminSession } from "@/auth/admin";
import { getAdminSessionConfig } from "@/auth/config";
import {
  getLoginAdmissionRepository,
  getMemberRepository,
} from "@/auth/member-database";
import { loginMember, readMemberLoginForm } from "@/auth/member-login";
import { readLoginSource } from "@/auth/login-source";
import { demoIds } from "@/db/demo";
import { resolveSiteOrigin } from "@/site";

export type LoginState = {
  message: string;
};

const failedLogin: LoginState = Object.freeze({
  message: "Email or password is incorrect.",
});

export async function loginAdmin(_state: LoginState, formData: FormData): Promise<LoginState> {
  let authenticated = false;

  try {
    const config = getAdminSessionConfig();
    const request = new Request(
      new URL("/admin/login", resolveSiteOrigin()),
      { headers: new Headers(await headers()) },
    );
    const source = readLoginSource(request);
    const [admissionRepository, memberRepository] = await Promise.all([
      getLoginAdmissionRepository(),
      getMemberRepository(),
    ]);
    const result = await loginMember(
      {
        canonicalSourceAddress: source,
        deploymentId: config.deploymentId,
        form: readMemberLoginForm(formData),
        sessionSecret: config.sessionSecret,
        workspaceId: demoIds.workspace,
      },
      {
        admissionRepository,
        memberRepository,
        startBrowserSession: (session) => startAdminSession(session, config),
      },
    );
    authenticated = result.authenticated;

    if (!result.authenticated && result.cleanupFailed) {
      console.error("Named-member login cleanup failed.", {
        code: "LOGIN_SESSION_CLEANUP_FAILED",
      });
    }
  } catch {
    return failedLogin;
  }

  if (!authenticated) return failedLogin;
  redirect("/admin/content");
}
