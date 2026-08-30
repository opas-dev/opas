// ABOUTME: Downloads active-workspace redacted conversations or evaluation results as CSV.
// ABOUTME: Authorizes every export and keeps filenames and response headers server-owned.
import { requireAdmin } from "@/auth/admin";
import { exportActiveQualityCsv } from "@/quality/dependencies";
import { handleQualityExportRequest } from "@/quality/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleQualityExportRequest(request, {
    authorize: requireAdmin,
    exportCsv: exportActiveQualityCsv,
  });
}
