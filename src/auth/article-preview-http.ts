// ABOUTME: Enforces the same-origin exchange and private HTTP boundary for signed previews.
// ABOUTME: Serves only exact-revision assets and clears unusable deployment-scoped cookies.

import {
  exchangeArticlePreview,
  resolveArticlePreview,
  resolveArticlePreviewAsset,
  type ArticlePreviewRepository,
} from "@/auth/article-preview";
import { articlePreviewResponseHeaders } from "@/auth/article-preview-headers";
import {
  articlePreviewCookieName,
  articlePreviewCookieOptions,
} from "@/auth/preview-claims";
import type { ArticlePreviewConfiguration } from "@/auth/preview-environment";
import { isAssetHash } from "@/assets/identity";

const maximumExchangeBodyBytes = 2_304;

export type ArticlePreviewHttpDependencies = Readonly<{
  clock?: () => Date;
  configuration: ArticlePreviewConfiguration;
  repository: ArticlePreviewRepository;
  siteOrigin: string;
}>;

class ArticlePreviewRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("INVALID_ARTICLE_PREVIEW_REQUEST");
    this.name = "ArticlePreviewRequestError";
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    headers: articlePreviewResponseHeaders,
    status,
  });
}

function requestOriginMatches(request: Request, siteOrigin: string) {
  try {
    return new URL(request.url).origin === siteOrigin;
  } catch {
    return false;
  }
}

function browserFetchIsSameOrigin(
  request: Request,
  siteOrigin: string,
  requireOrigin: boolean,
) {
  return (
    requestOriginMatches(request, siteOrigin) &&
    (!requireOrigin || request.headers.get("origin") === siteOrigin) &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "cors" &&
    request.headers.get("sec-fetch-dest") === "empty"
  );
}

function declaredLength(value: string | null) {
  if (value === null) return;
  if (!/^\d+$/u.test(value)) throw new ArticlePreviewRequestError(400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximumExchangeBodyBytes) {
    throw new ArticlePreviewRequestError(413);
  }
}

async function boundedText(request: Request) {
  declaredLength(request.headers.get("content-length"));
  if (!request.body) throw new ArticlePreviewRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new ArticlePreviewRequestError(400);
      }
      total += result.value.byteLength;
      if (total > maximumExchangeBodyBytes) {
        throw new ArticlePreviewRequestError(413);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Releasing a consumed or disconnected request body is best effort.
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArticlePreviewRequestError(400);
  }
}

async function exchangeBearer(request: Request) {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(contentType)
  ) {
    throw new ArticlePreviewRequestError(415);
  }

  let value: unknown;
  try {
    value = JSON.parse(await boundedText(request));
  } catch (error) {
    if (error instanceof ArticlePreviewRequestError) throw error;
    throw new ArticlePreviewRequestError(400);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join("\0") !== "bearer" ||
    typeof (value as Record<string, unknown>).bearer !== "string"
  ) {
    throw new ArticlePreviewRequestError(400);
  }
  return (value as Readonly<{ bearer: string }>).bearer;
}

function clearPreviewCookie(
  response: Response,
  configuration: ArticlePreviewConfiguration,
  now: Date,
) {
  setPreviewCookie(response, configuration, "", new Date(0), new Date(0), now);
  return response;
}

function previewCookie(request: Request, name: string) {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((field) => field.trim())
    .filter((field) => field.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  return matches[0]?.slice(name.length + 1);
}

function setPreviewCookie(
  response: Response,
  configuration: ArticlePreviewConfiguration,
  value: string,
  tokenExpiresAt: Date,
  databaseExpiresAt: Date,
  now: Date,
) {
  const options = articlePreviewCookieOptions(
    tokenExpiresAt,
    databaseExpiresAt,
    now,
  );
  response.headers.append(
    "Set-Cookie",
    [
      `${articlePreviewCookieName(configuration.deploymentId)}=${value}`,
      `Path=${options.path}`,
      `Expires=${options.expires.toUTCString()}`,
      `Max-Age=${options.maxAge}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Priority=High",
    ].join("; "),
  );
}

export async function handleArticlePreviewExchange(
  request: Request,
  runtime: ArticlePreviewHttpDependencies,
) {
  if (!browserFetchIsSameOrigin(request, runtime.siteOrigin, true)) {
    return json({ error: "invalid-request" }, 403);
  }

  const now = runtime.clock?.() ?? new Date();
  try {
    const bearer = await exchangeBearer(request);
    const exchanged = await exchangeArticlePreview(
      bearer,
      runtime.configuration,
      { clock: () => now, repository: runtime.repository },
    );
    if (!exchanged) {
      return clearPreviewCookie(
        json({ error: "invalid-preview" }, 400),
        runtime.configuration,
        now,
      );
    }

    const response = json({ outcome: "exchanged" });
    setPreviewCookie(
      response,
      runtime.configuration,
      exchanged.token,
      exchanged.claims.expiresAt,
      exchanged.databaseExpiresAt,
      now,
    );
    return response;
  } catch (error) {
    if (error instanceof ArticlePreviewRequestError) {
      return clearPreviewCookie(
        json({ error: "invalid-request" }, error.status),
        runtime.configuration,
        now,
      );
    }
    return json({ error: "unavailable" }, 503);
  }
}

export async function handleArticlePreviewSession(
  request: Request,
  runtime: ArticlePreviewHttpDependencies,
) {
  if (!browserFetchIsSameOrigin(request, runtime.siteOrigin, false)) {
    return json({ error: "invalid-request" }, 403);
  }

  const now = runtime.clock?.() ?? new Date();
  try {
    const token = previewCookie(
      request,
      articlePreviewCookieName(runtime.configuration.deploymentId),
    );
    const preview = await resolveArticlePreview(token, runtime.configuration, {
      clock: () => now,
      repository: runtime.repository,
    });
    if (!preview) {
      return clearPreviewCookie(
        json({ error: "invalid-preview" }, 401),
        runtime.configuration,
        now,
      );
    }
    return json({ outcome: "active" });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function handleArticlePreviewAsset(
  request: Request,
  hash: string,
  runtime: ArticlePreviewHttpDependencies,
) {
  if (!isAssetHash(hash)) {
    return new Response("Not Found\n", {
      headers: {
        ...articlePreviewResponseHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
      status: 404,
    });
  }

  if (!requestOriginMatches(request, runtime.siteOrigin)) {
    return json({ error: "invalid-request" }, 403);
  }

  const now = runtime.clock?.() ?? new Date();
  try {
    const token = previewCookie(
      request,
      articlePreviewCookieName(runtime.configuration.deploymentId),
    );
    const asset = await resolveArticlePreviewAsset(
      token,
      hash,
      runtime.configuration,
      { clock: () => now, repository: runtime.repository },
    );
    if (!asset) {
      return clearPreviewCookie(
        new Response("Not Found\n", {
          headers: {
            ...articlePreviewResponseHeaders,
            "Content-Type": "text/plain; charset=utf-8",
          },
          status: 404,
        }),
        runtime.configuration,
        now,
      );
    }

    return new Response(asset.content.slice().buffer, {
      headers: {
        ...articlePreviewResponseHeaders,
        "Content-Length": String(asset.byteSize),
        "Content-Type": asset.mediaType,
        ETag: `"sha256-${asset.hash}"`,
      },
    });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export function unavailableArticlePreviewResponse() {
  return json({ error: "unavailable" }, 503);
}
