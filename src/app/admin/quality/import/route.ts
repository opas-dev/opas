// ABOUTME: Imports one authenticated saved-question fixture for the active workspace.
// ABOUTME: Keeps workspace identity, evidence validation, and persistence on the server.
import { requireAdmin } from "@/auth/admin";
import {
  consumeQualityRequestAllowance,
  importActiveSavedQuestionSet,
} from "@/quality/dependencies";
import { handleQuestionSetImportRequest } from "@/quality/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleQuestionSetImportRequest(request, {
    authorize: requireAdmin,
    consumeAllowance: consumeQualityRequestAllowance,
    importQuestionSet: importActiveSavedQuestionSet,
  });
}
