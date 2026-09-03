// ABOUTME: Captures the fixed public surfaces used by the team-authoring acceptance run.
// ABOUTME: Canonicalizes semantic payloads while retaining every content-bearing field.

export type TeamAuthoringEvidenceRow = Readonly<{
  articleContentHash: string;
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  createdAt: string;
  embeddingInputHash: string;
  embeddingText: string;
  evidenceText: string;
  headingPath: readonly string[];
  id: string;
  indexGeneration: number;
  markdown: string;
  ordinal: number;
  publicationState: "published";
  sourceLineEnd: number;
  sourceLineStart: number;
  title: string;
  updatedAt: string;
  workspaceId: string;
}>;

export type TeamAuthoringIndexRow = Readonly<{
  activeEmbeddingGenerationId: string | null;
  generation: number;
  updatedAt: string;
  workspaceId: string;
}>;

export type TeamAuthoringRagProjection = Readonly<{
  evidence: readonly TeamAuthoringEvidenceRow[];
  index: readonly TeamAuthoringIndexRow[];
}>;

export type TeamAuthoringSurfaceArticle = Readonly<{
  articleId: string;
  categorySlug: string;
  markdown: string;
  publicAssetHashes: readonly string[];
  slug: string;
  title: string;
}>;

type SurfaceFetch = typeof globalThis.fetch;

type PublicSurfaceInput = Readonly<{
  allAssetHashes: readonly string[];
  article: TeamAuthoringSurfaceArticle;
  fetch?: SurfaceFetch;
  origin: string;
  publicRecords: unknown;
  ragRecords: TeamAuthoringRagProjection;
}>;

type ArchiveSurfaceInput = PublicSurfaceInput &
  Readonly<{
    publicRecords: null;
  }>;

type JsonRecord = Record<string, unknown>;

const mcpProtocolVersion = "2026-07-28";
const publicSearchQuery = "Start here";
const utf8 = new TextEncoder();

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class TeamAuthoringPublicSurfaceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TeamAuthoringPublicSurfaceError";
    this.code = code;
  }
}

function requireSurface(value: unknown, code: string): asserts value {
  if (!value) throw new TeamAuthoringPublicSurfaceError(code);
}

function record(value: unknown, code: string): JsonRecord {
  requireSurface(
    typeof value === "object" && value !== null && !Array.isArray(value),
    code,
  );
  return value as JsonRecord;
}

function array(value: unknown, code: string): unknown[] {
  requireSurface(Array.isArray(value), code);
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function serializeTeamAuthoringPublicSurface(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Hex(value: Uint8Array) {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hashTeamAuthoringPublicSurface(serialized: string) {
  return sha256Hex(utf8.encode(serialized));
}

async function fetchSurface(
  fetcher: SurfaceFetch,
  input: string,
  init?: RequestInit,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetcher(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseBytes(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

function responseText(bytes: Uint8Array, code: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TeamAuthoringPublicSurfaceError(code);
  }
}

async function readText(
  fetcher: SurfaceFetch,
  url: string,
  code: string,
  init?: RequestInit,
) {
  const response = await fetchSurface(fetcher, url, init);
  const bytes = await responseBytes(response);
  requireSurface(response.status === 200, code);
  return { bytes, response, text: responseText(bytes, `${code}_UTF8`) };
}

function extractMain(document: string) {
  const tags = /<\/?main\b[^>]*>/giu;
  let start = -1;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(document))) {
    if (start < 0) {
      if (match[0].startsWith("</")) continue;
      start = match.index;
      depth = 1;
      continue;
    }
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return document.slice(start, tags.lastIndex);
  }
  throw new TeamAuthoringPublicSurfaceError("PUBLIC_MAIN_MISSING");
}

function canonicalTag(source: string) {
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)(\/?)\s*>$/u.exec(
    source,
  );
  requireSurface(match, "PUBLIC_HTML_TAG_INVALID");
  const closing = match[1] === "/";
  const name = match[2]?.toLowerCase();
  requireSurface(name, "PUBLIC_HTML_TAG_INVALID");
  if (closing) return `</${name}>`;

  const attributes: Array<readonly [string, string | null]> = [];
  const attributeSource = match[3] ?? "";
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gyu;
  let offset = 0;
  while (offset < attributeSource.length) {
    while (/\s/u.test(attributeSource[offset] ?? "")) offset += 1;
    if (offset >= attributeSource.length) break;
    attributePattern.lastIndex = offset;
    const attribute = attributePattern.exec(attributeSource);
    requireSurface(attribute, "PUBLIC_HTML_ATTRIBUTE_INVALID");
    const attributeName = attribute[1]?.toLowerCase();
    requireSurface(attributeName, "PUBLIC_HTML_ATTRIBUTE_INVALID");
    if (attributeName !== "nonce") {
      attributes.push([
        attributeName,
        attribute[2] ?? attribute[3] ?? attribute[4] ?? null,
      ]);
    }
    offset = attributePattern.lastIndex;
  }
  attributes.sort(([leftName, leftValue], [rightName, rightValue]) => {
    const byName = compareText(leftName, rightName);
    return byName || compareText(String(leftValue), String(rightValue));
  });
  const serializedAttributes = attributes
    .map(([attributeName, value]) =>
      value === null
        ? ` ${attributeName}`
        : ` ${attributeName}=${JSON.stringify(value)}`,
    )
    .join("");
  return `<${name}${serializedAttributes}${match[4] === "/" ? "/" : ""}>`;
}

export function canonicalTeamAuthoringMain(document: string) {
  const main = extractMain(document).replace(/<!--[\s\S]*?-->/gu, "");
  const tokens = main.match(/<[^>]*>|[^<]+/gu) ?? [];
  return tokens
    .map((token) => {
      if (token.startsWith("<")) return canonicalTag(token);
      return token.replace(/\s+/gu, " ").trim();
    })
    .filter(Boolean)
    .join("");
}

function jsonBody(text: string, code: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TeamAuthoringPublicSurfaceError(code);
  }
}

function canonicalJsonLd(document: string) {
  const scripts: unknown[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(document))) {
    const attributes = match[1] ?? "";
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/iu.test(attributes)) continue;
    scripts.push(jsonBody(match[2] ?? "", "PUBLIC_JSONLD_INVALID"));
  }
  return scripts
    .map(canonicalValue)
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function sitemapUrls(document: string) {
  return [...document.matchAll(/<loc>([\s\S]*?)<\/loc>/giu)]
    .map((match) => (match[1] ?? "").trim().replaceAll("&amp;", "&"))
    .sort(compareText);
}

function articlePath(article: TeamAuthoringSurfaceArticle) {
  return `/${article.categorySlug}/${article.slug}`;
}

function markdownPath(article: TeamAuthoringSurfaceArticle) {
  return `${articlePath(article)}.md`;
}

function mcpRequest(method: string, name?: string, args?: JsonRecord) {
  const metadata = {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "opas-team-authoring-acceptance",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/protocolVersion": mcpProtocolVersion,
  };
  const body = {
    id: 1,
    jsonrpc: "2.0",
    method,
    params: {
      ...(name ? { name } : {}),
      ...(args ? { arguments: args } : {}),
      _meta: metadata,
    },
  };
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": mcpProtocolVersion,
  });
  if (name) headers.set("mcp-name", name);
  return { body: JSON.stringify(body), headers, method: "POST" } satisfies RequestInit;
}

function canonicalMcpBody(text: string) {
  const body = record(jsonBody(text, "PUBLIC_MCP_JSON_INVALID"), "PUBLIC_MCP_BODY_INVALID");
  const withoutRequestId = { ...body };
  delete withoutRequestId.id;
  const result = record(withoutRequestId.result, "PUBLIC_MCP_RESULT_INVALID");
  const content = Array.isArray(result.content) ? result.content : [];
  const normalizedContent = content.map((item) => {
    const entry = record(item, "PUBLIC_MCP_CONTENT_INVALID");
    if (typeof entry.text !== "string") return entry;
    try {
      return { ...entry, text: serializeTeamAuthoringPublicSurface(JSON.parse(entry.text)) };
    } catch {
      return entry;
    }
  });
  return canonicalValue({
    ...withoutRequestId,
    result: { ...result, ...(content.length > 0 ? { content: normalizedContent } : {}) },
  });
}

function mcpStructuredContent(value: unknown, code: string) {
  const body = record(value, code);
  const result = record(body.result, code);
  return record(result.structuredContent, code);
}

function normalizedMarkdown(source: string) {
  const markdown = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return markdown ? `${markdown}\n` : "";
}

async function exactBytes(bytes: Uint8Array) {
  return {
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

async function publicAsset(
  fetcher: SurfaceFetch,
  origin: string,
  hash: string,
  published: boolean,
) {
  const response = await fetchSurface(fetcher, `${origin}/api/assets/${hash}`);
  const bytes = await responseBytes(response);
  requireSurface(
    response.status === (published ? 200 : 404),
    published ? "PUBLIC_ASSET_MISSING" : "PRIVATE_ASSET_PUBLIC",
  );
  return {
    body: await exactBytes(bytes),
    hash,
    mediaType: response.headers.get("content-type"),
    status: response.status,
  };
}

export async function captureTeamAuthoringPublicSurfaces({
  allAssetHashes,
  article,
  fetch: suppliedFetch,
  origin,
  publicRecords,
  ragRecords,
}: PublicSurfaceInput) {
  const fetcher = suppliedFetch ?? globalThis.fetch;
  const path = articlePath(article);
  const articleUrl = `${origin}${path}`;
  const articleMarkdownUrl = `${origin}${markdownPath(article)}`;
  const [
    articlePage,
    categoryPage,
    homePage,
    search,
    sitemap,
    llms,
    llmsFull,
    markdown,
    mcpTools,
    mcpSearch,
    mcpRead,
    assets,
  ] = await Promise.all([
    readText(fetcher, articleUrl, "PUBLIC_ARTICLE_MISSING"),
    readText(fetcher, `${origin}/${article.categorySlug}`, "PUBLIC_CATEGORY_MISSING"),
    readText(fetcher, `${origin}/`, "PUBLIC_HOME_MISSING"),
    readText(
      fetcher,
      `${origin}/api/search?q=${encodeURIComponent(publicSearchQuery)}`,
      "PUBLIC_SEARCH_FAILED",
    ),
    readText(fetcher, `${origin}/sitemap.xml`, "PUBLIC_SITEMAP_FAILED"),
    readText(fetcher, `${origin}/llms.txt`, "PUBLIC_LLMS_FAILED"),
    readText(fetcher, `${origin}/llms-full.txt`, "PUBLIC_LLMS_FULL_FAILED"),
    readText(fetcher, articleMarkdownUrl, "PUBLIC_MARKDOWN_MISSING"),
    readText(
      fetcher,
      `${origin}/mcp`,
      "PUBLIC_MCP_TOOLS_FAILED",
      mcpRequest("tools/list"),
    ),
    readText(
      fetcher,
      `${origin}/mcp`,
      "PUBLIC_MCP_SEARCH_FAILED",
      mcpRequest("tools/call", "search", { limit: 10, query: publicSearchQuery }),
    ),
    readText(
      fetcher,
      `${origin}/mcp`,
      "PUBLIC_MCP_READ_FAILED",
      mcpRequest("tools/call", "read", { path }),
    ),
    Promise.all(
      [...allAssetHashes].sort().map((hash) =>
        publicAsset(
          fetcher,
          origin,
          hash,
          article.publicAssetHashes.includes(hash),
        ),
      ),
    ),
  ]);

  const searchBody = record(
    jsonBody(search.text, "PUBLIC_SEARCH_JSON_INVALID"),
    "PUBLIC_SEARCH_BODY_INVALID",
  );
  const searchResults = array(searchBody.results, "PUBLIC_SEARCH_RESULTS_INVALID");
  requireSurface(
    searchResults.some((item) => record(item, "PUBLIC_SEARCH_RESULT_INVALID").id === article.articleId),
    "PUBLIC_SEARCH_ARTICLE_MISSING",
  );
  const urls = sitemapUrls(sitemap.text);
  requireSurface(
    urls.includes(articleUrl) &&
      urls.includes(`${origin}/${article.categorySlug}`) &&
      urls.includes(`${origin}/`),
    "PUBLIC_SITEMAP_ARTICLE_MISSING",
  );
  const jsonLd = canonicalJsonLd(articlePage.text);
  requireSurface(
    jsonLd.some((value) => {
      const entry = record(value, "PUBLIC_JSONLD_INVALID");
      return entry.headline === article.title && entry.mainEntityOfPage === articleUrl;
    }),
    "PUBLIC_JSONLD_ARTICLE_MISSING",
  );
  requireSurface(
    llms.text.includes(articleMarkdownUrl) && llmsFull.text.includes(articleUrl),
    "PUBLIC_LLMS_ARTICLE_MISSING",
  );
  requireSurface(
    markdown.text === normalizedMarkdown(article.markdown),
    "PUBLIC_MARKDOWN_CONTENT_MISMATCH",
  );
  const canonicalTools = canonicalMcpBody(mcpTools.text);
  const canonicalSearch = canonicalMcpBody(mcpSearch.text);
  const canonicalRead = canonicalMcpBody(mcpRead.text);
  const mcpSearchContent = mcpStructuredContent(canonicalSearch, "PUBLIC_MCP_SEARCH_INVALID");
  const mcpSearchResults = array(
    mcpSearchContent.results,
    "PUBLIC_MCP_SEARCH_RESULTS_INVALID",
  );
  requireSurface(
    mcpSearchResults.some(
      (item) => record(item, "PUBLIC_MCP_SEARCH_RESULT_INVALID").articleId === article.articleId,
    ),
    "PUBLIC_MCP_SEARCH_ARTICLE_MISSING",
  );
  const mcpReadContent = mcpStructuredContent(canonicalRead, "PUBLIC_MCP_READ_INVALID");
  requireSurface(
    mcpReadContent.title === article.title &&
      mcpReadContent.markdown === normalizedMarkdown(article.markdown),
    "PUBLIC_MCP_READ_CONTENT_MISMATCH",
  );
  requireSurface(ragRecords.evidence.length > 0, "PUBLIC_RAG_EVIDENCE_MISSING");
  requireSurface(
    ragRecords.evidence.every(({ articleId }) => articleId === article.articleId) &&
      ragRecords.index.length === 1,
    "PUBLIC_RAG_PROJECTION_INVALID",
  );

  return serializeTeamAuthoringPublicSurface({
    assets,
    html: {
      article: canonicalTeamAuthoringMain(articlePage.text),
      category: canonicalTeamAuthoringMain(categoryPage.text),
      home: canonicalTeamAuthoringMain(homePage.text),
    },
    jsonLd,
    llms: {
      full: await exactBytes(llmsFull.bytes),
      index: await exactBytes(llms.bytes),
    },
    markdown: await exactBytes(markdown.bytes),
    mcp: { read: canonicalRead, search: canonicalSearch, tools: canonicalTools },
    publicRecords,
    rag: ragRecords,
    search: canonicalValue(searchBody),
    sitemap: urls,
  });
}

function excludesArticle(value: string, article: TeamAuthoringSurfaceArticle) {
  return !value.includes(article.articleId) &&
    !value.includes(articlePath(article)) &&
    !value.includes(article.title);
}

export async function requireTeamAuthoringArchiveAbsent({
  allAssetHashes,
  article,
  fetch: suppliedFetch,
  origin,
  publicRecords,
  ragRecords,
}: ArchiveSurfaceInput) {
  requireSurface(publicRecords === null, "ARCHIVE_PUBLIC_RECORD_REMAINED");
  requireSurface(ragRecords.evidence.length === 0, "ARCHIVE_RAG_EVIDENCE_REMAINED");
  const fetcher = suppliedFetch ?? globalThis.fetch;
  const path = articlePath(article);
  const [
    articlePage,
    categoryPage,
    homePage,
    search,
    sitemap,
    llms,
    llmsFull,
    markdown,
    mcpSearch,
    mcpRead,
    assets,
  ] = await Promise.all([
    fetchSurface(fetcher, `${origin}${path}`),
    readText(fetcher, `${origin}/${article.categorySlug}`, "ARCHIVE_CATEGORY_FAILED"),
    readText(fetcher, `${origin}/`, "ARCHIVE_HOME_FAILED"),
    readText(
      fetcher,
      `${origin}/api/search?q=${encodeURIComponent(publicSearchQuery)}`,
      "ARCHIVE_SEARCH_FAILED",
    ),
    readText(fetcher, `${origin}/sitemap.xml`, "ARCHIVE_SITEMAP_FAILED"),
    readText(fetcher, `${origin}/llms.txt`, "ARCHIVE_LLMS_FAILED"),
    readText(fetcher, `${origin}/llms-full.txt`, "ARCHIVE_LLMS_FULL_FAILED"),
    fetchSurface(fetcher, `${origin}${markdownPath(article)}`),
    readText(
      fetcher,
      `${origin}/mcp`,
      "ARCHIVE_MCP_SEARCH_FAILED",
      mcpRequest("tools/call", "search", { limit: 10, query: publicSearchQuery }),
    ),
    readText(
      fetcher,
      `${origin}/mcp`,
      "ARCHIVE_MCP_READ_FAILED",
      mcpRequest("tools/call", "read", { path }),
    ),
    Promise.all(
      [...allAssetHashes].sort().map(async (hash) => {
        const response = await fetchSurface(fetcher, `${origin}/api/assets/${hash}`);
        await response.arrayBuffer();
        return response.status;
      }),
    ),
  ]);
  const articleBody = responseText(
    await responseBytes(articlePage),
    "ARCHIVE_ARTICLE_UTF8",
  );
  const markdownBody = responseText(
    await responseBytes(markdown),
    "ARCHIVE_MARKDOWN_UTF8",
  );
  requireSurface(articlePage.status === 404, "ARCHIVE_ARTICLE_REMAINED");
  requireSurface(
    canonicalJsonLd(articleBody).length === 0,
    "ARCHIVE_JSONLD_REMAINED",
  );
  requireSurface(markdown.status === 404, "ARCHIVE_MARKDOWN_REMAINED");
  requireSurface(
    excludesArticle(canonicalTeamAuthoringMain(categoryPage.text), article),
    "ARCHIVE_CATEGORY_ARTICLE_REMAINED",
  );
  requireSurface(
    excludesArticle(canonicalTeamAuthoringMain(homePage.text), article),
    "ARCHIVE_HOME_ARTICLE_REMAINED",
  );
  requireSurface(
    excludesArticle(search.text, article),
    "ARCHIVE_SEARCH_ARTICLE_REMAINED",
  );
  requireSurface(
    !sitemapUrls(sitemap.text).includes(`${origin}${path}`),
    "ARCHIVE_SITEMAP_ARTICLE_REMAINED",
  );
  requireSurface(
    excludesArticle(llms.text, article) && excludesArticle(llmsFull.text, article),
    "ARCHIVE_LLMS_ARTICLE_REMAINED",
  );
  requireSurface(excludesArticle(markdownBody, article), "ARCHIVE_MARKDOWN_BODY_REMAINED");

  const canonicalSearch = canonicalMcpBody(mcpSearch.text);
  const mcpSearchContent = mcpStructuredContent(canonicalSearch, "ARCHIVE_MCP_SEARCH_INVALID");
  requireSurface(
    array(mcpSearchContent.results, "ARCHIVE_MCP_SEARCH_RESULTS_INVALID").every(
      (item) => record(item, "ARCHIVE_MCP_SEARCH_RESULT_INVALID").articleId !== article.articleId,
    ),
    "ARCHIVE_MCP_SEARCH_ARTICLE_REMAINED",
  );
  const canonicalRead = record(canonicalMcpBody(mcpRead.text), "ARCHIVE_MCP_READ_INVALID");
  const readResult = record(canonicalRead.result, "ARCHIVE_MCP_READ_INVALID");
  requireSurface(readResult.isError === true, "ARCHIVE_MCP_READ_ARTICLE_REMAINED");
  requireSurface(assets.every((status) => status === 404), "ARCHIVE_ASSET_REMAINED");
}
