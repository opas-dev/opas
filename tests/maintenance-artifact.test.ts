// ABOUTME: Verifies retained rollback artifacts expose no administrator or scheduler surface.
// ABOUTME: Covers source pruning, binding removal, request blocking, and output inspection.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { parse } from "yaml";

import {
  assertMaintenanceArtifactBoundary,
  maintenanceCloudflareConfig,
  prepareMaintenanceProject,
} from "../scripts/maintenance-artifact";
import {
  prepareVercelProject,
  vercelBuildConfiguration,
} from "../scripts/build-vercel";
import { maintenanceCode, proxy } from "../src/maintenance/proxy";

const maintainedVercelOrigin =
  "https://opas-mvp-timo-bejans-projects.vercel.app";
const maintainedVercelProjectLink =
  '{"projectId":"prj_QRjweVxLSmxPL8JBbfaiLW8wl7Aj","orgId":"team_92dzVY5C6gOfuw6u6wVfh4w7","projectName":"opas-mvp"}\n';
const pooledNeonUrl =
  "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=require";
const directNeonUrl =
  "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech/opas?sslmode=require";

test("maintenance proxy blocks every admin path and non-read request", async () => {
  for (const request of [
    new NextRequest("https://help.invalid/admin"),
    new NextRequest("https://help.invalid/admin/login", {
      headers: { cookie: "opas_admin_session=historical" },
    }),
    new NextRequest("https://help.invalid/admin/content", {
      headers: { cookie: "opas_admin_session=stale-signed-session" },
    }),
    new NextRequest("https://help.invalid/admin", {
      headers: {
        authorization: "Bearer historical-credential",
        cookie: "opas_admin_session=forged-session; opas_preview=historical-preview",
      },
    }),
    new NextRequest("https://help.invalid/api/internal/embeddings", { method: "GET" }),
    new NextRequest("https://help.invalid/api/articles/article/feedback", {
      method: "POST",
    }),
  ]) {
    const response = proxy(request);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, maintenanceCode);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  const publicResponse = proxy(new NextRequest("https://help.invalid/getting-started"));
  assert.equal(publicResponse.headers.get("x-middleware-next"), "1");
});

test("project preparation removes private routes and schedules", () => {
  const root = mkdtempSync(join(tmpdir(), "opas-maintenance-test-"));
  try {
    for (const directory of [
      "src/app/admin/login",
      "src/app/api/internal/embeddings",
      "src/auth",
      "src/maintenance",
      "src/db/postgres",
      "src/db/sqlite",
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "src/app/admin/login/page.tsx"), "ADMIN_PASSWORD");
    writeFileSync(join(root, "src/app/api/internal/embeddings/route.ts"), "scheduled");
    writeFileSync(join(root, "src/auth/config.ts"), "ADMIN_SESSION_SECRET");
    writeFileSync(join(root, "src/proxy.ts"), "authenticated proxy");
    writeFileSync(join(root, "src/maintenance/proxy.ts"), "public maintenance proxy");
    for (const dialect of ["postgres", "sqlite"]) {
      const prefix = dialect === "postgres" ? "Postgres" : "Sqlite";
      writeFileSync(
        join(root, `src/db/${dialect}/repository.ts`),
        `import { create${prefix}ArticleDraftRepository } from "@/db/${dialect}/article-draft-repository";\n` +
          `const repository = {\n  ...create${prefix}ArticleDraftRepository(database),\n  publicRead() {},\n};\n`,
      );
      writeFileSync(
        join(root, `src/db/${dialect}/article-draft-repository.ts`),
        `export const create${prefix}ArticleDraftRepository = () => ({ publishArticle() {} });\n`,
      );
    }
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
    );
    writeFileSync(
      join(root, "vercel.json"),
      JSON.stringify({ framework: "nextjs", crons: [{ path: "/api/internal/embeddings" }] }),
    );

    prepareMaintenanceProject(root);
    assert.equal(readFileSync(join(root, "src/proxy.ts"), "utf8"), "public maintenance proxy");
    assert.equal(readFileSync(join(root, "vercel.json"), "utf8").includes("crons"), false);
    assert.equal(
      readFileSync(join(root, "src/auth/config.ts"), "utf8"),
      "ADMIN_SESSION_SECRET",
    );
    assert.throws(() => readFileSync(join(root, "src/app/admin/login/page.tsx")));
    assert.throws(() => readFileSync(join(root, "src/app/api/internal/embeddings/route.ts")));
    assert.doesNotMatch(
      readFileSync(join(root, "src/db/postgres/repository.ts"), "utf8"),
      /createPostgresArticleDraftRepository/u,
    );
    assert.doesNotMatch(
      readFileSync(join(root, "src/db/sqlite/repository.ts"), "utf8"),
      /createSqliteArticleDraftRepository/u,
    );
    assert.deepEqual(
      (JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
        include: string[];
      }).include,
      [
        "next-env.d.ts",
        "worker-configuration.d.ts",
        "src/**/*.ts",
        "src/**/*.tsx",
        ".next/types/**/*.ts",
        ".next/dev/types/**/*.ts",
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("maintenance Cloudflare config retains reads and removes active integrations", () => {
  assert.deepEqual(
    maintenanceCloudflareConfig({
      ai: { binding: "AI" },
      d1_databases: [{ binding: "DB", database_name: "opas-mvp" }],
      main: "custom-worker.ts",
      name: "opas-mvp",
      secrets: { required: ["ADMIN_EMAIL"] },
      send_email: [{ name: "SUPPORT_EMAIL" }],
      services: [{ binding: "WORKER_SELF_REFERENCE" }],
      triggers: { crons: ["* * * * *"] },
      vars: {
        ADMIN_EMAIL: "must-not-remain",
        NEXTJS_ENV: "production",
        OPAS_DATABASE_DRIVER: "d1",
        OPAS_GENERATION_MODEL: "must-not-remain",
        OPAS_PUBLIC_PROFILE: "opas",
        OPAS_SITE_URL: "https://demo.opas.dev",
      },
    }),
    {
      d1_databases: [{ binding: "DB", database_name: "opas-mvp" }],
      main: ".open-next/worker.js",
      name: "opas-mvp",
      vars: {
        NEXTJS_ENV: "production",
        OPAS_DATABASE_DRIVER: "d1",
        OPAS_PUBLIC_PROFILE: "opas",
        OPAS_SITE_URL: "https://demo.opas.dev",
      },
    },
  );
});

test("artifact inspection rejects administrator environment readers", () => {
  const root = mkdtempSync(join(tmpdir(), "opas-maintenance-output-"));
  try {
    writeFileSync(join(root, "worker.js"), "public help runtime");
    assert.doesNotThrow(() => assertMaintenanceArtifactBoundary(root));
    writeFileSync(join(root, "worker.js"), "process.env.ADMIN_EMAIL");
    assert.throws(
      () => assertMaintenanceArtifactBoundary(root),
      /forbidden private reference/u,
    );
    writeFileSync(
      join(root, "worker.js"),
      "createPostgresArticleDraftRepository(database)",
    );
    assert.throws(
      () => assertMaintenanceArtifactBoundary(root),
      /forbidden private reference/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Vercel maintenance inputs prune admin code and require only Neon reads", () => {
  const root = mkdtempSync(join(tmpdir(), "opas-maintenance-vercel-"));
  try {
    for (const directory of [
      ".vercel",
      "src/app/admin/login",
      "src/app/api/internal/embeddings",
      "src/auth",
      "src/maintenance",
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, ".vercel/project.json"), maintainedVercelProjectLink);
    writeFileSync(
      join(root, ".env"),
      `NEON_DATABASE_URL=${pooledNeonUrl}\nNEON_DIRECT_DATABASE_URL=${directNeonUrl}\n`,
    );
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "src/proxy.ts"), "authenticated proxy\n");
    writeFileSync(join(root, "src/maintenance/proxy.ts"), "maintenance proxy\n");
    writeFileSync(join(root, "src/auth/config.ts"), "administrator reader\n");
    writeFileSync(join(root, "src/app/admin/login/page.tsx"), "login\n");
    writeFileSync(
      join(root, "vercel.json"),
      JSON.stringify({
        crons: [{ path: "/api/internal/embeddings", schedule: "0 0 * * *" }],
        framework: "nextjs",
      }),
    );

    const configuration = vercelBuildConfiguration(
      maintainedVercelOrigin,
      root,
      {},
      { maintenance: true },
    );
    assert.equal(configuration.environment.NEON_DATABASE_URL, pooledNeonUrl);
    assert.equal(configuration.environment.ADMIN_EMAIL, undefined);
    assert.equal(configuration.environment.ADMIN_PASSWORD, undefined);
    assert.equal(configuration.environment.ADMIN_SESSION_SECRET, undefined);
    assert.throws(() =>
      vercelBuildConfiguration(maintainedVercelOrigin, root, {}),
    );

    const prepared = prepareVercelProject(root, { maintenance: true });
    try {
      assert.equal(readFileSync(join(prepared.directory, "src/proxy.ts"), "utf8"), "maintenance proxy\n");
      assert.equal(
        "crons" in JSON.parse(readFileSync(join(prepared.directory, "vercel.json"), "utf8")),
        false,
      );
      assert.equal(
        readFileSync(join(prepared.directory, "src/auth/config.ts"), "utf8"),
        "administrator reader\n",
      );
      assert.throws(() =>
        readFileSync(join(prepared.directory, "src/app/admin/login/page.tsx")),
      );
    } finally {
      prepared.dispose();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Docker maintenance target starts only the pruned standalone server", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
  const maintenance = dockerfile.split(" AS maintenance\n")[1];
  assert.ok(maintenance);
  assert.match(maintenance, /COPY --from=maintenance-builder/u);
  assert.match(maintenance, /CMD \["node", "server\.js"\]/u);
  assert.doesNotMatch(maintenance, /prepare-postgres|seed|embedding-recovery|analytics-cleanup/u);

  const compose = parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as {
    services: Record<string, Record<string, unknown>>;
  };
  const service = compose.services["app-maintenance"];
  assert.deepEqual(service.profiles, ["maintenance"]);
  assert.deepEqual(service.build, { context: ".", target: "maintenance" });
  const environment = service.environment as Record<string, string>;
  assert.equal(environment.ADMIN_EMAIL, undefined);
  assert.equal(environment.ADMIN_PASSWORD, undefined);
  assert.equal(environment.ADMIN_SESSION_SECRET, undefined);
  assert.equal(environment.CRON_SECRET, undefined);
});
