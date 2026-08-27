// ABOUTME: Validates anonymous article view and feedback HTTP requests.
// ABOUTME: Bounds public request bodies and normalizes the feedback stored by OPAS.
import { z } from "zod";

import {
  maximumArticleEventBodyBytes,
  maximumFeedbackCommentLength,
} from "./limits";

export {
  maximumArticleEventBodyBytes,
  maximumFeedbackCommentLength,
} from "./limits";

type ArticleEventRequestError = {
  success: false;
  status: 400 | 413 | 415;
  error: string;
};

type ArticleEventRequestResult<T> =
  | { success: true; data: T }
  | ArticleEventRequestError;

export type ArticleFeedbackRequest = {
  helpful: boolean;
  comment: string | null;
};

const emptyObjectSchema = z.strictObject({});

const feedbackSchema = z.strictObject({
  helpful: z.boolean(),
  comment: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => (typeof value === "string" ? value.trim() || null : null))
    .refine(
      (value) => value === null || [...value].length <= maximumFeedbackCommentLength,
      `Comments must be ${maximumFeedbackCommentLength.toLocaleString("en-US")} characters or fewer.`,
    ),
});

function requestError(
  status: ArticleEventRequestError["status"],
  error: string,
): ArticleEventRequestError {
  return { success: false, status, error };
}

function isJsonContentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredBodyIsTooLarge(request: Request) {
  const value = request.headers.get("content-length");
  return value !== null && /^\d+$/.test(value) && Number(value) > maximumArticleEventBodyBytes;
}

function bodyTooLargeError() {
  return requestError(
    413,
    `Request bodies must be ${maximumArticleEventBodyBytes.toLocaleString("en-US")} bytes or smaller.`,
  );
}

async function readBoundedBody(request: Request): Promise<ArticleEventRequestResult<string>> {
  if (request.body === null) {
    return { success: true, data: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bodyLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bodyLength += value.byteLength;
    if (bodyLength > maximumArticleEventBodyBytes) {
      await reader.cancel();
      return bodyTooLargeError();
    }

    chunks.push(value);
  }

  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      success: true,
      data: new TextDecoder("utf-8", { fatal: true }).decode(body),
    };
  } catch {
    return requestError(400, "Request body must be valid UTF-8 JSON.");
  }
}

async function readJsonRequest(
  request: Request,
  allowEmpty: boolean,
): Promise<ArticleEventRequestResult<unknown>> {
  if (declaredBodyIsTooLarge(request)) {
    return bodyTooLargeError();
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    if (allowEmpty && request.body === null && request.headers.get("content-type") === null) {
      return { success: true, data: {} };
    }

    return requestError(415, "Content-Type must be application/json.");
  }

  const body = await readBoundedBody(request);
  if (!body.success) {
    return body;
  }

  if (allowEmpty && body.data.trim().length === 0) {
    return { success: true, data: {} };
  }

  try {
    return { success: true, data: JSON.parse(body.data) as unknown };
  } catch {
    return requestError(400, "Request body must be valid JSON.");
  }
}

export async function parseArticleViewRequest(
  request: Request,
): Promise<ArticleEventRequestResult<Record<string, never>>> {
  const payload = await readJsonRequest(request, true);
  if (!payload.success) {
    return payload;
  }

  const parsed = emptyObjectSchema.safeParse(payload.data);
  if (!parsed.success) {
    return requestError(400, "View requests cannot contain fields.");
  }

  return { success: true, data: parsed.data };
}

export async function parseArticleFeedbackRequest(
  request: Request,
): Promise<ArticleEventRequestResult<ArticleFeedbackRequest>> {
  const payload = await readJsonRequest(request, false);
  if (!payload.success) {
    return payload;
  }

  const parsed = feedbackSchema.safeParse(payload.data);
  if (!parsed.success) {
    const commentError = parsed.error.issues.find(
      (issue) => issue.path[0] === "comment" && issue.code === "custom",
    );
    return requestError(
      400,
      commentError?.message ??
        "Feedback must contain only a boolean helpful value and an optional text comment.",
    );
  }

  return { success: true, data: parsed.data };
}

export function articleEventResponse(
  body: { accepted: true } | { error: string },
  status: number,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");

  return Response.json(body, {
    status,
    headers: responseHeaders,
  });
}
