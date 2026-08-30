// ABOUTME: Proves Vercel builds cannot package local dotenv files or encoded secret values.
// ABOUTME: Covers isolated project inputs, validated build variables, and verified output copying.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertVercelArtifactIsSecretFree,
  buildVercelArtifact,
  copyPortableArtifact,
  copyVerifiedVercelOutput,
  deployVercelArtifact,
  makeVercelArtifactPortable,
  prepareVercelProject,
  validateVercelTarget,
  vercelBuildConfiguration,
  writeVercelArtifactIdentity,
  writeVercelDatabaseIdentity,
} from "../scripts/build-vercel";
import { requireNeonDirectConnectionString } from "../scripts/prepare-neon";

const maintainedOrigin =
  "https://opas-mvp-timo-bejans-projects.vercel.app";
const maintainedProjectLink =
  '{"projectId":"prj_QRjweVxLSmxPL8JBbfaiLW8wl7Aj","orgId":"team_92dzVY5C6gOfuw6u6wVfh4w7","projectName":"opas-mvp"}\n';
const acceptanceProject = "opas-v02-acceptance-01a0430f";
const acceptanceOrigin =
  `https://${acceptanceProject}-timo-bejans-projects.vercel.app`;
const adminPassword = "admin-password-do-not-package";
const adminSessionSecret = "session-secret-do-not-package".repeat(2);
const pooledUrl =
  "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=require";
const directUrl =
  "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech/opas?sslmode=require";
const neonIdentityHash = createHash("sha256").update(pooledUrl).digest("hex");
const artifactIdentityFile = ".opas-database-identity.json";

function environmentFile(overrides: Record<string, string> = {}) {
  return Object.entries({
    ADMIN_EMAIL: "Admin@opas.dev",
    ADMIN_PASSWORD: adminPassword,
    ADMIN_SESSION_SECRET: adminSessionSecret,
    DATABASE_URL: "postgresql://local:local-password@localhost/local",
    NEON_DATABASE_URL: pooledUrl,
    NEON_DIRECT_DATABASE_URL: directUrl,
    OPAS_GENERATION_API_KEY: "local-provider-secret",
    OPAS_EMBED_PARENT_ORIGINS: "https://opas.dev,https://www.opas.dev",
    OPAS_SITE_URL: "http://localhost:3000",
    VERCEL_TOKEN: "local-vercel-token",
    ...overrides,
  })
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-test-"));
  mkdirSync(join(workspace, "node_modules"));
  mkdirSync(join(workspace, "src"));
  mkdirSync(join(workspace, "src", "db"));
  mkdirSync(join(workspace, ".next"));
  mkdirSync(join(workspace, ".playwright-mcp"));
  mkdirSync(join(workspace, ".pnpm-store"));
  mkdirSync(join(workspace, ".vercel", "output"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), "{}\n");
  writeFileSync(
    join(workspace, "src", "source.ts"),
    "export const safe = true;\n",
  );
  writeFileSync(
    join(workspace, "src", "db", "deployment-identity.ts"),
    "export const artifactDatabaseDriver = undefined;\n",
  );
  writeFileSync(join(workspace, ".dev.vars"), "PRIVATE=value\n");
  writeFileSync(join(workspace, ".playwright-mcp", "trace.json"), "{}\n");
  writeFileSync(join(workspace, ".env"), `${environmentFile()}\n`);
  writeFileSync(join(workspace, ".env.example"), "ADMIN_PASSWORD=example\n");
  writeFileSync(join(workspace, ".next", "stale"), "stale\n");
  writeFileSync(join(workspace, ".pnpm-store", "cache"), "generated\n");
  writeFileSync(join(workspace, "tsconfig.tsbuildinfo"), "generated\n");
  writeFileSync(join(workspace, ".vercel", "output", "stale"), "stale\n");
  writeFileSync(join(workspace, ".vercel", "project.json"), maintainedProjectLink);
  return workspace;
}

function cleanOutput(workspace: string) {
  const output = join(workspace, "output");
  mkdirSync(join(output, "functions", "index.func"), { recursive: true });
  writeFileSync(join(output, "config.json"), "{}\n");
  writeFileSync(
    join(output, "functions", "index.func", "index.js"),
    "export default {};\n",
  );
  return output;
}

function materializeVercelFunction(output: string, manifestPath: string) {
  const functionRoot = mkdtempSync(join(tmpdir(), "opas-vercel-function-"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    filePathMap: Record<string, string>;
  };
  const outputPrefix = ".vercel/output/";

  for (const [deployedPath, sourcePath] of Object.entries(
    manifest.filePathMap,
  )) {
    assert.equal(sourcePath.startsWith(outputPrefix), true);
    const source = join(output, sourcePath.slice(outputPrefix.length));
    const destination = join(functionRoot, deployedPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  return functionRoot;
}

function changedProjectLink(overrides: Record<string, string>) {
  return `${JSON.stringify({
    ...(JSON.parse(maintainedProjectLink) as Record<string, unknown>),
    ...overrides,
  })}\n`;
}

test("prepares a linked Vercel project without environment or generated files", () => {
  const workspace = fixture();
  const prepared = prepareVercelProject(workspace);

  try {
    assert.equal(
      readFileSync(join(prepared.directory, "src", "source.ts"), "utf8"),
      "export const safe = true;\n",
    );
    assert.equal(
      readFileSync(join(prepared.directory, ".vercel", "project.json"), "utf8"),
      maintainedProjectLink,
    );
    assert.throws(() => lstatSync(join(prepared.directory, "node_modules")));
    assert.throws(() => readFileSync(join(prepared.directory, ".env")));
    assert.throws(() => readFileSync(join(prepared.directory, ".env.example")));
    assert.throws(() => readFileSync(join(prepared.directory, ".next", "stale")));
    assert.equal(existsSync(join(prepared.directory, ".pnpm-store")), false);
    assert.equal(existsSync(join(prepared.directory, ".dev.vars")), false);
    assert.equal(existsSync(join(prepared.directory, ".playwright-mcp")), false);
    assert.equal(existsSync(join(prepared.directory, "tsconfig.tsbuildinfo")), false);
    assert.throws(() =>
      readFileSync(join(prepared.directory, ".vercel", "output", "stale")),
    );
  } finally {
    prepared.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects secret-bearing files inside deployable input directories", () => {
  const workspace = fixture();

  try {
    mkdirSync(join(workspace, "src", "auth"));
    writeFileSync(
      join(workspace, "src", "auth", "credentials.ts"),
      "// ABOUTME: Defines a safe source-code fixture.\n// ABOUTME: Proves its domain name is not treated as credential data.\nexport const safe = true;\n",
    );
    const prepared = prepareVercelProject(workspace);
    try {
      assert.match(
        readFileSync(
          join(prepared.directory, "src", "auth", "credentials.ts"),
          "utf8",
        ),
        /export const safe = true/u,
      );
    } finally {
      prepared.dispose();
    }

    for (const name of ["credentials.json", "credentials.ts.bak"]) {
      const path = join(workspace, "src", "auth", name);
      writeFileSync(path, "{}\n");
      assert.throws(() => prepareVercelProject(workspace), /secret-bearing/u);
      rmSync(path);
    }

    writeFileSync(join(workspace, "src", "private.pem"), "private material\n");
    assert.throws(() => prepareVercelProject(workspace), /secret-bearing/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("writes the validated database identity only inside an isolated project", () => {
  const workspace = fixture();
  const prepared = prepareVercelProject(workspace);

  try {
    writeVercelDatabaseIdentity(prepared.directory, neonIdentityHash);
    const generated = readFileSync(
      join(prepared.directory, "src", "db", "deployment-identity.ts"),
      "utf8",
    );
    assert.match(generated, /artifactDatabaseDriver = "neon"/u);
    assert.match(generated, new RegExp(neonIdentityHash, "u"));
    assert.doesNotMatch(
      readFileSync(
        join(workspace, "src", "db", "deployment-identity.ts"),
        "utf8",
      ),
      /"neon"/u,
    );
    assert.throws(() =>
      writeVercelDatabaseIdentity(prepared.directory, "invalid"),
    );
  } finally {
    prepared.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("writes a strict non-secret database identity into the Vercel output", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-identity-test-"));

  try {
    const output = cleanOutput(workspace);
    writeVercelArtifactIdentity(output, neonIdentityHash);

    const path = join(output, artifactIdentityFile);
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      driver: "neon",
      neonDatabaseUrlSha256: neonIdentityHash,
    });
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test(
  "cleans the private Vercel project and blocks another command after a boundary signal",
  { timeout: 10_000 },
  async () => {
    const workspace = fixture();
    const preparedPath = join(workspace, "prepared-path");
    const startedPath = join(workspace, "started");
    const cleanedPath = join(workspace, "cleaned");
    const buildModuleUrl = pathToFileURL(resolve("scripts/build-vercel.ts")).href;
    const processModuleUrl = pathToFileURL(
      resolve("scripts/cloudflare-process.ts"),
    ).href;
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { prepareVercelProject } from ${JSON.stringify(buildModuleUrl)};
      import { runCloudflareProcess } from ${JSON.stringify(processModuleUrl)};
      const prepared = prepareVercelProject(${JSON.stringify(workspace)});
      writeFileSync(${JSON.stringify(preparedPath)}, dirname(prepared.directory));
      process.emit("SIGTERM");
      try {
        await runCloudflareProcess(
          process.execPath,
          ["--eval", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "unsafe")`)}],
          { cwd: process.cwd(), environment: process.env },
        );
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 1700));
      writeFileSync(${JSON.stringify(cleanedPath)}, existsSync(dirname(prepared.directory)) ? "no" : "yes");
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    );

    try {
      const exitCode = await new Promise<number | null>((resolveExit) =>
        child.once("exit", resolveExit),
      );
      assert.equal(exitCode, 143);
      assert.equal(existsSync(startedPath), false);
      assert.equal(readFileSync(cleanedPath, "utf8"), "yes");
      assert.equal(existsSync(readFileSync(preparedPath, "utf8")), false);
    } finally {
      if (child.exitCode === null && child.pid) child.kill("SIGKILL");
      rmSync(workspace, { force: true, recursive: true });
    }
  },
);

test("accepts only the maintained OPAS project identity", () => {
  const workspace = fixture();

  try {
    assert.doesNotThrow(() => validateVercelTarget(workspace));
    const changedLinks: Array<Record<string, string>> = [
      { projectName: "another-project" },
      { projectId: "another-project-id" },
      { orgId: "another-organization-id" },
    ];
    for (const changed of changedLinks) {
      writeFileSync(
        join(workspace, ".vercel", "project.json"),
        changedProjectLink(changed),
      );
      assert.throws(() => validateVercelTarget(workspace));
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("accepts only explicitly enabled disposable project names and their exact Vercel origin", () => {
  const workspace = fixture();

  try {
    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({
        projectId: "prj_disposable",
        projectName: acceptanceProject,
      }),
    );

    assert.throws(() => validateVercelTarget(workspace));
    assert.equal(
      validateVercelTarget(workspace, { acceptance: true }).projectName,
      acceptanceProject,
    );
    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({ projectName: acceptanceProject }),
    );
    assert.throws(() =>
      validateVercelTarget(workspace, { acceptance: true }),
    );
    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({
        orgId: "team_other",
        projectId: "prj_disposable",
        projectName: acceptanceProject,
      }),
    );
    assert.throws(() =>
      validateVercelTarget(workspace, { acceptance: true }),
    );
    assert.doesNotThrow(() =>
      vercelBuildConfiguration(acceptanceOrigin, workspace, {}, {
        acceptanceProject,
      }),
    );
    for (const origin of [
      maintainedOrigin,
      `https://${acceptanceProject}-other.vercel.app`,
      "https://acceptance.opas.dev",
    ]) {
      assert.throws(() =>
        vercelBuildConfiguration(origin, workspace, {}, {
          acceptanceProject,
        }),
      );
    }

    for (const projectName of [
      "opas-mvp",
      "opas-v02-acceptance-",
      "opas-v02-acceptance-Invalid",
      "unrelated-opas-v02-acceptance-test",
    ]) {
      writeFileSync(
        join(workspace, ".vercel", "project.json"),
        changedProjectLink({ projectName }),
      );
      assert.throws(() =>
        validateVercelTarget(workspace, { acceptance: true }),
      );
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects symbolic-link project metadata and .vercel parents", () => {
  const workspace = fixture();
  const external = mkdtempSync(join(tmpdir(), "opas-vercel-link-test-"));

  try {
    rmSync(join(workspace, ".vercel", "project.json"));
    writeFileSync(join(external, "project.json"), maintainedProjectLink);
    symlinkSync(
      join(external, "project.json"),
      join(workspace, ".vercel", "project.json"),
    );
    assert.throws(() => validateVercelTarget(workspace));

    rmSync(join(workspace, ".vercel"), { force: true, recursive: true });
    mkdirSync(join(external, ".vercel"));
    writeFileSync(
      join(external, ".vercel", "project.json"),
      maintainedProjectLink,
    );
    symlinkSync(join(external, ".vercel"), join(workspace, ".vercel"), "dir");
    assert.throws(() => validateVercelTarget(workspace));
  } finally {
    rmSync(external, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("validates the linked target before deleting saved output", async () => {
  const workspace = fixture();

  try {
    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({ projectId: "another-project-id" }),
    );
    await assert.rejects(() =>
      buildVercelArtifact(maintainedOrigin, { environment: {}, workspace }),
    );
    assert.equal(
      readFileSync(join(workspace, ".vercel", "output", "stale"), "utf8"),
      "stale\n",
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects another canonical deployment origin", () => {
  const workspace = fixture();

  try {
    assert.throws(() =>
      vercelBuildConfiguration(
        "https://another-project.vercel.app",
        workspace,
        {},
      ),
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("passes only validated runtime values and keeps the direct URL out of the build", () => {
  const workspace = fixture();

  try {
    const configuration = vercelBuildConfiguration(
      maintainedOrigin,
      workspace,
      {
        AWS_SECRET_ACCESS_KEY: "process-cloud-secret",
        DATABASE_URL: "postgresql://process:process-password@localhost/process",
        GITHUB_TOKEN: "process-github-token",
        HOME: "/tmp/test-home",
        HTTPS_PROXY: "https://proxy-user:proxy-secret@proxy.example.com",
        HTTP_PROXY: "https://proxy.example.com",
        NODE_EXTRA_CA_CERTS: "/tmp/attacker-ca.pem",
        NODE_OPTIONS: "--require=/tmp/injected.cjs",
        NPM_CONFIG_USERCONFIG: "/tmp/attacker.npmrc",
        OPAS_GENERATION_API_KEY: "process-provider-secret",
        PATH: "/bin",
        PGPASSWORD: "process-postgres-password",
        POSTGRES_URL:
          "postgresql://process:process-postgres-url-password@localhost/process",
        REDIS_URL: "redis://default:process-redis-password@localhost:6379",
        SENTRY_DSN: "https://process-sentry-key@sentry.example.com/1",
        VERCEL_TOKEN: "process-vercel-token",
      },
    );

    assert.equal(configuration.environment.PATH, "/bin");
    assert.equal(configuration.environment.HOME, undefined);
    assert.equal(configuration.environment.OPAS_DATABASE_DRIVER, "neon");
    assert.equal(configuration.environment.OPAS_SITE_URL, maintainedOrigin);
    assert.equal(
      configuration.environment.OPAS_EMBED_PARENT_ORIGINS,
      "https://opas.dev,https://www.opas.dev",
    );
    assert.equal(configuration.environment.NEON_DATABASE_URL, pooledUrl);
    assert.equal(configuration.neonIdentityHash, neonIdentityHash);
    assert.equal(configuration.environment.NEON_DIRECT_DATABASE_URL, undefined);
    assert.equal(configuration.environment.ADMIN_EMAIL, "admin@opas.dev");
    assert.equal(configuration.environment.ADMIN_PASSWORD, adminPassword);
    assert.equal(configuration.environment.ADMIN_SESSION_SECRET, adminSessionSecret);
    assert.equal(configuration.environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(configuration.environment.DATABASE_URL, undefined);
    assert.equal(configuration.environment.GITHUB_TOKEN, undefined);
    assert.equal(configuration.environment.HTTPS_PROXY, undefined);
    assert.equal(configuration.environment.HTTP_PROXY, undefined);
    assert.equal(configuration.environment.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(configuration.environment.NODE_OPTIONS, undefined);
    assert.equal(configuration.environment.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(configuration.environment.OPAS_GENERATION_API_KEY, undefined);
    assert.equal(configuration.environment.VERCEL_TOKEN, "process-vercel-token");
    assert.equal(configuration.secretValues.includes("admin@opas.dev"), true);

    for (const value of [
      adminPassword,
      adminSessionSecret,
      pooledUrl,
      directUrl,
      "database-password",
      "local-provider-secret",
      "process-provider-secret",
      "process-postgres-password",
      "process-postgres-url-password",
      "process-redis-password",
      "process-sentry-key",
      "process-vercel-token",
    ]) {
      assert.equal(configuration.secretValues.includes(value), true);
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects non-pooled, pooled-direct, and cross-branch Neon pairs", () => {
  const workspace = fixture();
  const cases: Array<Record<string, string>> = [
    {
      NEON_DATABASE_URL: directUrl,
    },
    {
      NEON_DIRECT_DATABASE_URL: pooledUrl,
    },
    {
      NEON_DIRECT_DATABASE_URL:
        "postgresql://opas:database-password@ep-another.eu-central-1.aws.neon.tech/opas?sslmode=require",
    },
  ];

  try {
    for (const values of cases) {
      writeFileSync(join(workspace, ".env"), `${environmentFile(values)}\n`);
      assert.throws(() =>
        vercelBuildConfiguration(
          maintainedOrigin,
          workspace,
          {},
        ),
      );
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("derives the matching Neon direct host in memory when it is omitted", () => {
  const workspace = fixture();

  try {
    writeFileSync(
      join(workspace, ".env"),
      `${environmentFile({ NEON_DIRECT_DATABASE_URL: "" })}\n`,
    );
    assert.doesNotThrow(() =>
      vercelBuildConfiguration(maintainedOrigin, workspace, {}),
    );
    assert.equal(
      requireNeonDirectConnectionString({ NEON_DATABASE_URL: pooledUrl }),
      directUrl,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects dotenv files and every required secret encoding", () => {
  const workspace = fixture();
  const secret = 'secret/with "quotes" and spaces';

  try {
    const output = cleanOutput(workspace);
    assert.doesNotThrow(() => assertVercelArtifactIsSecretFree(output, [secret]));

    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replaceAll("%20", "+").toLowerCase(),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64").replace(/=+$/u, ""),
      Buffer.from(secret).toString("base64url"),
      "\\u0073ecret/with \\u0022quotes\\u0022 and spaces",
    ];
    for (const [index, contents] of forms.entries()) {
      const path = join(output, `leak-${index}.js`);
      writeFileSync(path, contents);
      assert.throws(() => assertVercelArtifactIsSecretFree(output, [secret]));
      rmSync(path);
    }

    const dotenvPath = join(output, "functions", "index.func", ".env.production");
    writeFileSync(dotenvPath, "SAFE_NAME=value\n");
    assert.throws(() => assertVercelArtifactIsSecretFree(output, [secret]));
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("packages every traced function file inside the verified output", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-portable-map-"));
  const secret = "traced-dependency-secret";

  try {
    const output = cleanOutput(workspace);
    const sourcePath =
      "node_modules/.pnpm/example@1.0.0/node_modules/example/index.js";
    mkdirSync(join(workspace, sourcePath, ".."), { recursive: true });
    writeFileSync(join(workspace, sourcePath), "export const safe = true;\n");
    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ filePathMap: { "node_modules/example/index.js": sourcePath } })}\n`,
    );

    makeVercelArtifactPortable(output, workspace);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      filePathMap: Record<string, string>;
    };
    const packagedPath = manifest.filePathMap["node_modules/example/index.js"]!;
    assert.equal(
      packagedPath,
      `.vercel/output/.opas-deployment-files/${sourcePath}`,
    );
    assert.equal(
      readFileSync(
        join(output, ".opas-deployment-files", sourcePath),
        "utf8",
      ),
      "export const safe = true;\n",
    );
    assert.doesNotThrow(() =>
      assertVercelArtifactIsSecretFree(output, [secret]),
    );

    writeFileSync(join(output, ".opas-deployment-files", sourcePath), secret);
    assert.throws(() => assertVercelArtifactIsSecretFree(output, [secret]));
    assert.throws(() => makeVercelArtifactPortable(output, workspace));
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("packages traced pnpm directories and internal package links", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-portable-dir-"));
  const external = mkdtempSync(join(tmpdir(), "opas-vercel-portable-external-"));

  try {
    const output = cleanOutput(workspace);
    const packagePath =
      "node_modules/.pnpm/example@1.0.0/node_modules/example";
    mkdirSync(join(workspace, packagePath), { recursive: true });
    writeFileSync(join(workspace, packagePath, "index.js"), "export {};\n");
    writeFileSync(join(workspace, packagePath, "package.json"), "{}\n");
    mkdirSync(join(workspace, packagePath, "dist", "compiled"), {
      recursive: true,
    });
    writeFileSync(
      join(
        workspace,
        packagePath,
        "dist",
        "compiled",
        "server.runtime.prod.js",
      ),
      "export const runtime = true;\n",
    );
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    symlinkSync(
      join(workspace, packagePath),
      join(workspace, "node_modules", "example"),
      "dir",
    );
    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        filePathMap: {
          "node_modules/example": "node_modules/example",
          "node_modules/example/index.js": `${packagePath}/index.js`,
        },
      })}\n`,
    );

    makeVercelArtifactPortable(output, workspace);
    const portableManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as {
      filePathMap: Record<string, string>;
    };
    assert.equal(portableManifest.filePathMap["node_modules/example"], undefined);
    assert.match(
      portableManifest.filePathMap[
        "node_modules/example/dist/compiled/server.runtime.prod.js"
      ]!,
      /\.opas-deployment-files\/node_modules\/example\/dist\/compiled\/server\.runtime\.prod\.js$/u,
    );
    assert.equal(
      readFileSync(
        join(
          output,
          ".opas-deployment-files",
          "node_modules",
          "example",
          "index.js",
        ),
        "utf8",
      ),
      "export {};\n",
    );
    assert.equal(
      lstatSync(
        join(output, ".opas-deployment-files", "node_modules", "example"),
      ).isSymbolicLink(),
      false,
    );
    assert.doesNotThrow(() => assertVercelArtifactIsSecretFree(output, []));

    const unsafeOutput = cleanOutput(join(workspace, "unsafe"));
    writeFileSync(join(external, "outside.js"), "export {};\n");
    symlinkSync(
      join(external, "outside.js"),
      join(workspace, "node_modules", "outside.js"),
    );
    writeFileSync(
      join(unsafeOutput, "functions", "index.func", ".vc-config.json"),
      `${JSON.stringify({
        filePathMap: {
          "node_modules/outside.js": "node_modules/outside.js",
        },
      })}\n`,
    );
    assert.throws(() => makeVercelArtifactPortable(unsafeOutput, workspace));
  } finally {
    rmSync(external, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("reconstructs traced pnpm dependency aliases with package-local versions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-pnpm-runtime-"));

  try {
    const output = cleanOutput(workspace);
    const createPackage = (
      virtualName: string,
      packageName: string,
      source: string,
    ) => {
      const virtualRoot = join(
        workspace,
        "node_modules",
        ".pnpm",
        virtualName,
        "node_modules",
      );
      const packageRoot = join(virtualRoot, ...packageName.split("/"));
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "index.js"), source);
      writeFileSync(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ main: "index.js", name: packageName })}\n`,
      );
      return { packageRoot, virtualRoot };
    };
    const helperOne = createPackage(
      "helper@1.0.0",
      "@scope/helper",
      'module.exports = `helper-one:${require("example-a/package.json").name}`;\n',
    );
    const helperTwo = createPackage(
      "helper@2.0.0",
      "@scope/helper",
      'module.exports = `helper-two:${require("example-b/package.json").name}`;\n',
    );
    const untraced = createPackage(
      "untraced@1.0.0",
      "untraced",
      'module.exports = "must-not-ship";\n',
    );
    const exampleA = createPackage(
      "example-a@1.0.0",
      "example-a",
      'module.exports = require("@scope/helper");\n',
    );
    const exampleB = createPackage(
      "example-b@1.0.0",
      "example-b",
      'module.exports = require("@scope/helper");\n',
    );
    const linkPackage = (source: string, destination: string) => {
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(relative(dirname(destination), source), destination, "dir");
    };
    linkPackage(
      helperOne.packageRoot,
      join(exampleA.virtualRoot, "@scope", "helper"),
    );
    linkPackage(
      helperTwo.packageRoot,
      join(exampleB.virtualRoot, "@scope", "helper"),
    );
    linkPackage(untraced.packageRoot, join(exampleA.virtualRoot, "untraced"));
    linkPackage(
      exampleA.packageRoot,
      join(helperOne.virtualRoot, "example-a"),
    );
    linkPackage(
      exampleB.packageRoot,
      join(helperTwo.virtualRoot, "example-b"),
    );
    linkPackage(
      exampleA.packageRoot,
      join(workspace, "node_modules", "example-a"),
    );
    linkPackage(
      exampleB.packageRoot,
      join(workspace, "node_modules", "example-b"),
    );

    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        filePathMap: {
          ".next/node_modules/example-a-hash/index.js":
            "node_modules/example-a/index.js",
          ".next/node_modules/example-a-hash/package.json":
            "node_modules/example-a/package.json",
          "node_modules/.pnpm/example-a@1.0.0/node_modules/@scope/helper":
            "node_modules/.pnpm/example-a@1.0.0/node_modules/@scope/helper",
          "node_modules/.pnpm/example-b@1.0.0/node_modules/@scope/helper":
            "node_modules/.pnpm/example-b@1.0.0/node_modules/@scope/helper",
          "node_modules/example-a": "node_modules/example-a",
          "node_modules/example-b": "node_modules/example-b",
        },
      })}\n`,
    );

    makeVercelArtifactPortable(output, workspace);
    const portableManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as { filePathMap: Record<string, string> };
    for (const path of [
      ".next/node_modules/example-a-hash/node_modules/@scope/helper/index.js",
      "node_modules/example-a/node_modules/@scope/helper/index.js",
      "node_modules/example-b/node_modules/@scope/helper/index.js",
      "node_modules/example-a/node_modules/@scope/helper/node_modules/example-a/index.js",
    ]) {
      assert.equal(typeof portableManifest.filePathMap[path], "string");
    }
    assert.equal(portableManifest.filePathMap["node_modules/@scope/helper"], undefined);
    assert.equal(
      portableManifest.filePathMap[
        "node_modules/example-a/node_modules/untraced/index.js"
      ],
      undefined,
    );
    assert.equal(
      portableManifest.filePathMap[
        "node_modules/example-a/node_modules/@scope/helper/node_modules/example-a/node_modules/@scope/helper/index.js"
      ],
      undefined,
    );

    const functionRoot = materializeVercelFunction(output, manifestPath);
    try {
      const requireFromFunction = createRequire(join(functionRoot, "entry.js"));
      assert.equal(requireFromFunction("example-a"), "helper-one:example-a");
      assert.equal(requireFromFunction("example-b"), "helper-two:example-b");
      assert.equal(
        requireFromFunction("./.next/node_modules/example-a-hash"),
        "helper-one:example-a",
      );
    } finally {
      rmSync(functionRoot, { force: true, recursive: true });
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects a file where a traced pnpm dependency alias needs a directory", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-pnpm-collision-"));

  try {
    const output = cleanOutput(workspace);
    const exampleRoot = join(
      workspace,
      "node_modules",
      ".pnpm",
      "example@1.0.0",
      "node_modules",
      "example",
    );
    const helperRoot = join(
      workspace,
      "node_modules",
      ".pnpm",
      "helper@1.0.0",
      "node_modules",
      "helper",
    );
    mkdirSync(exampleRoot, { recursive: true });
    mkdirSync(helperRoot, { recursive: true });
    mkdirSync(join(exampleRoot, "node_modules"));
    writeFileSync(join(exampleRoot, "index.js"), 'require("helper");\n');
    writeFileSync(join(helperRoot, "index.js"), "module.exports = true;\n");
    writeFileSync(join(exampleRoot, "node_modules", "helper"), "blocked\n");
    symlinkSync(
      relative(
        join(workspace, "node_modules", ".pnpm", "example@1.0.0", "node_modules"),
        helperRoot,
      ),
      join(
        workspace,
        "node_modules",
        ".pnpm",
        "example@1.0.0",
        "node_modules",
        "helper",
      ),
      "dir",
    );
    symlinkSync(
      relative(join(workspace, "node_modules"), exampleRoot),
      join(workspace, "node_modules", "example"),
      "dir",
    );
    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        filePathMap: {
          "node_modules/example": "node_modules/example",
          "node_modules/.pnpm/example@1.0.0/node_modules/helper":
            "node_modules/.pnpm/example@1.0.0/node_modules/helper",
        },
      })}\n`,
    );

    assert.throws(
      () => makeVercelArtifactPortable(output, workspace),
      /runtime path prefix collision/u,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects disjoint files from different pnpm package instances", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-vercel-pnpm-owner-"));

  try {
    const output = cleanOutput(workspace);
    const packageOne = join(
      workspace,
      "node_modules",
      ".pnpm",
      "example@1.0.0",
      "node_modules",
      "example",
    );
    const packageTwo = join(
      workspace,
      "node_modules",
      ".pnpm",
      "example@2.0.0",
      "node_modules",
      "example",
    );
    mkdirSync(packageOne, { recursive: true });
    mkdirSync(packageTwo, { recursive: true });
    writeFileSync(join(packageOne, "index.js"), "module.exports = 1;\n");
    writeFileSync(join(packageTwo, "extra.js"), "module.exports = 2;\n");
    symlinkSync(
      relative(join(workspace, "node_modules"), packageOne),
      join(workspace, "node_modules", "example"),
      "dir",
    );
    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        filePathMap: {
          "node_modules/example": "node_modules/example",
          "node_modules/example/extra.js":
            "node_modules/.pnpm/example@2.0.0/node_modules/example/extra.js",
        },
      })}\n`,
    );

    assert.throws(
      () => makeVercelArtifactPortable(output, workspace),
      /maps one package placement to different sources/u,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects file-only mappings from different pnpm package instances", () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "opas-vercel-pnpm-file-owner-"),
  );

  try {
    const output = cleanOutput(workspace);
    const packageOne = join(
      workspace,
      "node_modules",
      ".pnpm",
      "example@1.0.0",
      "node_modules",
      "example",
    );
    const packageTwo = join(
      workspace,
      "node_modules",
      ".pnpm",
      "example@2.0.0",
      "node_modules",
      "example",
    );
    mkdirSync(packageOne, { recursive: true });
    mkdirSync(packageTwo, { recursive: true });
    writeFileSync(join(packageOne, "index.js"), "module.exports = 1;\n");
    writeFileSync(join(packageTwo, "extra.js"), "module.exports = 2;\n");
    const manifestPath = join(
      output,
      "functions",
      "index.func",
      ".vc-config.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        filePathMap: {
          "node_modules/example/index.js":
            "node_modules/.pnpm/example@1.0.0/node_modules/example/index.js",
          "node_modules/example/extra.js":
            "node_modules/.pnpm/example@2.0.0/node_modules/example/extra.js",
        },
      })}\n`,
    );

    assert.throws(
      () => makeVercelArtifactPortable(output, workspace),
      /maps one package placement to different sources/u,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("follows internal artifact links but rejects broken and escaping links", () => {
  const sourceWorkspace = mkdtempSync(join(tmpdir(), "opas-vercel-links-test-"));
  const external = mkdtempSync(join(tmpdir(), "opas-vercel-links-external-"));

  try {
    const output = cleanOutput(sourceWorkspace);
    const link = join(output, "functions", "linked.func");
    symlinkSync(join(output, "functions", "index.func"), link, "dir");
    symlinkSync(join(output, "functions"), join(output, "functions", "cycle"), "dir");
    assert.doesNotThrow(() => assertVercelArtifactIsSecretFree(output, []));

    symlinkSync(join(output, "missing"), join(output, "broken"));
    assert.throws(() => assertVercelArtifactIsSecretFree(output, []), /broken link/u);
    rmSync(join(output, "broken"));

    writeFileSync(join(external, "outside.js"), "export default {};\n");
    symlinkSync(join(external, "outside.js"), join(output, "outside.js"));
    assert.throws(() => assertVercelArtifactIsSecretFree(output, []), /escaping link/u);
    rmSync(join(output, "outside.js"));

    symlinkSync(join(output, "config.json"), join(output, ".env.production"));
    assert.throws(() => assertVercelArtifactIsSecretFree(output, []), /dotenv path/u);
  } finally {
    rmSync(external, { force: true, recursive: true });
    rmSync(sourceWorkspace, { force: true, recursive: true });
  }
});

test("rewrites absolute internal links into a portable verified artifact", () => {
  const workspace = fixture();
  const sourceWorkspace = mkdtempSync(join(tmpdir(), "opas-vercel-portable-test-"));

  try {
    const source = cleanOutput(sourceWorkspace);
    symlinkSync(
      join(source, "functions", "index.func"),
      join(source, "functions", "linked.func"),
      "dir",
    );
    copyVerifiedVercelOutput(source, workspace, []);

    const destination = join(workspace, ".vercel", "output");
    const link = join(destination, "functions", "linked.func");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(isAbsolute(readlinkSync(link)), false);
    assert.equal(
      relative(realpathSync(destination), realpathSync(link)).startsWith(".."),
      false,
    );

    rmSync(sourceWorkspace, { force: true, recursive: true });
    assert.equal(
      readFileSync(join(link, "index.js"), "utf8"),
      "export default {};\n",
    );
    assert.doesNotThrow(() => assertVercelArtifactIsSecretFree(destination, []));
  } finally {
    rmSync(sourceWorkspace, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("materializes internal artifact links for Windows without external state", () => {
  const sourceWorkspace = mkdtempSync(
    join(tmpdir(), "opas-vercel-windows-source-"),
  );
  const destinationWorkspace = mkdtempSync(
    join(tmpdir(), "opas-vercel-windows-destination-"),
  );

  try {
    const source = cleanOutput(sourceWorkspace);
    const destination = join(destinationWorkspace, "output");
    symlinkSync(
      join(source, "functions", "index.func"),
      join(source, "functions", "linked.func"),
      "dir",
    );

    copyPortableArtifact(source, destination, "win32");
    const link = join(destination, "functions", "linked.func");
    assert.equal(lstatSync(link).isSymbolicLink(), false);

    rmSync(sourceWorkspace, { force: true, recursive: true });
    assert.equal(
      readFileSync(join(link, "index.js"), "utf8"),
      "export default {};\n",
    );
    assert.doesNotThrow(() => assertVercelArtifactIsSecretFree(destination, []));
  } finally {
    rmSync(sourceWorkspace, { force: true, recursive: true });
    rmSync(destinationWorkspace, { force: true, recursive: true });
  }
});

test("copies verified output without replacing a trusted artifact on rejection", () => {
  const workspace = fixture();
  const sourceWorkspace = mkdtempSync(join(tmpdir(), "opas-vercel-output-test-"));
  const secret = "artifact-secret-do-not-copy";

  try {
    const source = cleanOutput(sourceWorkspace);
    copyVerifiedVercelOutput(source, workspace, [secret]);
    assert.equal(readFileSync(join(workspace, ".vercel", "output", "config.json"), "utf8"), "{}\n");

    writeFileSync(join(source, "leak.js"), secret);
    assert.throws(() => copyVerifiedVercelOutput(source, workspace, [secret]));
    assert.equal(readFileSync(join(workspace, ".vercel", "output", "config.json"), "utf8"), "{}\n");
  } finally {
    rmSync(sourceWorkspace, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("keeps verified output copying behind the disposable target guard", () => {
  const workspace = fixture();
  const sourceWorkspace = mkdtempSync(
    join(tmpdir(), "opas-vercel-acceptance-output-"),
  );

  try {
    const source = cleanOutput(sourceWorkspace);
    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({
        projectId: "prj_disposable",
        projectName: acceptanceProject,
      }),
    );

    assert.throws(() => copyVerifiedVercelOutput(source, workspace, []));
    copyVerifiedVercelOutput(source, workspace, [], { acceptance: true });
    assert.equal(
      readFileSync(join(workspace, ".vercel", "output", "config.json"), "utf8"),
      "{}\n",
    );
  } finally {
    rmSync(sourceWorkspace, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("deploys only a private frozen snapshot with fixed staging flags", async () => {
  const workspace = fixture();
  const fakeBin = join(workspace, "fake-bin");
  const executable = join(fakeBin, "vercel");
  const recordPath = join(fakeBin, "deploy-record.json");
  const deploymentEnvironment = {
    HOME: workspace,
    HTTPS_PROXY: "https://proxy.example.com",
    NODE_EXTRA_CA_CERTS: "/tmp/attacker-ca.pem",
    NODE_OPTIONS: "--require=/tmp/should-not-load.cjs",
    NPM_CONFIG_USERCONFIG: "/tmp/attacker.npmrc",
    OPAS_SITE_URL: "https://attacker.example.com",
    PATH: `${join(workspace, "fake-bin")}:${process.env.PATH ?? ""}`,
    VERCEL_TOKEN: "process-vercel-token",
  };

  try {
    const output = cleanOutput(workspace);
    symlinkSync(
      join(output, "functions", "index.func"),
      join(output, "functions", "linked.func"),
      "dir",
    );
    writeVercelArtifactIdentity(output, neonIdentityHash);
    copyVerifiedVercelOutput(output, workspace, []);
    mkdirSync(fakeBin);
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const output = path.join(process.cwd(), ".vercel", "output");
const link = path.join(output, "functions", "linked.func");
const dangerousNames = [
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "OPAS_SITE_URL",
];
const home = process.env.HOME;
const userConfig = process.env.NPM_CONFIG_USERCONFIG;
const snapshotRoot = fs.realpathSync(path.dirname(process.cwd()));
const homeReal = home ? fs.realpathSync(home) : "";
fs.writeFileSync(
  path.join(path.dirname(process.argv[1]), "deploy-record.json"),
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    dangerous: dangerousNames.filter((name) => process.env[name] !== undefined),
    home,
    homeInsideSnapshot: Boolean(home) && !path.relative(snapshotRoot, homeReal).startsWith("..") && !path.isAbsolute(path.relative(snapshotRoot, homeReal)),
    linkIsAbsolute: path.isAbsolute(fs.readlinkSync(link)),
    linkTargetInside: !path.relative(output, fs.realpathSync(link)).startsWith(".."),
    outputMode: fs.statSync(output).mode & 0o777,
    fileMode: fs.statSync(path.join(output, "config.json")).mode & 0o777,
    telemetryDisabled: process.env.VERCEL_TELEMETRY_DISABLED === "1",
    tokenPresent: Boolean(process.env.VERCEL_TOKEN),
    updateNotifierDisabled: process.env.NO_UPDATE_NOTIFIER === "1",
    userConfig,
    userConfigEmpty: Boolean(userConfig) && fs.readFileSync(userConfig, "utf8") === "",
    userConfigInsideHome: Boolean(home) && userConfig === path.join(home, "npmrc"),
  }),
);
`,
    );
    chmodSync(executable, 0o700);

    await deployVercelArtifact(maintainedOrigin, {
      environment: deploymentEnvironment,
      workspace,
    });

    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      cwd: string;
      dangerous: string[];
      fileMode: number;
      home: string;
      homeInsideSnapshot: boolean;
      linkIsAbsolute: boolean;
      linkTargetInside: boolean;
      outputMode: number;
      telemetryDisabled: boolean;
      tokenPresent: boolean;
      updateNotifierDisabled: boolean;
      userConfig: string;
      userConfigEmpty: boolean;
      userConfigInsideHome: boolean;
    };
    assert.deepEqual(record.args, [
      "deploy",
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--yes",
    ]);
    assert.deepEqual(record.dangerous, []);
    assert.notEqual(record.home, workspace);
    assert.equal(record.homeInsideSnapshot, true);
    assert.equal(record.linkIsAbsolute, false);
    assert.equal(record.linkTargetInside, true);
    assert.equal(record.outputMode, 0o500);
    assert.equal(record.fileMode, 0o400);
    assert.equal(record.telemetryDisabled, true);
    assert.equal(record.tokenPresent, true);
    assert.equal(record.updateNotifierDisabled, true);
    assert.equal(record.userConfigEmpty, true);
    assert.equal(record.userConfigInsideHome, true);
    assert.equal(existsSync(record.cwd), false);
    assert.equal(existsSync(record.home), false);
    assert.equal(existsSync(record.userConfig), false);

    writeFileSync(
      join(workspace, ".vercel", "project.json"),
      changedProjectLink({
        projectId: "prj_disposable",
        projectName: acceptanceProject,
      }),
    );
    await deployVercelArtifact(acceptanceOrigin, {
      acceptance: true,
      environment: deploymentEnvironment,
      workspace,
    });
    const acceptanceRecord = JSON.parse(
      readFileSync(recordPath, "utf8"),
    ) as typeof record;
    assert.deepEqual(acceptanceRecord.args, record.args);
    assert.deepEqual(acceptanceRecord.dangerous, []);
    assert.notEqual(acceptanceRecord.home, workspace);
    assert.equal(acceptanceRecord.homeInsideSnapshot, true);
    assert.equal(acceptanceRecord.telemetryDisabled, true);
    assert.equal(acceptanceRecord.tokenPresent, true);
    assert.equal(acceptanceRecord.updateNotifierDisabled, true);
    assert.equal(acceptanceRecord.userConfigEmpty, true);
    assert.equal(acceptanceRecord.userConfigInsideHome, true);
    assert.equal(existsSync(acceptanceRecord.cwd), false);
    assert.equal(existsSync(acceptanceRecord.home), false);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects an unbound Vercel artifact before invoking the deploy CLI", async () => {
  const workspace = fixture();
  const fakeBin = join(workspace, "fake-bin");
  const executable = join(fakeBin, "vercel");
  const invokedPath = join(fakeBin, "invoked");
  const deploymentEnvironment = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    VERCEL_TOKEN: "process-vercel-token",
  };
  const differentIdentityHash = createHash("sha256")
    .update("a different Neon connection")
    .digest("hex");

  try {
    mkdirSync(fakeBin);
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(invokedPath)}, "invoked");\n`,
    );
    chmodSync(executable, 0o700);

    const cases: ReadonlyArray<{
      prepare: (output: string) => void;
      rejection: RegExp;
    }> = [
      {
        prepare: () => {},
        rejection: /database identity file is missing/u,
      },
      {
        prepare: (output) =>
          writeFileSync(join(output, artifactIdentityFile), "not JSON\n"),
        rejection: /database identity file is not valid JSON/u,
      },
      {
        prepare: (output) =>
          symlinkSync("config.json", join(output, artifactIdentityFile)),
        rejection: /database identity must be a regular non-symbolic-link file/u,
      },
      {
        prepare: (output) =>
          writeFileSync(
            join(output, artifactIdentityFile),
            `${JSON.stringify({
              driver: "neon",
              neonDatabaseUrlSha256: neonIdentityHash,
              unexpected: true,
            })}\n`,
          ),
        rejection: /database identity must contain exactly/u,
      },
      {
        prepare: (output) =>
          writeFileSync(
            join(output, artifactIdentityFile),
            `${JSON.stringify({
              driver: "postgres",
              neonDatabaseUrlSha256: neonIdentityHash,
            })}\n`,
          ),
        rejection: /database identity driver must be neon/u,
      },
      {
        prepare: (output) =>
          writeVercelArtifactIdentity(output, differentIdentityHash),
        rejection: /database identity does not match/u,
      },
    ];

    for (const scenario of cases) {
      rmSync(join(workspace, ".vercel", "output"), {
        force: true,
        recursive: true,
      });
      const output = cleanOutput(join(workspace, ".vercel"));
      scenario.prepare(output);
      await assert.rejects(
        () =>
          deployVercelArtifact(maintainedOrigin, {
            environment: deploymentEnvironment,
            workspace,
          }),
        scenario.rejection,
      );
      assert.equal(existsSync(invokedPath), false);
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("removes stale prebuilt output before local configuration validation", async () => {
  const workspace = fixture();

  try {
    writeFileSync(
      join(workspace, ".env"),
      `${environmentFile({ NEON_DIRECT_DATABASE_URL: pooledUrl })}\n`,
    );
    await assert.rejects(() =>
      buildVercelArtifact(maintainedOrigin, {
        environment: {},
        workspace,
      }),
    );
    assert.throws(() =>
      readFileSync(join(workspace, ".vercel", "output", "stale")),
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
