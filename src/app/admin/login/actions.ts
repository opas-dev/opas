// ABOUTME: Authenticates the configured administrator and begins a signed browser session.
// ABOUTME: Returns one generic failure state so credential errors reveal no account details.
"use server";

import { redirect } from "next/navigation";

import { getAdminConfig } from "@/auth/config";
import { adminCredentialsMatch } from "@/auth/credentials";
import { startAdminSession } from "@/auth/admin";

export type LoginState = {
  message: string;
};

export async function loginAdmin(_state: LoginState, formData: FormData): Promise<LoginState> {
  const submittedEmail = formData.get("email");
  const submittedPassword = formData.get("password");
  const email = (typeof submittedEmail === "string" ? submittedEmail : "").slice(0, 320);
  const password = (typeof submittedPassword === "string" ? submittedPassword : "").slice(
    0,
    1024,
  );
  const config = getAdminConfig();
  const authenticated = await adminCredentialsMatch(
    email,
    password,
    config.email,
    config.password,
  );

  if (!authenticated) {
    return { message: "Email or password is incorrect." };
  }

  await startAdminSession();
  redirect("/admin/content");
}
