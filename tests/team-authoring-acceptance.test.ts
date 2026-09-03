// ABOUTME: Verifies disposable-target refusal and the reusable team-authoring acceptance scenario.
// ABOUTME: Runs the frozen fixture through real Postgres repositories and live preview HTTP handlers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type { CloudflareTarget } from "../scripts/bootstrap-cloudflare";
import { openNodePostgresAcceptanceBoundary } from "../scripts/team-authoring-acceptance-postgres";
import {
  acceptancePreviewSecret,
  parseTeamAuthoringAcceptanceCommand,
  validateCloudflareAcceptanceTarget,
  validateDatabaseAcceptanceTarget,
} from "../scripts/team-authoring-acceptance-target";

import {
  resolveArticlePreview,
} from "@/auth/article-preview";
import {
  handleArticlePreviewAsset,
  handleArticlePreviewExchange,
  handleArticlePreviewSession,
} from "@/auth/article-preview-http";
import { articlePreviewResponseHeaders } from "@/auth/article-preview-headers";
import { articlePreviewCookieName } from "@/auth/preview-claims";
import type { ArticlePreviewConfiguration } from "@/auth/preview-environment";
import {
  runTeamAuthoringAcceptance,
  teamAuthoringAcceptanceCheckIds,
  type TeamAuthoringAcceptanceBoundary,
} from "@/evaluation/team-authoring-acceptance";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";
import {
  canonicalTeamAuthoringMain,
  hashTeamAuthoringPublicSurface,
  serializeTeamAuthoringPublicSurface,
} from "@/evaluation/team-authoring-public-surfaces";

const runId = "harness-test-001";
const previewSecret = "acceptance-preview-secret-that-is-never-reported";

test("acceptance runtime sources contain no maintained production hostname", () => {
  const source = [
    "scripts/team-authoring-acceptance-postgres.ts",
    "scripts/team-authoring-acceptance-target.ts",
    "scripts/team-authoring-acceptance.ts",
    "src/evaluation/team-authoring-acceptance.ts",
    "tests/fixtures/team-authoring-acceptance-d1/custom-worker.ts",
    "tests/fixtures/team-authoring-acceptance-d1/wrangler.jsonc",
  ]
    .map((file) => readFileSync(path.join(process.cwd(), file), "utf8"))
    .join("\n");
  const maintainedHostnames = [
    ["demo", "opas", "dev"].join("."),
    ["demo-cro", "opas", "dev"].join("."),
    ["opas", "dev"].join("."),
    ["www", "opas", "dev"].join("."),
    ["opas-mvp", "timo-bejan", "workers", "dev"].join("."),
    ["opas-demo-cro", "timo-bejan", "workers", "dev"].join("."),
  ];
  for (const hostname of maintainedHostnames) {
    assert.equal(source.includes(hostname), false, hostname);
  }
});

function command(
  target: "cloudflare" | "docker" | "vercel",
  origin: string,
  configPath?: string,
) {
  return parseTeamAuthoringAcceptanceCommand([
    "--target",
    target,
    "--origin",
    origin,
    "--run-id",
    runId,
    "--confirm-disposable",
    runId,
    ...(configPath ? ["--config", configPath] : []),
  ]);
}

test("requires one matching bounded disposable confirmation", () => {
  assert.throws(
    () =>
      parseTeamAuthoringAcceptanceCommand([
        "--target",
        "docker",
        "--origin",
        "http://127.0.0.1:3000",
        "--run-id",
        runId,
        "--confirm-disposable",
        "different-run",
      ]),
    /ACCEPTANCE_DISPOSABLE_CONFIRMATION_INVALID/u,
  );
  assert.throws(
    () => command("docker", "http://127.0.0.1:3000", "wrangler.jsonc"),
    /ACCEPTANCE_ARGUMENTS_INVALID/u,
  );
  assert.throws(
    () => acceptancePreviewSecret({}),
    /ACCEPTANCE_PREVIEW_SECRET_MISSING/u,
  );
  assert.equal(
    acceptancePreviewSecret({ OPAS_ACCEPTANCE_PREVIEW_SIGNING_SECRET: previewSecret }),
    previewSecret,
  );
});

test("refuses maintained and non-disposable Docker and Vercel identities", () => {
  const maintained = [
    ["demo", "opas", "dev"].join("."),
    ["demo-cro", "opas", "dev"].join("."),
    ["opas", "dev"].join("."),
    ["www", "opas", "dev"].join("."),
  ];
  for (const hostname of maintained) {
    assert.throws(
      () =>
        validateDatabaseAcceptanceTarget(command("vercel", `https://${hostname}`), {
          NEON_DATABASE_URL:
            "postgresql://acceptance:secret@example.neon.tech/opas_acceptance_harness_test_001",
        }),
      /ACCEPTANCE_MAINTAINED_TARGET_FORBIDDEN/u,
    );
  }

  assert.throws(
    () =>
      validateDatabaseAcceptanceTarget(command("docker", "https://127.0.0.1:3000"), {
        DATABASE_URL:
          "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_harness_test_001",
      }),
    /ACCEPTANCE_DOCKER_ORIGIN_NOT_LOOPBACK/u,
  );
  assert.throws(
    () =>
      validateDatabaseAcceptanceTarget(
        command(
          "vercel",
          `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`,
        ),
        {
          NEON_DATABASE_URL:
            "postgresql://acceptance:secret@example.neon.tech/neondb?sslmode=require",
        },
      ),
    /ACCEPTANCE_NEON_DATABASE_NOT_DISPOSABLE/u,
  );
});

test("accepts only exact run-scoped Docker and Vercel database identities", () => {
  assert.deepEqual(
    validateDatabaseAcceptanceTarget(command("docker", "http://127.0.0.1:3100"), {
      DATABASE_URL:
        "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_harness_test_001",
    }),
    {
      connectionString:
        "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_harness_test_001",
      databaseName: "opas_acceptance_harness_test_001",
      kind: "docker-postgres",
      origin: "http://127.0.0.1:3100",
    },
  );
  assert.equal(
    validateDatabaseAcceptanceTarget(
      command(
        "vercel",
        `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`,
      ),
      {
        NEON_DATABASE_URL:
          "postgresql://acceptance:secret@example.neon.tech/opas_acceptance_harness_test_001?sslmode=require",
      },
    ).kind,
    "vercel-neon",
  );
  assert.throws(
    () =>
      validateDatabaseAcceptanceTarget(
        command(
          "vercel",
          `https://opas-acceptance-${runId}-another-team.vercel.app`,
        ),
        {
          NEON_DATABASE_URL:
            "postgresql://acceptance:secret@example.neon.tech/opas_acceptance_harness_test_001?sslmode=require",
        },
      ),
    /ACCEPTANCE_VERCEL_ORIGIN_NOT_DISPOSABLE/u,
  );
});

test("rejects database query overrides before opening Docker or Neon", () => {
  const dockerUrl =
    "postgresql://acceptance:secret@127.0.0.1/opas_acceptance_harness_test_001";
  const neonUrl =
    "postgresql://acceptance:secret@example.neon.tech/opas_acceptance_harness_test_001?sslmode=require";
  const overrides = [
    "host=production.example",
    "hostaddr=203.0.113.10",
    "port=6543",
    "dbname=production",
    "database=production",
    "ssl=true",
    "sslmode=disable",
    "sslcert=%2Ftmp%2Fclient.crt",
    "%68ost=production.example",
    "host%61ddr=203.0.113.10",
    "%70ort=6543",
    "db%6Eame=production",
    "%73slmode=disable",
  ];

  for (const parameter of overrides) {
    assert.throws(
      () =>
        validateDatabaseAcceptanceTarget(
          command("docker", "http://127.0.0.1:3100"),
          { DATABASE_URL: `${dockerUrl}?${parameter}` },
        ),
      /ACCEPTANCE_DATABASE_PARAMETERS_FORBIDDEN/u,
      `Docker accepted ${parameter}`,
    );
    assert.throws(
      () =>
        validateDatabaseAcceptanceTarget(
          command(
            "vercel",
            `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`,
          ),
          { NEON_DATABASE_URL: `${neonUrl}&${parameter}` },
        ),
      /ACCEPTANCE_NEON_PARAMETERS_INVALID/u,
      `Neon accepted ${parameter}`,
    );
  }

  assert.equal(
    validateDatabaseAcceptanceTarget(
      command(
        "vercel",
        `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`,
      ),
      { NEON_DATABASE_URL: `${neonUrl}&channel_binding=require` },
    ).kind,
    "vercel-neon",
  );

  for (const duplicate of [
    "sslmode=require&sslmode=require",
    "sslmode=require&channel_binding=require&channel_binding=require",
  ]) {
    assert.throws(
      () =>
        validateDatabaseAcceptanceTarget(
          command(
            "vercel",
            `https://opas-acceptance-${runId}-timo-bejans-projects.vercel.app`,
          ),
          {
            NEON_DATABASE_URL:
              `postgresql://acceptance:secret@example.neon.tech/opas_acceptance_harness_test_001?${duplicate}`,
          },
        ),
      /ACCEPTANCE_NEON_PARAMETERS_INVALID/u,
      `Neon accepted duplicate parameters: ${duplicate}`,
    );
  }
});

test("accepts only a route-free matching Cloudflare Worker and D1 pair", () => {
  const origin = `https://opas-acceptance-${runId}.${[
    "timo-bejan",
    "workers",
    "dev",
  ].join(".")}`;
  const target: CloudflareTarget = {
    accountId: "a".repeat(32),
    config: { preview_urls: false, workers_dev: true },
    configPath: "acceptance.wrangler.jsonc",
    databaseId: "b".repeat(32),
    databaseName: `opas-acceptance-${runId}`,
    secretNames: [],
    siteOrigin: origin,
    sourcePrefix: "",
    workerName: `opas-acceptance-${runId}`,
  };
  assert.equal(
    validateCloudflareAcceptanceTarget(
      command("cloudflare", origin, target.configPath),
      target,
    ).kind,
    "cloudflare-d1",
  );
  assert.throws(
    () =>
      validateCloudflareAcceptanceTarget(
        command("cloudflare", origin, target.configPath),
        { ...target, config: { ...target.config, routes: [] } },
      ),
    /ACCEPTANCE_CLOUDFLARE_TARGET_NOT_DISPOSABLE/u,
  );
  const unrelatedOrigin = `https://opas-acceptance-${runId}.another.workers.dev`;
  assert.throws(
    () =>
      validateCloudflareAcceptanceTarget(
        command("cloudflare", unrelatedOrigin, target.configPath),
        { ...target, siteOrigin: unrelatedOrigin },
      ),
    /ACCEPTANCE_CLOUDFLARE_TARGET_NOT_DISPOSABLE/u,
  );
  assert.throws(
    () =>
      validateCloudflareAcceptanceTarget(
        command("cloudflare", origin, target.configPath),
        { ...target, databaseName: "opas-mvp" },
      ),
    /ACCEPTANCE_CLOUDFLARE_TARGET_NOT_DISPOSABLE/u,
  );
  for (const workerName of ["opas-mvp", "opas-demo-cro"]) {
    const maintainedOrigin = `https://${[
      workerName,
      "timo-bejan",
      "workers",
      "dev",
    ].join(".")}`;
    assert.throws(
      () =>
        validateCloudflareAcceptanceTarget(
          command("cloudflare", maintainedOrigin, target.configPath),
          {
            ...target,
            databaseName: workerName,
            siteOrigin: maintainedOrigin,
            workerName,
          },
        ),
      /ACCEPTANCE_CLOUDFLARE_TARGET_NOT_DISPOSABLE/u,
    );
  }
});

test("canonical public surfaces retain content while excluding DOM transport noise", async () => {
  const first = canonicalTeamAuthoringMain(
    '<html><main id="content" class="page" nonce="one">\n<h1> Team authoring </h1><!--react--><p>Exact text</p></main></html>',
  );
  const second = canonicalTeamAuthoringMain(
    '<main nonce="two" class="page" id="content"><h1>Team   authoring</h1><p>Exact text</p></main>',
  );
  assert.equal(first, second);

  const left = serializeTeamAuthoringPublicSurface({ search: { results: [2, 1], query: "x" } });
  const right = serializeTeamAuthoringPublicSurface({ search: { query: "x", results: [2, 1] } });
  const reordered = serializeTeamAuthoringPublicSurface({
    search: { query: "x", results: [1, 2] },
  });
  assert.equal(left, right);
  assert.notEqual(left, reordered);
  assert.equal(
    await hashTeamAuthoringPublicSurface(left),
    await hashTeamAuthoringPublicSurface(right),
  );
  assert.notEqual(
    await hashTeamAuthoringPublicSurface(left),
    await hashTeamAuthoringPublicSurface(reordered),
  );
});

async function requestFromNode(incoming: IncomingMessage, origin: string) {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name && value) headers.append(name, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return new Request(`${origin}${incoming.url ?? "/"}`, {
    body: body.byteLength === 0 ? undefined : body,
    headers,
    method: incoming.method,
  });
}

async function sendNodeResponse(outgoing: ServerResponse, response: Response) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function acceptanceMarkdown(source: string) {
  const markdown = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return markdown ? `${markdown}\n` : "";
}

function publicMcpResult(id: unknown, value: object) {
  return Response.json({ id, jsonrpc: "2.0", result: value });
}

async function startPreviewServer(
  acceptanceBoundary: () => TeamAuthoringAcceptanceBoundary,
  configuration: ArticlePreviewConfiguration,
) {
  let origin = "";
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await requestFromNode(incoming, origin);
      const url = new URL(request.url);
      const boundary = acceptanceBoundary();
      const runtime = { configuration, repository: boundary.previews, siteOrigin: origin };
      const article = teamAuthoringStandard.publishedArticle;
      const category = teamAuthoringStandard.categories[0];
      assert.ok(category);
      const projection = await boundary.readPublicProjection(article.articleId);
      const articlePath = `/${category.slug}/${article.slug}`;
      const escapedTitle = projection?.article.title
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;") ?? "";
      if (url.pathname === "/api/health") {
        return sendNodeResponse(outgoing, Response.json({ status: "ok" }));
      }
      if (url.pathname === "/preview/exchange" && request.method === "POST") {
        return sendNodeResponse(outgoing, await handleArticlePreviewExchange(request, runtime));
      }
      if (url.pathname === "/preview/session") {
        return sendNodeResponse(outgoing, await handleArticlePreviewSession(request, runtime));
      }
      if (url.pathname.startsWith("/preview/assets/")) {
        return sendNodeResponse(
          outgoing,
          await handleArticlePreviewAsset(
            request,
            url.pathname.slice("/preview/assets/".length),
            runtime,
          ),
        );
      }
      if (url.pathname === "/preview") {
        const cookieName = articlePreviewCookieName(configuration.deploymentId);
        const token = (request.headers.get("cookie") ?? "")
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const preview = await resolveArticlePreview(token, configuration, {
          repository: boundary.previews,
        });
        return sendNodeResponse(
          outgoing,
          new Response(
            preview
              ? `<main><p>Private preview</p><h1>${preview.title}</h1></main>`
              : "<main>Preview unavailable</main>",
            {
              headers: {
                ...articlePreviewResponseHeaders,
                "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
              },
            },
          ),
        );
      }
      if (url.pathname === "/") {
        return sendNodeResponse(
          outgoing,
          new Response(
            `<main id="main-content"><h1>Help</h1>${
              projection ? `<a href="${articlePath}">${escapedTitle}</a>` : ""
            }</main>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
        );
      }
      if (url.pathname === `/${category.slug}`) {
        return sendNodeResponse(
          outgoing,
          new Response(
            `<main id="main-content"><h1>${category.name}</h1>${
              projection ? `<a href="${articlePath}">${escapedTitle}</a>` : ""
            }</main>`,
            {
              headers: { "content-type": "text/html; charset=utf-8" },
              status: projection ? 200 : 404,
            },
          ),
        );
      }
      if (url.pathname === articlePath) {
        if (!projection) {
          return sendNodeResponse(
            outgoing,
            new Response('<main id="main-content"><h1>Not found</h1></main>', {
              headers: { "content-type": "text/html; charset=utf-8" },
              status: 404,
            }),
          );
        }
        const jsonLd = JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Article",
          headline: projection.article.title,
          mainEntityOfPage: `${origin}${articlePath}`,
        });
        return sendNodeResponse(
          outgoing,
          new Response(
            `<script id="opas-article-jsonld" type="application/ld+json">${jsonLd}</script><main class="article-shell" id="main-content"><h1>${escapedTitle}</h1></main>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
        );
      }
      if (url.pathname === "/api/search") {
        return sendNodeResponse(
          outgoing,
          Response.json({
            error: null,
            query: url.searchParams.get("q") ?? "",
            results: projection
              ? [{
                  category: category.name,
                  excerpt: "Acceptance article",
                  href: articlePath,
                  id: article.articleId,
                  title: projection.article.title,
                }]
              : [],
          }),
        );
      }
      if (url.pathname === "/sitemap.xml") {
        const urls = [
          `${origin}/`,
          ...teamAuthoringStandard.categories.map(({ slug }) => `${origin}/${slug}`),
          ...(projection ? [`${origin}${articlePath}`] : []),
        ];
        return sendNodeResponse(
          outgoing,
          new Response(
            `<?xml version="1.0"?><urlset>${urls
              .map((entry) => `<url><loc>${entry}</loc></url>`)
              .join("")}</urlset>`,
            { headers: { "content-type": "application/xml" } },
          ),
        );
      }
      if (url.pathname === "/llms.txt") {
        return sendNodeResponse(
          outgoing,
          new Response(
            projection
              ? `# Help\n\n- [${projection.article.title}](${origin}${articlePath}.md)\n`
              : "# Help\n",
          ),
        );
      }
      if (url.pathname === "/llms-full.txt") {
        return sendNodeResponse(
          outgoing,
          new Response(
            projection
              ? `# ${projection.article.title}\nSource: ${origin}${articlePath}\n\n${projection.article.mdx}\n`
              : "",
          ),
        );
      }
      if (url.pathname === `${articlePath}.md`) {
        return sendNodeResponse(
          outgoing,
          projection
            ? new Response(acceptanceMarkdown(projection.article.mdx))
            : new Response("Not Found\n", { status: 404 }),
        );
      }
      if (url.pathname.startsWith("/api/assets/")) {
        const hash = url.pathname.slice("/api/assets/".length);
        if (!projection?.assetHashes.includes(hash)) {
          return sendNodeResponse(outgoing, new Response("Not Found\n", { status: 404 }));
        }
        const fixtureAsset = teamAuthoringStandard.assets.find(
          (candidate) => candidate.hash === hash,
        );
        assert.ok(fixtureAsset);
        const content = hash === teamAuthoringStandard.assets[0]?.hash
          ? Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        return sendNodeResponse(
          outgoing,
          new Response(content, { headers: { "content-type": fixtureAsset.mediaType } }),
        );
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const body = await request.json() as {
          id?: unknown;
          method?: unknown;
          params?: { arguments?: Record<string, unknown>; name?: unknown };
        };
        if (body.method === "tools/list") {
          return sendNodeResponse(
            outgoing,
            publicMcpResult(body.id, {
              tools: [{ name: "search" }, { name: "read" }],
            }),
          );
        }
        if (body.method === "tools/call" && body.params?.name === "search") {
          const value = {
            query: String(body.params.arguments?.query ?? ""),
            results: projection
              ? [{
                  articleId: article.articleId,
                  path: articlePath,
                  title: projection.article.title,
                }]
              : [],
          };
          return sendNodeResponse(
            outgoing,
            publicMcpResult(body.id, {
              content: [{ text: JSON.stringify(value), type: "text" }],
              structuredContent: value,
            }),
          );
        }
        if (body.method === "tools/call" && body.params?.name === "read") {
          if (!projection) {
            return sendNodeResponse(
              outgoing,
              publicMcpResult(body.id, {
                content: [{ text: "The published article was not found.", type: "text" }],
                isError: true,
              }),
            );
          }
          const value = {
            articleId: article.articleId,
            markdown: acceptanceMarkdown(projection.article.mdx),
            path: articlePath,
            title: projection.article.title,
          };
          return sendNodeResponse(
            outgoing,
            publicMcpResult(body.id, {
              content: [{ text: JSON.stringify(value), type: "text" }],
              structuredContent: value,
            }),
          );
        }
      }
      return sendNodeResponse(outgoing, new Response("Not Found\n", { status: 404 }));
    } catch {
      outgoing.statusCode = 500;
      outgoing.end("Unavailable\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin,
  };
}

test(
  "the frozen scenario passes real Postgres persistence and live preview HTTP",
  { timeout: 180_000 },
  async () => {
    const databaseName = "opas_acceptance_harness_integration";
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase(databaseName)
      .start();
    const migrationPool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await migratePostgres(createPostgresDatabase(migrationPool), {
        migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
      });
    } finally {
      await migrationPool.end();
    }

    const acceptanceBoundary: { current?: TeamAuthoringAcceptanceBoundary } = {};
    const configuration = { deploymentId: "127.0.0.1", signingSecret: previewSecret };
    const server = await startPreviewServer(() => {
      assert.ok(acceptanceBoundary.current);
      return acceptanceBoundary.current;
    }, configuration);
    const opened = openNodePostgresAcceptanceBoundary(
      container.getConnectionUri(),
      databaseName,
      server.origin,
    );
    const settledTitles: string[] = [];
    acceptanceBoundary.current = Object.freeze({
      ...opened.boundary,
      async settlePublicProjection(articleId: string) {
        const projection = await opened.boundary.readPublicProjection(articleId);
        assert.ok(projection);
        settledTitles.push(projection.article.title);
      },
    });
    try {
      const report = await runTeamAuthoringAcceptance({
        boundary: acceptanceBoundary.current,
        previewConfiguration: configuration,
        target: {
          kind: "docker-postgres",
          origin: server.origin,
          runId: "integration-test",
        },
      });
      assert.equal(report.outcome, "passed", JSON.stringify(report));
      assert.deepEqual(
        report.checks.map(({ id, status }) => ({ id, status })),
        teamAuthoringAcceptanceCheckIds.map((id) => ({ id, status: "passed" })),
      );
      const serialized = JSON.stringify(report);
      assert.ok(Buffer.byteLength(serialized) <= 32_768);
      assert.equal(serialized.includes(previewSecret), false);
      assert.equal(report.fixture.contentHash, teamAuthoringStandard.contentHash);
      assert.match(report.publicSurfaceHashes.baseline ?? "", /^[0-9a-f]{64}$/u);
      assert.equal(
        report.publicSurfaceHashes.privateSaves,
        report.publicSurfaceHashes.baseline,
      );
      assert.match(report.publicSurfaceHashes.reviewed ?? "", /^[0-9a-f]{64}$/u);
      assert.notEqual(
        report.publicSurfaceHashes.reviewed,
        report.publicSurfaceHashes.baseline,
      );
      assert.equal(report.coverage.publicSurfaces, "live-http");
      assert.deepEqual(settledTitles, [
        teamAuthoringStandard.publishedArticle.title,
        "Acceptance private revision 10",
      ]);
      assert.deepEqual(report.limitations, [
        "BROWSER_ACCESSIBILITY_AND_MAINTENANCE_ROLLBACK_RUN_SEPARATELY",
      ]);
    } finally {
      await opened.close();
      await server.close();
      await container.stop();
    }
  },
);
