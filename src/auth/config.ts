// ABOUTME: Reads and validates the single administrator credentials and session signing secret.
// ABOUTME: Keeps deployment secrets inside the server-only authentication boundary.
import "server-only";

export type AdminConfig = {
  email: string;
  password: string;
  sessionSecret: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAdminEmail(email: string) {
  return email.trim().toLowerCase();
}

export function getAdminConfig(): AdminConfig {
  const email = normalizeAdminEmail(process.env.ADMIN_EMAIL ?? "");
  const password = process.env.ADMIN_PASSWORD ?? "";
  const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "";

  if (!emailPattern.test(email)) {
    throw new Error("ADMIN_EMAIL must contain a valid email address.");
  }

  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters.");
  }

  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }

  return { email, password, sessionSecret };
}
