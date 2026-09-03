// ABOUTME: Reads the deployment-scoped signing configuration for named-member sessions.
// ABOUTME: Keeps the shared session secret inside the server-only authentication boundary.
import "server-only";

import {
  parseAdminSessionEnvironment,
  type AdminSessionConfig,
} from "@/auth/session-environment";

export type { AdminSessionConfig } from "@/auth/session-environment";

export function getAdminSessionConfig(): AdminSessionConfig {
  return parseAdminSessionEnvironment(process.env);
}
