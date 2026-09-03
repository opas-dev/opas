// ABOUTME: Serves OPAS's read-only MCP tools over strict modern Streamable HTTP requests.
// ABOUTME: Creates an isolated SDK handler, server, and transport for every HTTP exchange.
import {
  createMcpHandler,
  isJsonContentType,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { mcpResponseHeaders } from "@/mcp/headers";
import {
  createMcpKnowledgeSource,
  maximumMcpArticleMarkdownLength,
  maximumMcpArticlePathLength,
  maximumMcpSearchResults,
  type McpKnowledgeSource,
} from "@/mcp/knowledge";
import {
  maximumSearchQueryLength,
  minimumSearchQueryLength,
} from "@/search/query";
import { resolveSiteOrigin } from "@/site";

export const mcpProtocolVersion = "2026-07-28";
export const opasProductVersion = "0.3.0";
export const maximumMcpRequestUtf8Bytes = 16 * 1024;

type McpErrorDetails = Readonly<{ type: string }>;

export type McpRequestDependencies = Readonly<{
  knowledge?: McpKnowledgeSource;
  onHandlerCreated?: (handler: McpHttpHandler) => void;
  onServerCreated?: (server: McpServer) => void;
  reportError?: (details: McpErrorDetails) => void;
  siteOrigin?: string;
}>;

type RequestFailure = Readonly<{
  code: number;
  message: string;
  status: number;
}>;

const readOnlyAnnotations = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
});

const canonicalUrlSchema = z.string().url().max(2_048);
const timestampSchema = z.string().datetime({ offset: true });
const articlePathSchema = z
  .string()
  .min(3)
  .max(maximumMcpArticlePathLength)
  .regex(/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const searchResultSchema = z.strictObject({
  articleId: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  excerpt: z.string().max(180),
  markdownUrl: canonicalUrlSchema,
  path: articlePathSchema,
  title: z.string().min(1).max(160),
  updatedAt: timestampSchema,
  url: canonicalUrlSchema,
});

const searchOutputSchema = z.strictObject({
  query: z.string().min(minimumSearchQueryLength).max(maximumSearchQueryLength),
  results: z.array(searchResultSchema).max(maximumMcpSearchResults),
});

const readOutputSchema = searchResultSchema.extend({
  author: z.string().min(1).max(100),
  markdown: z.string().max(maximumMcpArticleMarkdownLength),
  publishedAt: timestampSchema,
});

function defaultErrorReporter(details: McpErrorDetails) {
  console.error("MCP request failed.", details);
}

function errorDetails(error: unknown): McpErrorDetails {
  return { type: error instanceof Error ? error.name : "UnknownError" };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function createPublicMcpServer(
  knowledge: McpKnowledgeSource,
  reportError: (details: McpErrorDetails) => void = defaultErrorReporter,
) {
  const server = new McpServer(
    { name: "opas-public-help", version: opasProductVersion },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "search",
    {
      annotations: readOnlyAnnotations,
      description: "Search the current published OPAS help-center articles.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(maximumMcpSearchResults).default(5),
        query: z
          .string()
          .trim()
          .min(minimumSearchQueryLength)
          .max(maximumSearchQueryLength),
      }),
      outputSchema: searchOutputSchema,
      title: "Search published help",
    },
    async (input) => {
      try {
        return toolResult(await knowledge.search(input));
      } catch (error) {
        reportError(errorDetails(error));
        return toolError("Published help search is temporarily unavailable.");
      }
    },
  );

  server.registerTool(
    "read",
    {
      annotations: readOnlyAnnotations,
      description: "Read one current published OPAS article as Markdown.",
      inputSchema: z.strictObject({ path: articlePathSchema }),
      outputSchema: readOutputSchema,
      title: "Read published help",
    },
    async ({ path }) => {
      try {
        const article = await knowledge.read(path);
        return article
          ? toolResult(article)
          : toolError("The published article was not found.");
      } catch (error) {
        reportError(errorDetails(error));
        return toolError("The published article is temporarily unavailable.");
      }
    },
  );

  return server;
}

function protocolError(
  failure: RequestFailure,
  headers?: HeadersInit,
  id: number | string | null = null,
) {
  return Response.json(
    {
      error: { code: failure.code, message: failure.message },
      id,
      jsonrpc: "2.0",
    },
    { status: failure.status, headers },
  );
}

function parsedRequestId(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id))
    ? id
    : null;
}

function secureResponse(response: Response) {
  const headers = new Headers(response.headers);
  for (const { key, value } of mcpResponseHeaders) {
    headers.set(key, value);
  }
  headers.set("Vary", "Accept, Origin");
  headers.delete("Mcp-Session-Id");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function originFailure(request: Request, allowedOrigin: string) {
  const value = request.headers.get("origin");
  if (value === null) return null;

  try {
    const parsed = new URL(value);
    if (
      parsed.origin === "null" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      value !== parsed.origin ||
      parsed.origin !== allowedOrigin
    ) {
      throw new Error("Rejected Origin");
    }
  } catch {
    return protocolError({
      code: -32600,
      message: "Invalid Origin.",
      status: 403,
    });
  }

  return null;
}

function acceptsMcpResponse(value: string | null) {
  if (value === null) return false;
  const mediaTypes = new Set<string>();
  for (const range of value.split(",")) {
    const [rawMediaType, ...parameters] = range.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    if (!mediaType) continue;
    const quality = parameters.find((parameter) =>
      /^\s*q\s*=/iu.test(parameter),
    );
    if (quality) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(
        quality,
      );
      if (!match || Number(match[1]) === 0) continue;
    }
    mediaTypes.add(mediaType);
  }
  return mediaTypes.has("application/json") && mediaTypes.has("text/event-stream");
}

function isRequestFailure(error: unknown): error is RequestFailure {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<RequestFailure>;
  return (
    typeof candidate.code === "number" &&
    typeof candidate.message === "string" &&
    typeof candidate.status === "number"
  );
}

function declaredBodySize(value: string | null) {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) {
    throw {
      code: -32600,
      message: "Invalid Content-Length.",
      status: 400,
    } satisfies RequestFailure;
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > maximumMcpRequestUtf8Bytes) {
    throw {
      code: -32600,
      message: "MCP request body is too large.",
      status: 413,
    } satisfies RequestFailure;
  }
  return size;
}

async function boundedJsonBody(request: Request) {
  declaredBodySize(request.headers.get("content-length"));
  if (request.body === null) {
    throw {
      code: -32700,
      message: "MCP request body must be valid JSON.",
      status: 400,
    } satisfies RequestFailure;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumMcpRequestUtf8Bytes) {
        throw {
          code: -32600,
          message: "MCP request body is too large.",
          status: 413,
        } satisfies RequestFailure;
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A consumed or disconnected request body has already released its bytes.
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw {
      code: -32700,
      message: "MCP request body must be valid UTF-8 JSON.",
      status: 400,
    } satisfies RequestFailure;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw {
      code: -32700,
      message: "MCP request body must be valid JSON.",
      status: 400,
    } satisfies RequestFailure;
  }
}

async function closeHandler(handler: McpHttpHandler) {
  try {
    await handler.close();
  } catch {
    // The response boundary is already complete; cleanup remains best effort.
  }
}

function keepsHandlerAlive(response: Response) {
  return response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
}

function responseWithHandlerLifetime(
  response: Response,
  handler: McpHttpHandler,
) {
  if (!keepsHandlerAlive(response) || response.body === null) {
    return closeHandler(handler).then(() => response);
  }

  let finalized: Promise<void> | undefined;
  const finalize = () => {
    finalized ??= closeHandler(handler);
    return finalized;
  };
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  void response.body.pipeTo(passthrough.writable).then(finalize, finalize);

  return Promise.resolve(
    new Response(passthrough.readable, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

export async function handleMcpRequest(
  request: Request,
  dependencies: McpRequestDependencies = {},
) {
  let siteOrigin: string;
  try {
    siteOrigin = resolveSiteOrigin(dependencies.siteOrigin);
  } catch {
    return secureResponse(
      protocolError({
        code: -32603,
        message: "MCP service is unavailable.",
        status: 500,
      }),
    );
  }

  const rejectedOrigin = originFailure(request, siteOrigin);
  if (rejectedOrigin) return secureResponse(rejectedOrigin);

  if (request.method !== "POST") {
    return secureResponse(
      protocolError(
        { code: -32600, message: "Method not allowed.", status: 405 },
        { Allow: "POST" },
      ),
    );
  }

  if (!acceptsMcpResponse(request.headers.get("accept"))) {
    return secureResponse(
      protocolError({
        code: -32600,
        message: "Accept must include application/json and text/event-stream.",
        status: 406,
      }),
    );
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return secureResponse(
      protocolError({
        code: -32600,
        message: "Content-Type must be application/json.",
        status: 415,
      }),
    );
  }

  let parsedBody: unknown;
  const reportError = dependencies.reportError ?? defaultErrorReporter;
  try {
    parsedBody = await boundedJsonBody(request);
  } catch (error) {
    if (isRequestFailure(error)) {
      return secureResponse(protocolError(error));
    }
    reportError(errorDetails(error));
    return secureResponse(
      protocolError({
        code: -32700,
        message: "MCP request body could not be read.",
        status: 400,
      }),
    );
  }
  if (request.headers.get("MCP-Protocol-Version") === null) {
    return secureResponse(
      protocolError(
        {
          code: -32020,
          message: "Missing required MCP-Protocol-Version header.",
          status: 400,
        },
        undefined,
        parsedRequestId(parsedBody),
      ),
    );
  }

  const knowledge =
    dependencies.knowledge ?? createMcpKnowledgeSource({ siteOrigin });
  const handler = createMcpHandler(
    () => {
      const server = createPublicMcpServer(knowledge, reportError);
      dependencies.onServerCreated?.(server);
      return server;
    },
    {
      legacy: "reject",
      onerror: (error) => reportError(errorDetails(error)),
    },
  );
  dependencies.onHandlerCreated?.(handler);

  try {
    const response = await handler.fetch(request, { parsedBody });
    return secureResponse(await responseWithHandlerLifetime(response, handler));
  } catch (error) {
    await closeHandler(handler);
    reportError(errorDetails(error));
    return secureResponse(
      protocolError({
        code: -32603,
        message: "MCP request failed.",
        status: 500,
      }),
    );
  }
}
