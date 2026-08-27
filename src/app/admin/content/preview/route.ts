// ABOUTME: Compiles authenticated article previews without blocking the Server Action mutation queue.
// ABOUTME: Applies the same MDX safety boundary used by storage and public rendering.
import { createCompiler } from "@fumadocs/mdx-remote";

import { requireAdmin } from "@/auth/admin";
import {
  ArticleMdxValidationError,
  validateArticleMdx,
} from "@/content/mdx-safety";

export const runtime = "nodejs";

const previewCompiler = createCompiler({
  preset: "minimal",
  outputFormat: "function-body",
});

export async function POST(request: Request) {
  await requireAdmin();

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 120_000) {
    return Response.json({ message: "Article previews must be 100 KB or smaller." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "The preview request is invalid." }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("source" in body) ||
    typeof body.source !== "string" ||
    body.source.length === 0 ||
    body.source.length > 100_000
  ) {
    return Response.json(
      { message: "Enter up to 100 KB of article MDX to preview." },
      { status: 422 },
    );
  }

  try {
    const source = await validateArticleMdx(body.source);
    const compiled = String(await previewCompiler.compileFile(source));
    return Response.json({ compiled });
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof ArticleMdxValidationError
            ? error.message
            : "The preview could not be rendered.",
      },
      { status: 422 },
    );
  }
}
