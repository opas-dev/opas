// ABOUTME: Implements the bounded HTTP boundary for resolving an embedded parent page.
// ABOUTME: Returns only server-owned identities from the current published article snapshot.
import {
  resolvePublishedArticleUrl,
  type PublishedPageCandidate,
} from "@/content/page-context";
import { embedParentOrigins } from "@/embed/config";
import { maximumEmbedPageUrlUtf8Bytes } from "@/embed/messages";

export const maximumEmbedContextRequestUtf8Bytes = 4_096;
export type PublishedEmbedArticle = PublishedPageCandidate;

type EmbedContextDependencies = Readonly<{
  loadPublications?: () => Promise<readonly PublishedPageCandidate[]>;
  parentOrigins?: readonly string[];
}>;

type ParsedEmbedContextRequest = Readonly<{
  pageUrl: string;
  parentOrigin: string;
}>;

type BoundedRequestBody =
  | Readonly<{ error: number }>
  | Readonly<{ text: string }>;

const encoder = new TextEncoder();
const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

async function loadCurrentPublications() {
  const { loadPublicationContent } = await import("@/content/publication-data");
  return (await loadPublicationContent()).publications;
}

function response(value: unknown, status: number) {
  return Response.json(value, { headers: responseHeaders, status });
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function strictJsonContentType(value: string | null) {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value)
  );
}

async function boundedRequestText(request: Request): Promise<BoundedRequestBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) return { error: 400 } as const;
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumEmbedContextRequestUtf8Bytes) {
      return { error: 413 } as const;
    }
  }
  if (!request.body) return { error: 400 } as const;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumEmbedContextRequestUtf8Bytes) {
        return { error: 413 } as const;
      }
      chunks.push(part.value);
    }
  } catch {
    return { error: 400 } as const;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Request-body cleanup is best effort after a disconnect.
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body) } as const;
  } catch {
    return { error: 400 } as const;
  }
}

function parsedRequest(text: string): ParsedEmbedContextRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["pageUrl", "parentOrigin"]) ||
    typeof record.pageUrl !== "string" ||
    typeof record.parentOrigin !== "string" ||
    encoder.encode(record.pageUrl).byteLength > maximumEmbedPageUrlUtf8Bytes
  ) {
    return null;
  }
  return { pageUrl: record.pageUrl, parentOrigin: record.parentOrigin };
}

export async function handleEmbedContextRequest(
  request: Request,
  dependencies: EmbedContextDependencies = {},
) {
  if (request.method !== "POST") {
    return response({ error: "method-not-allowed" }, 405);
  }
  if (!strictJsonContentType(request.headers.get("content-type"))) {
    return response({ error: "invalid-request" }, 415);
  }

  const body = await boundedRequestText(request);
  if ("error" in body) return response({ error: "invalid-request" }, body.error);
  const input = parsedRequest(body.text);
  if (!input) return response({ error: "invalid-request" }, 400);

  const origins = dependencies.parentOrigins ?? embedParentOrigins();
  if (!origins.includes(input.parentOrigin)) {
    return response({ error: "invalid-request" }, 403);
  }

  let url: URL;
  try {
    url = new URL(input.pageUrl);
  } catch {
    return response({ error: "invalid-request" }, 400);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== input.parentOrigin
  ) {
    return response({ error: "invalid-request" }, 400);
  }

  const publications = await (
    dependencies.loadPublications ?? loadCurrentPublications
  )();
  return response(
    {
      context: resolvePublishedArticleUrl(
        input.pageUrl,
        input.parentOrigin,
        publications,
      ),
    },
    200,
  );
}
