// ABOUTME: Verifies the modern public MCP protocol boundary, content scope, and request isolation.
// ABOUTME: Bundles the protocol surface with workerd conditions and exercises it directly on Node.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { build } from "esbuild";

import {
  createMcpKnowledgeSource,
  scopeMcpPublications,
  type McpKnowledgeRecords,
  type McpKnowledgeSource,
  type McpSearchOutput,
} from "@/mcp/knowledge";
import {
  handleMcpRequest,
  maximumMcpRequestUtf8Bytes,
  mcpProtocolVersion,
  opasProductVersion,
} from "@/mcp/server";
import type { Article, Category } from "@/db/repository";

const siteOrigin = "https://docs.example.test";
const clientMetadata = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "opas-test", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": mcpProtocolVersion,
};

const category: Category = {
  description: "Public guidance",
  id: "category_public",
  name: "Public",
  position: 0,
  slug: "public",
  workspaceId: "workspace_demo",
};

function article(
  overrides: Partial<Article> & Pick<Article, "id" | "slug" | "title">,
): Article {
  return {
    authorName: "OPAS",
    categoryId: category.id,
    contentHash: "a".repeat(64),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    isFaq: false,
    mdx: `# ${overrides.title}\n\nPublished answer.`,
    position: 0,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
    status: "published",
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    workspaceId: "workspace_demo",
    ...overrides,
  };
}

function records(): McpKnowledgeRecords {
  const foreignCategory: Category = {
    ...category,
    id: "category_foreign",
    slug: "foreign",
    workspaceId: "workspace_foreign",
  };
  return {
    articles: [
      article({
        id: "article_public",
        mdx: "# Public answer\n\nPublished answer with a runtime marker: {globalThis.__opasMcpExecuted = true}.",
        slug: "answer",
        title: "Public answer",
      }),
      article({
        id: "article_draft",
        publishedAt: null,
        slug: "draft-secret",
        status: "draft",
        title: "Draft secret",
      }),
      article({
        categoryId: foreignCategory.id,
        id: "article_foreign",
        slug: "foreign-secret",
        title: "Foreign secret",
        workspaceId: "workspace_foreign",
      }),
    ],
    categories: [category, foreignCategory],
  };
}

function modernBody(
  method: string,
  options: {
    args?: Record<string, unknown>;
    id?: number;
    name?: string;
    protocolVersion?: string;
  } = {},
) {
  const metadata = {
    ...clientMetadata,
    "io.modelcontextprotocol/protocolVersion":
      options.protocolVersion ?? mcpProtocolVersion,
  };
  return {
    id: options.id ?? 1,
    jsonrpc: "2.0",
    method,
    params: {
      ...(options.name ? { name: options.name } : {}),
      ...(options.args ? { arguments: options.args } : {}),
      _meta: metadata,
    },
  };
}

function protocolRequest(
  body: unknown,
  options: {
    accept?: string;
    contentType?: string;
    headers?: Record<string, string>;
    method?: string;
    name?: string;
    origin?: string;
    protocolVersion?: string;
    rawBody?: BodyInit;
  } = {},
) {
  const method = options.method ?? "POST";
  const headers = new Headers(options.headers);
  headers.set(
    "Accept",
    options.accept ?? "application/json, text/event-stream",
  );
  headers.set("Content-Type", options.contentType ?? "application/json");
  headers.set(
    "MCP-Protocol-Version",
    options.protocolVersion ?? mcpProtocolVersion,
  );
  if (body && typeof body === "object" && "method" in body) {
    headers.set("Mcp-Method", String(body.method));
  }
  if (options.name) headers.set("Mcp-Name", options.name);
  if (options.origin) headers.set("Origin", options.origin);

  return new Request(`${siteOrigin}/mcp`, {
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : options.rawBody ?? JSON.stringify(body),
    headers,
    method,
  });
}

function testDependencies(knowledge?: McpKnowledgeSource) {
  return {
    knowledge:
      knowledge ??
      createMcpKnowledgeSource({
        loadRecords: async () => records(),
        siteOrigin,
      }),
    reportError: () => {},
    siteOrigin,
  };
}

async function responseJson(response: Response) {
  return (await response.json()) as {
    error: { code: number; message: string };
    id: number | null;
    result: {
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: string;
          version: string;
        };
      };
      cacheScope: string;
      content: Array<{ text: string }>;
      isError?: boolean;
      resultType: string;
      structuredContent: {
        markdown: string;
        query: string;
        results: Array<{ url: string }>;
        title: string;
      };
      tools: Array<{
        annotations: Record<string, boolean>;
        inputSchema: { additionalProperties?: boolean };
        name: string;
        outputSchema?: object;
      }>;
      ttlMs: number;
    };
  };
}

test("MCP knowledge scope excludes drafts and foreign workspaces without evaluating MDX", async () => {
  const marker = "__opasMcpExecuted";
  delete (globalThis as Record<string, unknown>)[marker];
  const publications = scopeMcpPublications(records());
  assert.deepEqual(
    publications.map(({ article: current }) => current.id),
    ["article_public"],
  );

  const source = createMcpKnowledgeSource({
    loadRecords: async () => records(),
    siteOrigin,
  });
  assert.deepEqual(await source.search({ limit: 10, query: "secret" }), {
    query: "secret",
    results: [],
  });
  const search = await source.search({ limit: 10, query: "published answer" });
  assert.equal(search.results.length, 1);
  assert.deepEqual(search.results[0], {
    articleId: "article_public",
    category: "Public",
    excerpt:
      "Published answer with a runtime marker: {globalThis.__opasMcpExecuted = true}.",
    markdownUrl: `${siteOrigin}/public/answer.md`,
    path: "/public/answer",
    title: "Public answer",
    updatedAt: "2026-08-02T00:00:00.000Z",
    url: `${siteOrigin}/public/answer`,
  });

  assert.equal(await source.read("/public/draft-secret"), null);
  assert.equal(await source.read("/foreign/foreign-secret"), null);
  const read = await source.read("/public/answer");
  assert.match(read?.markdown ?? "", /__opasMcpExecuted/u);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);

  const reordered = records();
  const deterministicSource = createMcpKnowledgeSource({
    loadRecords: async () => ({
      articles: [
        article({
          id: "article_second",
          position: 1,
          slug: "second",
          title: "Second guide",
        }),
        ...[...reordered.articles].reverse(),
      ],
      categories: reordered.categories,
    }),
    siteOrigin,
  });
  assert.deepEqual(
    (await deterministicSource.search({ limit: 10, query: "published" })).results.map(
      (result) => result.articleId,
    ),
    ["article_public", "article_second"],
  );
});

test("MCP lists only deterministic read-only search and read tools", async () => {
  const response = await handleMcpRequest(
    protocolRequest(modernBody("tools/list")),
    testDependencies(),
  );
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.deepEqual(
    body.result._meta["io.modelcontextprotocol/serverInfo"],
    { name: "opas-public-help", version: "0.2.0" },
  );
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.ttlMs, 0);
  assert.equal(body.result.cacheScope, "private");
  assert.deepEqual(
    body.result.tools.map((tool: { name: string }) => tool.name),
    ["search", "read"],
  );
  for (const tool of body.result.tools) {
    assert.deepEqual(tool.annotations, {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema);
  }
});

test("MCP product metadata matches the OPAS Answers package version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  assert.equal(opasProductVersion, "0.2.0");
  assert.equal(packageJson.version, opasProductVersion);
});

test("MCP search and read return canonical structured published content", async () => {
  const searchResponse = await handleMcpRequest(
    protocolRequest(
      modernBody("tools/call", {
        args: { limit: 3, query: "published answer" },
        name: "search",
      }),
      { name: "search" },
    ),
    testDependencies(),
  );
  const searchBody = await responseJson(searchResponse);
  assert.equal(searchResponse.status, 200);
  assert.notEqual(searchBody.result.isError, true);
  assert.equal(searchBody.result.structuredContent.results.length, 1);
  assert.equal(
    searchBody.result.structuredContent.results[0].url,
    `${siteOrigin}/public/answer`,
  );

  const readResponse = await handleMcpRequest(
    protocolRequest(
      modernBody("tools/call", {
        args: { path: "/public/answer" },
        name: "read",
      }),
      { name: "read" },
    ),
    testDependencies(),
  );
  const readBody = await responseJson(readResponse);
  assert.equal(readResponse.status, 200);
  assert.notEqual(readBody.result.isError, true);
  assert.equal(readBody.result.structuredContent.title, "Public answer");
  assert.match(readBody.result.structuredContent.markdown, /^# Public answer/u);
});

test("MCP rejects obsolete lifecycle, protocol, and routing headers", async () => {
  const legacy = await handleMcpRequest(
    protocolRequest(
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" },
          protocolVersion: "2025-11-25",
        },
      },
      { protocolVersion: "2025-11-25" },
    ),
    testDependencies(),
  );
  assert.equal(legacy.status, 400);
  assert.equal((await responseJson(legacy)).error.code, -32022);

  const unsupportedBody = modernBody("tools/list", {
    protocolVersion: "2027-01-01",
  });
  const unsupported = await handleMcpRequest(
    protocolRequest(unsupportedBody, { protocolVersion: "2027-01-01" }),
    testDependencies(),
  );
  assert.equal(unsupported.status, 400);
  assert.equal((await responseJson(unsupported)).error.code, -32022);

  const missingVersionRequest = protocolRequest(modernBody("tools/list"));
  missingVersionRequest.headers.delete("MCP-Protocol-Version");
  const missingVersion = await handleMcpRequest(
    missingVersionRequest,
    testDependencies(),
  );
  assert.equal(missingVersion.status, 400);
  const missingVersionBody = await responseJson(missingVersion);
  assert.equal(missingVersionBody.error.code, -32020);
  assert.equal(missingVersionBody.id, 1);

  const mismatchedVersion = await handleMcpRequest(
    protocolRequest(
      modernBody("tools/list", { protocolVersion: "2027-01-01" }),
    ),
    testDependencies(),
  );
  assert.equal(mismatchedVersion.status, 400);
  assert.equal((await responseJson(mismatchedVersion)).error.code, -32020);

  const mismatchedHeader = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), {
      protocolVersion: "2027-01-01",
    }),
    testDependencies(),
  );
  assert.equal(mismatchedHeader.status, 400);
  assert.equal((await responseJson(mismatchedHeader)).error.code, -32020);

  const missingMethodRequest = protocolRequest(modernBody("tools/list"));
  missingMethodRequest.headers.delete("Mcp-Method");
  const missingMethod = await handleMcpRequest(
    missingMethodRequest,
    testDependencies(),
  );
  assert.equal(missingMethod.status, 400);
  assert.equal((await responseJson(missingMethod)).error.code, -32020);

  const missingNameRequest = protocolRequest(
    modernBody("tools/call", {
      args: { query: "published" },
      name: "search",
    }),
  );
  const missingName = await handleMcpRequest(
    missingNameRequest,
    testDependencies(),
  );
  assert.equal(missingName.status, 400);
  assert.equal((await responseJson(missingName)).error.code, -32020);

  const mismatchedName = await handleMcpRequest(
    protocolRequest(
      modernBody("tools/call", {
        args: { query: "published" },
        name: "search",
      }),
      { name: "read" },
    ),
    testDependencies(),
  );
  assert.equal(mismatchedName.status, 400);
  assert.equal((await responseJson(mismatchedName)).error.code, -32020);
});

test("MCP enforces safe Origin, negotiation, media type, method, and body limits", async () => {
  for (const origin of [
    "https://foreign.example",
    `${siteOrigin}/`,
    "null",
    "not an origin",
  ]) {
    const response = await handleMcpRequest(
      protocolRequest(modernBody("tools/list"), { origin }),
      testDependencies(),
    );
    assert.equal(response.status, 403);
  }

  for (const origin of [undefined, siteOrigin]) {
    const response = await handleMcpRequest(
      protocolRequest(modernBody("tools/list"), { origin }),
      testDependencies(),
    );
    assert.equal(response.status, 200);
  }

  const unacceptable = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), { accept: "application/json" }),
    testDependencies(),
  );
  assert.equal(unacceptable.status, 406);

  const excludedJson = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), {
      accept: "application/json;q=0, text/event-stream",
    }),
    testDependencies(),
  );
  assert.equal(excludedJson.status, 406);

  const unsupportedMedia = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), { contentType: "text/plain" }),
    testDependencies(),
  );
  assert.equal(unsupportedMedia.status, 415);

  const get = await handleMcpRequest(
    protocolRequest(null, { method: "GET" }),
    testDependencies(),
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal(get.headers.get("cache-control"), "no-store, no-transform");
  assert.match(get.headers.get("content-security-policy") ?? "", /default-src 'none'/u);

  const declaredLarge = protocolRequest(modernBody("tools/list"), {
    headers: { "Content-Length": String(maximumMcpRequestUtf8Bytes + 1) },
  });
  const tooLarge = await handleMcpRequest(declaredLarge, testDependencies());
  assert.equal(tooLarge.status, 413);

  const streamedLarge = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), {
      rawBody: "x".repeat(maximumMcpRequestUtf8Bytes + 1),
    }),
    testDependencies(),
  );
  assert.equal(streamedLarge.status, 413);

  const malformed = await handleMcpRequest(
    protocolRequest(modernBody("tools/list"), { rawBody: "{" }),
    testDependencies(),
  );
  assert.equal(malformed.status, 400);
  assert.equal((await responseJson(malformed)).error.message, "MCP request body must be valid JSON.");
});

test("MCP sanitizes knowledge failures before returning or logging them", async () => {
  const secret = "postgres://private-password@database.internal/opas";
  const reports: Array<{ type: string }> = [];
  const knowledge: McpKnowledgeSource = {
    async read() {
      return null;
    },
    async search() {
      throw new Error(secret);
    },
  };
  const response = await handleMcpRequest(
    protocolRequest(
      modernBody("tools/call", {
        args: { query: "published" },
        name: "search",
      }),
      { name: "search" },
    ),
    {
      ...testDependencies(knowledge),
      reportError: (details) => reports.push(details),
    },
  );
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.result.isError, true);
  assert.equal(
    body.result.content[0]?.text,
    "Published help search is temporarily unavailable.",
  );
  assert.doesNotMatch(JSON.stringify(body), /private-password/u);
  assert.deepEqual(reports, [{ type: "Error" }]);
});

test("MCP keeps subscription responses and their isolated server alive until cancellation", async () => {
  let handler: McpHttpHandler | undefined;
  const response = await handleMcpRequest(
    protocolRequest({
      id: 1,
      jsonrpc: "2.0",
      method: "subscriptions/listen",
      params: {
        notifications: {},
        _meta: {
          ...clientMetadata,
          "io.modelcontextprotocol/clientInfo": {
            name: "subscription-test",
            version: "1.0.0",
          },
        },
      },
    }),
    {
      ...testDependencies(),
      onHandlerCreated(created) {
        handler = created;
      },
    },
  );
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.ok(response.body);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(
    new TextDecoder().decode(first.value),
    /notifications\/subscriptions\/acknowledged/u,
  );
  const pendingRead = reader.read();
  const state = await Promise.race([
    pendingRead.then(() => "settled" as const),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 25);
    }),
  ]);
  assert.equal(state, "pending");
  assert.ok(handler);

  await reader.cancel("test complete");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await assert.rejects(
    handler.fetch(protocolRequest(modernBody("tools/list"))),
    /handler has been closed/u,
  );
});

test("concurrent requests with colliding IDs use and close isolated servers without response cross-talk", async () => {
  let started = 0;
  let closed = 0;
  let release!: () => void;
  const together = new Promise<void>((resolve) => {
    release = resolve;
  });
  const knowledge: McpKnowledgeSource = {
    async read() {
      return null;
    },
    async search({ query }): Promise<McpSearchOutput> {
      started += 1;
      if (started === 2) release();
      await together;
      return { query, results: [] };
    },
  };
  const servers = new Set<object>();
  const dependencies = {
    ...testDependencies(knowledge),
    onServerCreated: (server: McpServer) => {
      servers.add(server);
      server.server.onclose = () => {
        closed += 1;
      };
    },
  };

  const [first, second] = await Promise.all([
    handleMcpRequest(
      protocolRequest(
        modernBody("tools/call", {
          args: { query: "first client" },
          id: 7,
          name: "search",
        }),
        { name: "search" },
      ),
      dependencies,
    ),
    handleMcpRequest(
      protocolRequest(
        modernBody("tools/call", {
          args: { query: "second client" },
          id: 7,
          name: "search",
        }),
        { name: "search" },
      ),
      dependencies,
    ),
  ]);
  const [firstBody, secondBody] = await Promise.all([
    responseJson(first),
    responseJson(second),
  ]);

  assert.equal(servers.size, 2);
  assert.equal(closed, 2);
  assert.equal(firstBody.id, 7);
  assert.equal(secondBody.id, 7);
  assert.equal(firstBody.result.structuredContent.query, "first client");
  assert.equal(secondBody.result.structuredContent.query, "second client");
});

test("the MCP server surface bundles with workerd conditions", async () => {
  const result = await build({
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import"],
    entryPoints: ["src/mcp/server.ts"],
    external: ["@/db"],
    format: "esm",
    logLevel: "silent",
    platform: "neutral",
    tsconfig: "tsconfig.json",
    write: false,
  });

  assert.equal(result.outputFiles.length, 1);
  const source = result.outputFiles[0]?.text ?? "";
  assert.match(source, /new PerRequestHTTPServerTransport/u);
  assert.doesNotMatch(source, /fumadocs|createArticleMdxCompiler/u);
});
