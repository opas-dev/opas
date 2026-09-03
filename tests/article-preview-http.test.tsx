// ABOUTME: Verifies signed-preview fragment exchange, scoped cookies, and private asset responses.
// ABOUTME: Proves origin, indexing, referrer, bearer-hygiene, and exact-revision HTTP boundaries.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";

import {
  assertMaintenanceArtifactBoundary,
  maintenanceCloudflareConfig,
  prepareMaintenanceProject,
} from "../scripts/maintenance-artifact";

import { ArticlePreviewEntry } from "@/app/preview/preview-entry";
import {
  issueArticlePreview,
  type ActiveArticlePreviewGrant,
  type ArticlePreviewAsset,
  type ArticlePreviewRepository,
  type ArticlePreviewRevision,
} from "@/auth/article-preview";
import {
  handleArticlePreviewAsset,
  handleArticlePreviewExchange,
  handleArticlePreviewSession,
} from "@/auth/article-preview-http";
import {
  articlePreviewCookieName,
  createArticlePreviewGrantId,
  createArticlePreviewToken,
} from "@/auth/preview-claims";
import {
  maintenanceCode,
  proxy as maintenanceProxy,
} from "@/maintenance/proxy";
import { config as proxyConfiguration, proxy } from "@/proxy";

const origin = "https://docs.example.test";
const now = new Date("2026-09-03T12:00:00.000Z");
const expiresAt = new Date("2026-09-10T12:00:00.000Z");
const configuration = Object.freeze({
  deploymentId: "docs.example.test",
  signingSecret: "preview-http-signing-secret-with-at-least-32-bytes",
});
const actor = Object.freeze({
  memberId: "member_preview_editor",
  sessionId: "session_preview_editor",
  workspaceId: "workspace_preview",
});
const assetHash = "a".repeat(64);
const otherAssetHash = "b".repeat(64);

function fixedBytes(offset = 0) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

function previewGrant(
  overrides: Partial<ActiveArticlePreviewGrant> = {},
): ActiveArticlePreviewGrant {
  return Object.freeze({
    articleId: "article_preview",
    createdAt: now,
    createdByMemberId: actor.memberId,
    expiresAt,
    grantId: createArticlePreviewGrantId(fixedBytes()),
    revisionId: "revision_preview_4",
    workspaceId: actor.workspaceId,
    ...overrides,
  });
}

function previewRevision(record: ActiveArticlePreviewGrant): ArticlePreviewRevision {
  return Object.freeze({
    ...record,
    assetHashes: [assetHash],
    authorName: "Editor",
    categoryName: "Guides",
    categorySlug: "guides",
    isFaq: false,
    mdx: `# Canary preview\n\n![Stored](/api/assets/${assetHash})\n\n![Remote](https://cdn.remote.test/image.png)`,
    position: 4,
    revisionNumber: 4,
    revisionSavedAt: new Date("2026-09-03T11:58:00.000Z"),
    slug: "canary-preview",
    title: "Canary preview",
  });
}

function previewAsset(record: ActiveArticlePreviewGrant): ArticlePreviewAsset {
  return Object.freeze({
    ...record,
    byteSize: 8,
    content: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    hash: assetHash,
    mediaType: "image/png",
  });
}

function memoryRepository() {
  let active: ActiveArticlePreviewGrant | null = null;
  let readable = true;
  const rotations: unknown[] = [];
  const repository: ArticlePreviewRepository = {
    async findActiveGrant(request) {
      return readable &&
        active?.grantId === request.grantId &&
        active.revisionId === request.revisionId &&
        active.workspaceId === request.workspaceId &&
        active.expiresAt.getTime() > request.checkedAt.getTime()
        ? active
        : null;
    },
    async findManagedGrant(request) {
      return active?.workspaceId === request.actor.workspaceId &&
        active.revisionId === request.revisionId
        ? active
        : null;
    },
    async readActiveAsset(request) {
      const record = await repository.findActiveGrant(request);
      return record && request.hash === assetHash ? previewAsset(record) : null;
    },
    async readActiveRevision(request) {
      const record = await repository.findActiveGrant(request);
      return record ? previewRevision(record) : null;
    },
    async revokeGrant() {
      active = null;
      return { outcome: "revoked" };
    },
    async rotateGrant(request) {
      rotations.push(request);
      active = previewGrant({
        createdAt: request.createdAt,
        createdByMemberId: request.actor.memberId,
        expiresAt: request.expiresAt,
        grantId: request.grantId,
        revisionId: request.revisionId,
        workspaceId: request.actor.workspaceId,
      });
      return { outcome: "issued" };
    },
  };
  return {
    denyReads() {
      readable = false;
    },
    repository,
    rotations,
  };
}

function browserRequest(
  pathname: string,
  options: Readonly<{
    body?: unknown;
    cookie?: string;
    method?: "GET" | "POST";
    originHeader?: string;
    requestOrigin?: string;
  }> = {},
) {
  const method = options.method ?? "GET";
  const headers = new Headers({
    accept: "application/json",
    referer: `${origin}/preview`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("origin", options.originHeader ?? origin);
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest(`${options.requestOrigin ?? origin}${pathname}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
  });
}

function runtime(repository: ArticlePreviewRepository, clock = () => now) {
  return { clock, configuration, repository, siteOrigin: origin };
}

async function issuedPreview(repository: ArticlePreviewRepository) {
  const result = await issueArticlePreview(actor, "revision_preview_4", configuration, {
    clock: () => now,
    randomBytes: fixedBytes(),
    repository,
  });
  assert.equal(result.outcome, "issued");
  if (result.outcome !== "issued") throw new Error("PREVIEW_NOT_ISSUED");
  return result;
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/u,
  );
}

test("same-origin exchange returns only one host-only scoped preview cookie", async () => {
  const harness = memoryRepository();
  const preview = await issuedPreview(harness.repository);
  const request = browserRequest("/preview/exchange", {
    body: { bearer: preview.token },
    method: "POST",
  });
  const response = await handleArticlePreviewExchange(
    request,
    runtime(harness.repository),
  );

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { outcome: "exchanged" });
  assertPrivateHeaders(response);
  const name = articlePreviewCookieName(configuration.deploymentId);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^${name}=`, "u"));
  assert.match(cookie, /Path=\/preview/u);
  assert.match(cookie, /Max-Age=604800/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=lax/iu);
  assert.match(cookie, /Priority=high/iu);
  assert.doesNotMatch(cookie, /Domain=/iu);
  assert.doesNotMatch(body, new RegExp(preview.token, "u"));
  assert.doesNotMatch(request.url, new RegExp(preview.token, "u"));
  assert.doesNotMatch(request.headers.get("referer") ?? "", new RegExp(preview.token, "u"));
  assert.equal(JSON.stringify(harness.rotations).includes(preview.token), false);
});

test("the preview cookie resolves its one revision and one referenced asset", async () => {
  const harness = memoryRepository();
  const preview = await issuedPreview(harness.repository);
  const name = articlePreviewCookieName(configuration.deploymentId);
  const cookie = `${name}=${preview.token}`;
  const session = await handleArticlePreviewSession(
    browserRequest("/preview/session", { cookie }),
    runtime(harness.repository, () => new Date(now.getTime() + 1_000)),
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { outcome: "active" });
  assertPrivateHeaders(session);

  const request = browserRequest(`/preview/assets/${assetHash}`, { cookie });
  const response = await handleArticlePreviewAsset(
    request,
    assetHash,
    runtime(harness.repository, () => new Date(now.getTime() + 1_000)),
  );
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), "8");
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    previewAsset(previewGrant()).content,
  );
  assert.doesNotMatch(request.url, new RegExp(preview.token, "u"));
  assert.doesNotMatch(request.headers.get("referer") ?? "", new RegExp(preview.token, "u"));

  const outsideRevision = await handleArticlePreviewAsset(
    browserRequest(`/preview/assets/${otherAssetHash}`, { cookie }),
    otherAssetHash,
    runtime(harness.repository, () => new Date(now.getTime() + 1_000)),
  );
  assert.equal(outsideRevision.status, 404);
  assert.match(outsideRevision.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assertPrivateHeaders(outsideRevision);
});

test("revision, workspace, expiry, archive, and creator rechecks clear rejected cookies", async () => {
  const harness = memoryRepository();
  const preview = await issuedPreview(harness.repository);
  const name = articlePreviewCookieName(configuration.deploymentId);

  const wrongRevision = await createArticlePreviewToken(
    {
      databaseExpiresAt: preview.expiresAt,
      grantId: preview.grantId,
      revisionId: "revision_preview_3",
      workspaceId: preview.workspaceId,
    },
    configuration.signingSecret,
    configuration.deploymentId,
    now,
  );
  const wrongWorkspace = await createArticlePreviewToken(
    {
      databaseExpiresAt: preview.expiresAt,
      grantId: preview.grantId,
      revisionId: preview.revisionId,
      workspaceId: "workspace_other",
    },
    configuration.signingSecret,
    configuration.deploymentId,
    now,
  );

  for (const token of [wrongRevision.token, wrongWorkspace.token]) {
    const rejected = await handleArticlePreviewSession(
      browserRequest("/preview/session", { cookie: `${name}=${token}` }),
      runtime(harness.repository, () => new Date(now.getTime() + 1_000)),
    );
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  }

  const expired = await handleArticlePreviewSession(
    browserRequest("/preview/session", {
      cookie: `${name}=${preview.token}`,
    }),
    runtime(harness.repository, () => new Date(expiresAt.getTime() + 1_000)),
  );
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("set-cookie") ?? "", /Max-Age=0/u);

  harness.denyReads();
  const archivedOrDisabled = await handleArticlePreviewAsset(
    browserRequest(`/preview/assets/${assetHash}`, {
      cookie: `${name}=${preview.token}`,
    }),
    assetHash,
    runtime(harness.repository, () => new Date(now.getTime() + 2_000)),
  );
  assert.equal(archivedOrDisabled.status, 404);
  assert.match(archivedOrDisabled.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("cross-origin and malformed exchanges fail without reflecting or clearing bearers", async () => {
  const harness = memoryRepository();
  const preview = await issuedPreview(harness.repository);
  const crossOrigin = await handleArticlePreviewExchange(
    browserRequest("/preview/exchange", {
      body: { bearer: preview.token },
      method: "POST",
      originHeader: "https://attacker.example",
    }),
    runtime(harness.repository),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("set-cookie"), null);
  assert.doesNotMatch(await crossOrigin.text(), new RegExp(preview.token, "u"));

  const wrongHost = await handleArticlePreviewExchange(
    browserRequest("/preview/exchange", {
      body: { bearer: preview.token },
      method: "POST",
      requestOrigin: "https://other.example.test",
    }),
    runtime(harness.repository),
  );
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.headers.get("set-cookie"), null);

  const malformed = await handleArticlePreviewExchange(
    browserRequest("/preview/exchange", {
      body: { bearer: preview.token, extra: true },
      method: "POST",
    }),
    runtime(harness.repository),
  );
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.doesNotMatch(await malformed.text(), new RegExp(preview.token, "u"));

  const oversized = browserRequest("/preview/exchange", {
    body: { bearer: preview.token },
    method: "POST",
  });
  oversized.headers.set("content-length", "2305");
  const rejectedSize = await handleArticlePreviewExchange(
    oversized,
    runtime(harness.repository),
  );
  assert.equal(rejectedSize.status, 413);
  assert.match(rejectedSize.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("the entry clears fragments before exchange and has no persistence or logging path", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/app/preview/preview-entry.tsx"),
    "utf8",
  );
  assert.ok(
    source.indexOf("history.replaceState") <
      source.indexOf("fetch(`${pathname}/exchange`"),
  );
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|console\.|document\.cookie/u,
  );
  assert.match(source, /referrerPolicy: "no-referrer"/u);
  assert.doesNotMatch(source, /[?&](?:token|bearer)=/u);

  const canary = "preview-canary-must-not-render";
  const html = renderToStaticMarkup(<ArticlePreviewEntry />);
  assert.doesNotMatch(html, new RegExp(canary, "u"));
  assert.doesNotMatch(html, /search|assistant|feedback|canonical|application\/ld\+json/iu);
});

test("the preview reader stays outside every public discovery producer", () => {
  const publicProducers = [
    "src/app/sitemap.ts",
    "src/app/llms.txt/route.ts",
    "src/app/llms-full.txt/route.ts",
    "src/app/api/search/route.ts",
    "src/app/api/markdown/[categorySlug]/[articleSlug]/route.ts",
    "src/app/mcp/route.ts",
    "src/content/publication-data.ts",
  ];
  for (const filename of publicProducers) {
    const source = readFileSync(path.join(process.cwd(), filename), "utf8");
    assert.doesNotMatch(source, /article-preview|article_preview_grants|\/preview/u);
  }

  const page = readFileSync(
    path.join(process.cwd(), "src/app/preview/page.tsx"),
    "utf8",
  );
  assert.doesNotMatch(
    page,
    /PublicHeader|Search|ArticleFeedback|ArticleViewBeacon|ArticleActions|JSON-LD|canonical/u,
  );
  assert.match(page, /remoteImageHosts/u);
  assert.match(page, /viewer’s IP address and request timing/u);
});

test("proxy policy covers the preview document and every scoped asset", async () => {
  for (const pathname of ["/preview", `/preview/assets/${assetHash}`]) {
    const response = await proxy(new NextRequest(`${origin}${pathname}`));
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assertPrivateHeaders(response);
  }
  assert.ok(proxyConfiguration.matcher.includes("/preview/:path*"));
});

test("maintenance artifacts remove and block previews while omitting their secret", async () => {
  const cloudflare = maintenanceCloudflareConfig({
    d1_databases: [{ binding: "DB", database_name: "opas-mvp" }],
    name: "opas-mvp",
    vars: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_PREVIEW_SIGNING_SECRET: "must-not-remain",
      OPAS_SITE_URL: origin,
    },
  });
  assert.equal(
    (cloudflare.vars as Record<string, unknown>).OPAS_PREVIEW_SIGNING_SECRET,
    undefined,
  );

  for (const pathname of ["/preview", `/preview/assets/${assetHash}`]) {
    const response = maintenanceProxy(new NextRequest(`${origin}${pathname}`));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: maintenanceCode,
      message: "OPAS authoring is temporarily unavailable. Public help remains online.",
    });
  }

  const root = mkdtempSync(path.join(tmpdir(), "opas-preview-maintenance-"));
  try {
    for (const directory of [
      "src/app/preview/assets",
      "src/auth",
      "src/maintenance",
    ]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeFileSync(
      path.join(root, "src/app/preview/page.tsx"),
      "private preview route",
    );
    writeFileSync(
      path.join(root, "src/auth/preview-config.ts"),
      "OPAS_PREVIEW_SIGNING_SECRET",
    );
    writeFileSync(
      path.join(root, "src/maintenance/proxy.ts"),
      "maintenance proxy",
    );
    prepareMaintenanceProject(root);
    assert.throws(() => readFileSync(path.join(root, "src/app/preview/page.tsx")));
    assert.throws(() => readFileSync(path.join(root, "src/auth/preview-config.ts")));
    assert.doesNotThrow(() => assertMaintenanceArtifactBoundary(root));

    writeFileSync(
      path.join(root, "worker.js"),
      "process.env.OPAS_PREVIEW_SIGNING_SECRET",
    );
    assert.throws(
      () => assertMaintenanceArtifactBoundary(root),
      /forbidden administrator reference/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
