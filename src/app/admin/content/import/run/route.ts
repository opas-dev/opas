// ABOUTME: Reviews and atomically activates authenticated Markdown or GitBook imports.
// ABOUTME: Replans every activation against current workspace slugs before any database write.
import { revalidatePath } from "next/cache";

import { scheduleEmbeddingRecovery } from "@/ai/embedding-scheduling";
import { authoringPausedResponse } from "@/authoring/failures";
import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";
import { archiveLimits, ArchiveValidationError } from "@/import/archive";
import { executeKnowledgeImport } from "@/import/execute";
import type { ImportResponse } from "@/import/http";
import { planKnowledgeImport } from "@/import/planner";
import { completedImportReport } from "@/import/report";
import { ImportUploadError, readKnowledgeUpload } from "@/import/upload";

export const runtime = "nodejs";

const maximumImportRequestBytes = archiveLimits.compressedBytes + 64 * 1024;

function requestError(message: string, status = 400) {
  return Response.json({ status: "error", message } satisfies ImportResponse, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorDetails(error: unknown) {
  return { type: error instanceof Error ? error.name : "UnknownError" };
}

export async function POST(request: Request) {
  await requireMemberCapability("import:run", demoIds.workspace);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return requestError("The import request length is invalid.");
    }
    if (parsedLength > maximumImportRequestBytes) {
      return requestError("Import requests must contain a ZIP no larger than 4 MiB.", 413);
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return requestError("Send one Markdown file or ZIP archive as multipart form data.");
  }

  if (
    [...formData.keys()].some((name) => name !== "file" && name !== "mode") ||
    formData.getAll("file").length !== 1 ||
    formData.getAll("mode").length !== 1
  ) {
    return requestError("Send exactly one knowledge file and one import mode.");
  }

  const mode = formData.get("mode");
  if (mode !== "dry-run" && mode !== "activate") {
    return requestError("The import mode is invalid.");
  }

  let files;
  try {
    files = await readKnowledgeUpload(formData.get("file"));
  } catch (error) {
    if (error instanceof ImportUploadError || error instanceof ArchiveValidationError) {
      return requestError(error.message, 422);
    }
    return requestError("The uploaded knowledge source could not be read.", 422);
  }

  const repository = await getRepository();
  const [categories, articles] = await Promise.all([
    repository.listCategories(demoIds.workspace),
    repository.listArticles(demoIds.workspace),
  ]);
  const plan = await planKnowledgeImport(files, {
    existingCategorySlugs: categories.map((category) => category.slug),
    existingArticleSlugs: articles.map((article) => article.slug),
  });

  if (!plan.ready) {
    return Response.json(
      { status: "blocked", report: plan.report } satisfies ImportResponse,
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (mode === "dry-run") {
    return Response.json(
      { status: "ready", report: plan.report } satisfies ImportResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    await executeKnowledgeImport({ repository, workspaceId: demoIds.workspace, plan });
  } catch (error) {
    const paused = authoringPausedResponse(error);
    if (paused) return paused;
    console.error("Knowledge import activation failed.", errorDetails(error));
    return requestError(
      "The workspace changed or the import could not be activated. Review it again.",
      409,
    );
  }

  scheduleEmbeddingRecovery();
  revalidatePath("/", "layout");
  return Response.json(
    {
      status: "complete",
      report: completedImportReport(plan.report),
    } satisfies ImportResponse,
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
