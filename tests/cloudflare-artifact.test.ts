// ABOUTME: Proves Cloudflare artifacts are built outside local application environment files.
// ABOUTME: Rejects copied dotenv files, compiled environment exports, and encoded secret values.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  assertSafeCloudflarePath,
  assertCloudflareBundleIsSecretFree,
  assertCloudflareArtifactIsSecretFree,
  buildAndRunCloudflareCommand,
  cloudflareBuildEnvironment,
  cloudflareCommandArguments,
  cloudflareExactUploadArguments,
  cloudflareSecretListArguments,
  isMissingCloudflareWorkerSecretListError,
  parseCloudflareSecretList,
  prepareCloudflareBuild,
  prepareCloudflareProject,
  sanitizedCloudflareEnvironment,
  validateCloudflareDeploymentCacheContract,
  validateCloudflareRemoteSecretNames,
  validateCloudflareRemoteSecretState,
  validateCloudflareSecretSource,
} from "../scripts/cloudflare-artifact";
import { runCloudflareProcess } from "../scripts/cloudflare-process";
import { pnpmStoreDirectory } from "../scripts/pnpm-store";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "opas-cloudflare-test-"));
  mkdirSync(join(workspace, "node_modules"));
  writeFileSync(join(workspace, "package.json"), "{}\n");
  writeFileSync(join(workspace, "source.ts"), "export const safe = true;\n");
  writeFileSync(join(workspace, ".env"), "ADMIN_PASSWORD=do-not-upload\nOPAS_SITE_URL=https://local.invalid\n");
  writeFileSync(join(workspace, ".env.example"), "ADMIN_PASSWORD=example\n");
  mkdirSync(join(workspace, ".pnpm-store"));
  writeFileSync(join(workspace, ".pnpm-store", "cache"), "generated\n");
  writeFileSync(
    join(workspace, "node_modules", ".modules.yaml"),
    `storeDir: ${join(workspace, ".pnpm-store")}\n`,
  );
  writeFileSync(join(workspace, "tsconfig.tsbuildinfo"), "generated\n");
  return workspace;
}

function writeCleanArtifact(workspace: string) {
  const artifact = join(workspace, "artifact");
  mkdirSync(join(artifact, "cloudflare"), { recursive: true });
  writeFileSync(
    join(artifact, "cloudflare", "next-env.mjs"),
    "export const production = {};\nexport const development = {};\nexport const test = {};\n",
  );
  writeFileSync(join(artifact, "worker.js"), "export default {};\n");
  return artifact;
}

function cloudflareTemporaryDirectories() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("opas-cloudflare-project-"))
    .sort();
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Timed out waiting for the cleanup probe.");
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Timed out waiting for the Cloudflare child process tree.");
}

test("captures only stdout while bounding a child's complete output", async () => {
  const output = await runCloudflareProcess(
    process.execPath,
    [
      "--eval",
      'console.log("{\\"ok\\":true}"); console.error("warning");',
    ],
    {
      captureOutput: true,
      cwd: process.cwd(),
      environment: process.env,
    },
  );

  assert.equal(output.trim(), '{"ok":true}');
});

test("classifies a captured process failure without exposing its output", async () => {
  const secretValue = "must-not-escape-from-stderr";
  await assert.rejects(
    runCloudflareProcess(
      process.execPath,
      ["--eval", `console.error(${JSON.stringify(secretValue)}); process.exit(1);`],
      {
        captureOutput: true,
        classifyFailure() {
          return new Error("Safe classified failure.");
        },
        cwd: process.cwd(),
        environment: process.env,
      },
    ),
    (error: Error) => {
      assert.equal(error.message, "Safe classified failure.");
      assert.doesNotMatch(error.message, new RegExp(secretValue, "u"));
      return true;
    },
  );
});

test("copies a Cloudflare project without local environment or generated state", () => {
  const workspace = fixture();
  const generated = join(workspace, ".open-next");
  mkdirSync(generated);
  writeFileSync(join(generated, "worker.js"), "unsafe\n");
  const prepared = prepareCloudflareProject(workspace);

  try {
    assert.equal(readFileSync(join(prepared.directory, "source.ts"), "utf8"), "export const safe = true;\n");
    assert.equal(readFileSync(join(prepared.directory, "package.json"), "utf8"), "{}\n");
    assert.throws(() => readFileSync(join(prepared.directory, ".env")));
    assert.throws(() => readFileSync(join(prepared.directory, ".env.example")));
    assert.throws(() => readFileSync(join(prepared.directory, ".open-next", "worker.js")));
    assert.equal(existsSync(join(prepared.directory, ".pnpm-store")), false);
    assert.equal(
      existsSync(join(prepared.directory, "tsconfig.tsbuildinfo")),
      false,
    );
  } finally {
    prepared.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("permits only the reviewed no-cache, no-skew OpenNext deployment config", () => {
  const workspace = fixture();
  const config = join(workspace, "open-next.config.ts");

  try {
    writeFileSync(
      config,
      '// ABOUTME: Test config.\n// ABOUTME: Keeps deployment local.\nimport { defineCloudflareConfig } from "@opennextjs/cloudflare";\n\nexport default defineCloudflareConfig({});\n',
    );
    assert.doesNotThrow(() =>
      validateCloudflareDeploymentCacheContract(config),
    );
    writeFileSync(
      config,
      'import { defineCloudflareConfig } from "@opennextjs/cloudflare";\nexport default defineCloudflareConfig({ cloudflare: { skewProtection: { enabled: true } } });\n',
    );
    assert.throws(() => validateCloudflareDeploymentCacheContract(config));
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects symbolic links in project inputs", () => {
  const workspace = fixture();
  const outside = join(workspace, "outside-config.jsonc");
  writeFileSync(outside, "{}\n");
  symlinkSync(outside, join(workspace, "linked-config.jsonc"));

  try {
    assert.throws(() => prepareCloudflareProject(workspace), /symbolic links/);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("clears stale workspace artifacts before input validation", async () => {
  const workspace = fixture();
  mkdirSync(join(workspace, ".next"));
  mkdirSync(join(workspace, ".open-next"));
  const outside = join(workspace, "outside-config.jsonc");
  writeFileSync(outside, "{}\n");
  symlinkSync(outside, join(workspace, "linked-config.jsonc"));

  try {
    await assert.rejects(
      prepareCloudflareBuild([], { workspace }),
      /symbolic links/,
    );
    assert.equal(existsSync(join(workspace, ".next")), false);
    assert.equal(existsSync(join(workspace, ".open-next")), false);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("does not allocate a build tree for invalid options or secrets files", async () => {
  const workspace = fixture();
  const before = cloudflareTemporaryDirectories();

  try {
    await assert.rejects(
      prepareCloudflareBuild(["--unsupported"], { workspace }),
      /Unsupported guarded Cloudflare option/,
    );
    await assert.rejects(
      buildAndRunCloudflareCommand(
        "deploy",
        ["--secrets-file", join(workspace, "missing-secrets.json")],
        { workspace },
      ),
      /secrets file does not exist/,
    );
    assert.deepEqual(cloudflareTemporaryDirectories(), before);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test(
  "cleans private resources when an active child is interrupted",
  { timeout: 10_000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "opas-signal-test-"));
    const resource = join(workspace, "opas-cloudflare-project-probe");
    const grandchildPidPath = join(workspace, "grandchild.pid");
    const grandchildReadyPath = join(workspace, "grandchild.ready");
    const continuedPath = join(workspace, "continued");
    const moduleUrl = pathToFileURL(
      resolve("scripts/cloudflare-artifact.ts"),
    ).href;
    const processModuleUrl = pathToFileURL(
      resolve("scripts/cloudflare-process.ts"),
    ).href;
    const middleSource = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const grandchild = spawn(
        process.execPath,
        [
          "--eval",
          ${JSON.stringify(`
            const { writeFileSync } = require("node:fs");
            process.on("SIGINT", () => {});
            process.on("SIGTERM", () => {});
            writeFileSync(${JSON.stringify(grandchildReadyPath)}, "ready");
            setInterval(() => {}, 1000);
          `)},
        ],
        { stdio: "ignore" },
      );
      writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
      process.on("SIGINT", () => process.exit(0));
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const source = `
      import { mkdirSync, rmSync } from "node:fs";
      import { registerCloudflareCleanup } from ${JSON.stringify(moduleUrl)};
      import { runCloudflareProcess } from ${JSON.stringify(processModuleUrl)};
      const resource = ${JSON.stringify(resource)};
      mkdirSync(resource);
      const cleanup = () => rmSync(resource, { force: true, recursive: true });
      const unregister = registerCloudflareCleanup(cleanup);
      try {
        await runCloudflareProcess(
          process.execPath,
          ["--eval", ${JSON.stringify(middleSource)}],
          { cwd: process.cwd(), environment: process.env },
        );
        writeFileSync(${JSON.stringify(continuedPath)}, "unsafe");
      } catch {
        if (!process.exitCode) process.exitCode = 1;
      } finally {
        unregister();
        cleanup();
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    );

    try {
      await waitForFile(grandchildReadyPath);
      const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
      assert.ok(Number.isSafeInteger(grandchildPid));
      assert.ok(child.pid);
      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolveExit) =>
        child.once("exit", resolveExit),
      );
      assert.equal(exitCode, 143);
      await waitForProcessExit(grandchildPid);
      assert.equal(existsSync(resource), false);
      assert.equal(existsSync(continuedPath), false);
    } finally {
      if (child.exitCode === null && child.pid) {
        child.kill("SIGKILL");
      }
      rmSync(workspace, { force: true, recursive: true });
    }
  },
);

test(
  "keeps cleanup and process-tree guards active across repeated signals",
  { timeout: 10_000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "opas-double-signal-test-"));
    const resource = join(workspace, "opas-cloudflare-secret-probe");
    const childPidPath = join(workspace, "child.pid");
    const moduleUrl = pathToFileURL(
      resolve("scripts/cloudflare-artifact.ts"),
    ).href;
    const processModuleUrl = pathToFileURL(
      resolve("scripts/cloudflare-process.ts"),
    ).href;
    const childSource = `
      const { writeFileSync } = require("node:fs");
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const source = `
      import { mkdirSync, rmSync } from "node:fs";
      import { registerCloudflareCleanup } from ${JSON.stringify(moduleUrl)};
      import { runCloudflareProcess } from ${JSON.stringify(processModuleUrl)};
      const resource = ${JSON.stringify(resource)};
      mkdirSync(resource);
      const cleanup = () => rmSync(resource, { force: true, recursive: true });
      const unregister = registerCloudflareCleanup(cleanup);
      try {
        await runCloudflareProcess(
          process.execPath,
          ["--eval", ${JSON.stringify(childSource)}],
          { cwd: process.cwd(), environment: process.env },
        );
      } catch {
        if (!process.exitCode) process.exitCode = 1;
      } finally {
        unregister();
        cleanup();
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    );

    try {
      await waitForFile(childPidPath);
      const processPid = Number(readFileSync(childPidPath, "utf8"));
      child.kill("SIGTERM");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolveExit) =>
        child.once("exit", resolveExit),
      );
      assert.equal(exitCode, 143);
      await waitForProcessExit(processPid);
      assert.equal(existsSync(resource), false);
    } finally {
      if (child.exitCode === null && child.pid) child.kill("SIGKILL");
      rmSync(workspace, { force: true, recursive: true });
    }
  },
);

test("does not start another command after an inter-command signal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-boundary-signal-test-"));
  const startedPath = join(workspace, "started");
  const moduleUrl = pathToFileURL(
    resolve("scripts/cloudflare-artifact.ts"),
  ).href;
  const processModuleUrl = pathToFileURL(
    resolve("scripts/cloudflare-process.ts"),
  ).href;
  const source = `
    import { registerCloudflareCleanup } from ${JSON.stringify(moduleUrl)};
    import { runCloudflareProcess } from ${JSON.stringify(processModuleUrl)};
    const unregister = registerCloudflareCleanup(() => {});
    process.emit("SIGTERM");
    try {
      await runCloudflareProcess(
        process.execPath,
        ["--eval", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "unsafe")`)}],
        { cwd: process.cwd(), environment: process.env },
      );
    } catch {}
    unregister();
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
  } finally {
    if (child.exitCode === null && child.pid) child.kill("SIGKILL");
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("removes application variables while retaining Cloudflare authentication", () => {
  const workspace = fixture();

  try {
    const environment = sanitizedCloudflareEnvironment(workspace, {
      ADMIN_PASSWORD: "process-secret",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_API_BASE_URL: "https://attacker.invalid",
      CLOUDFLARE_ENV: "unvalidated-environment",
      GITHUB_TOKEN: "github-token",
      HTTPS_PROXY: "https://proxy.invalid",
      NODE_EXTRA_CA_CERTS: "/tmp/attacker-ca.pem",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
      NPM_CONFIG_USERCONFIG: "/tmp/attacker.npmrc",
      OPAS_SITE_URL: "https://process.invalid",
      PATH: "/bin",
      WRANGLER_API_ENVIRONMENT: "staging",
      WRANGLER_CI_OVERRIDE_NAME: "opas-landing",
    });

    assert.equal(environment.ADMIN_PASSWORD, undefined);
    assert.equal(environment.OPAS_SITE_URL, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.HTTPS_PROXY, undefined);
    assert.equal(environment.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(environment.CLOUDFLARE_API_TOKEN, "cloudflare-token");
    assert.equal(environment.CLOUDFLARE_API_BASE_URL, undefined);
    assert.equal(environment.CLOUDFLARE_ENV, undefined);
    assert.equal(environment.WRANGLER_API_ENVIRONMENT, undefined);
    assert.equal(environment.WRANGLER_CI_OVERRIDE_NAME, undefined);
    assert.equal(environment.PATH, "/bin");
    assert.equal(environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("removes Cloudflare credentials from the build environment", () => {
  const workspace = fixture();

  try {
    const environment = cloudflareBuildEnvironment(workspace, {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      PATH: "/bin",
      PNPM_HOME: "/tmp/another-pnpm-home",
    });

    assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, undefined);
    assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(environment.PATH, "/bin");
    assert.equal(environment.PNPM_HOME, undefined);
    assert.equal(environment.NPM_CONFIG_OFFLINE, "true");
    assert.equal(
      environment.NPM_CONFIG_STORE_DIR,
      realpathSync(join(workspace, ".pnpm-store")),
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("rejects untrusted pnpm store metadata", () => {
  const workspace = fixture();
  const metadata = join(workspace, "node_modules", ".modules.yaml");
  const storeFile = join(workspace, "store-file");

  try {
    writeFileSync(metadata, "storeDir: relative/store\n");
    assert.throws(
      () => pnpmStoreDirectory(workspace, "Cloudflare"),
      /absolute path/u,
    );

    writeFileSync(metadata, `storeDir: ${join(workspace, "missing-store")}\n`);
    assert.throws(
      () => pnpmStoreDirectory(workspace, "Cloudflare"),
      /contain a directory/u,
    );

    writeFileSync(storeFile, "not a directory\n");
    writeFileSync(metadata, `storeDir: ${storeFile}\n`);
    assert.throws(
      () => pnpmStoreDirectory(workspace, "Cloudflare"),
      /contain a directory/u,
    );

    rmSync(metadata);
    mkdirSync(metadata);
    assert.throws(
      () => pnpmStoreDirectory(workspace, "Cloudflare"),
      /Run pnpm install/u,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("routes shared and build-only arguments to the matching commands", () => {
  assert.deepEqual(
    cloudflareCommandArguments([
      "--config=wrangler.stage.jsonc",
      "--openNextConfigPath=open-next.stage.ts",
      "--noMinify=false",
      "--secrets-file",
      "/tmp/secrets.json",
    ]),
    {
      build: [
        "--config=wrangler.stage.jsonc",
        "--openNextConfigPath=open-next.stage.ts",
        "--noMinify=false",
      ],
      command: [
        "--config=wrangler.stage.jsonc",
        "--secrets-file",
        "/tmp/secrets.json",
      ],
      configPath: "wrangler.stage.jsonc",
    },
  );

  for (const args of [
    ["--name", "opas-landing"],
    ["--route", "opas.dev/*"],
    ["--var", "SECRET:value"],
    ["--env", "production"],
  ]) {
    assert.throws(
      () => cloudflareCommandArguments(args),
      /Unsupported guarded Cloudflare option/,
    );
  }
  assert.deepEqual(
    cloudflareCommandArguments(["--test-scheduled"], "preview"),
    {
      build: [],
      command: ["--test-scheduled"],
      configPath: "wrangler.jsonc",
    },
  );
  assert.throws(
    () =>
      cloudflareCommandArguments([
        "--config=unsafe.jsonc",
        "--secrets-file",
        "--config=safe.jsonc",
      ]),
    /not another option/,
  );
  assert.throws(
    () =>
      cloudflareCommandArguments([
        "--config=unsafe.jsonc",
        "--config=safe.jsonc",
      ]),
    /Only one Cloudflare config selector/,
  );
  for (const args of [["--secrets-file", "secrets.json;printf-injected"]]) {
    assert.throws(
      () => cloudflareCommandArguments(args),
      /cannot be passed safely/,
    );
  }
  if (process.platform !== "win32") {
    assert.throws(
      () => cloudflareCommandArguments(["--secrets-file", "secrets.json\\"]),
      /cannot be passed safely/,
    );
  }
  assert.throws(
    () =>
      assertSafeCloudflarePath(
        "/safe/project/wrangler.jsonc;printf-injected",
      ),
    /cannot be passed safely/,
  );
  for (const args of [
    ["--secrets-file", "/tmp/secrets.json"],
    ["--secrets-file=/tmp/secrets.json"],
  ]) {
    assert.throws(
      () => cloudflareCommandArguments(args, "data"),
      /not supported for this Cloudflare command/,
    );
  }
});

test("accepts only the bootstrap's exact validated secret set", () => {
  const expected = {
    ADMIN_EMAIL: "admin@opas.dev",
    ADMIN_PASSWORD: "private-password",
  };
  assert.deepEqual(
    validateCloudflareSecretSource(JSON.stringify(expected), expected),
    ["admin@opas.dev", "private-password"],
  );

  for (const source of [
    "ADMIN_EMAIL=admin@opas.dev",
    JSON.stringify({ ...expected, DB: "another-binding" }),
    JSON.stringify({ ...expected, ADMIN_PASSWORD: "changed" }),
    JSON.stringify([expected]),
  ]) {
    assert.throws(() => validateCloudflareSecretSource(source, expected));
  }
});

test("uploads the scanned Worker entry without rebuilding it", () => {
  assert.deepEqual(
    cloudflareExactUploadArguments("/tmp/scanned/custom-worker.js", [
      "--config",
      "/tmp/project/wrangler.jsonc",
      "--dry-run",
      "--secrets-file=/tmp/private/secrets.json",
    ]),
    [
      "exec",
      "wrangler",
      "deploy",
      "/tmp/scanned/custom-worker.js",
      "--no-bundle",
      "--strict",
      "--config",
      "/tmp/project/wrangler.jsonc",
      "--secrets-file=/tmp/private/secrets.json",
    ],
  );
});

test("audits the remote secret names through the isolated config", () => {
  assert.deepEqual(
    cloudflareSecretListArguments("/tmp/private/wrangler.jsonc"),
    [
      "exec",
      "wrangler",
      "secret",
      "list",
      "--format",
      "json",
      "--config",
      "/tmp/private/wrangler.jsonc",
    ],
  );
  assert.deepEqual(
    parseCloudflareSecretList(
      JSON.stringify([
        { name: "OPAS_HANDOFF_TO_EMAIL", type: "secret_text" },
        { name: "ADMIN_EMAIL", type: "secret_text" },
      ]),
    ),
    ["ADMIN_EMAIL", "OPAS_HANDOFF_TO_EMAIL"],
  );
  for (const source of [
    "not-json",
    "{}",
    JSON.stringify([{ type: "secret_text" }]),
    JSON.stringify([{ name: "ADMIN_EMAIL" }, { name: "ADMIN_EMAIL" }]),
    JSON.stringify([{ name: "UNSAFE\nNAME" }]),
  ]) {
    assert.throws(() => parseCloudflareSecretList(source));
  }
  assert.throws(() =>
    cloudflareSecretListArguments("/tmp/private/config.jsonc;injected"),
  );
});

test("rejects stale and missing remote secrets around an exact upload", () => {
  const required = ["ADMIN_EMAIL", "ADMIN_PASSWORD"];
  assert.doesNotThrow(() =>
    validateCloudflareRemoteSecretNames(required, required, false),
  );
  assert.doesNotThrow(() =>
    validateCloudflareRemoteSecretNames(["ADMIN_EMAIL"], required, true),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretNames(
      [...required, "STALE_SECRET"],
      required,
      true,
    ),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretNames(["ADMIN_EMAIL"], required, false),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretNames(
      ["ADMIN_EMAIL", "ADMIN_EMAIL"],
      required,
      true,
    ),
  );

  assert.doesNotThrow(() =>
    validateCloudflareRemoteSecretState(
      { exists: false, names: [] },
      required,
      true,
    ),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretState(
      { exists: false, names: [] },
      required,
      false,
    ),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretState(
      { exists: false, names: ["ADMIN_EMAIL"] },
      required,
      true,
    ),
  );
  assert.throws(() =>
    validateCloudflareRemoteSecretState(
      { exists: true, names: ["ADMIN_EMAIL"] },
      required,
      false,
    ),
  );
});

test("recognizes only the exact validated Worker-not-found diagnostic", () => {
  assert.equal(
    isMissingCloudflareWorkerSecretListError(
      'Worker "opas-stage-audit" not found.\n\nIf this is a new Worker, run deploy.',
      "opas-stage-audit",
    ),
    true,
  );
  assert.equal(
    isMissingCloudflareWorkerSecretListError(
      'Worker "opas-another-worker" not found.',
      "opas-stage-audit",
    ),
    false,
  );
  assert.equal(
    isMissingCloudflareWorkerSecretListError(
      'Authentication failed for Worker "opas-stage-audit".',
      "opas-stage-audit",
    ),
    false,
  );
});

test("accepts an empty compiled environment and rejects every secret carrier", () => {
  const workspace = fixture();

  try {
    const cleanArtifact = writeCleanArtifact(workspace);
    assert.doesNotThrow(() =>
      assertCloudflareArtifactIsSecretFree(cleanArtifact, workspace),
    );

    for (const [name, contents] of [
      ["raw.js", "do-not-upload"],
      ["encoded.js", Buffer.from("do-not-upload").toString("base64")],
      ["unicode.js", "\\u0064o-not-upload"],
      ["percent.js", "do-not%2dupload"],
      [".env", "ADMIN_PASSWORD=do-not-upload"],
    ]) {
      const artifact = writeCleanArtifact(workspace);
      writeFileSync(join(artifact, name), contents);
      assert.throws(() =>
        assertCloudflareArtifactIsSecretFree(artifact, workspace),
      );
      rmSync(join(artifact, name));
    }

    const escapedSecret = "<audit secret>&";
    const escapedCarriers = [
      "\\u003caudit secret\\u003e\\u0026",
      "\\x3caudit secret\\x3e&",
      "%3caudit+secret%3e%26",
      Buffer.from(escapedSecret).toString("base64").replace(/=+$/u, ""),
    ];
    for (const [index, contents] of escapedCarriers.entries()) {
      const artifact = writeCleanArtifact(workspace);
      const path = join(artifact, `escaped-${index}.js`);
      writeFileSync(path, contents);
      assert.throws(() =>
        assertCloudflareArtifactIsSecretFree(
          artifact,
          workspace,
          {},
          [escapedSecret],
        ),
      );

      const bundle = join(workspace, `bundle-${index}`);
      mkdirSync(bundle);
      writeFileSync(join(bundle, "custom-worker.js"), contents);
      assert.throws(() =>
        assertCloudflareBundleIsSecretFree(
          bundle,
          workspace,
          {},
          [escapedSecret],
        ),
      );
    }

    writeFileSync(join(cleanArtifact, "local.js"), "do-not-upload");
    assert.throws(() =>
      assertCloudflareArtifactIsSecretFree(cleanArtifact, workspace, {
        ADMIN_PASSWORD: "different-process-secret",
      }),
    );
    rmSync(join(cleanArtifact, "local.js"));

    writeFileSync(
      join(cleanArtifact, "cloudflare", "next-env.mjs"),
      "export const production = {\"ADMIN_PASSWORD\":\"different\"};\n",
    );
    assert.throws(() =>
      assertCloudflareArtifactIsSecretFree(cleanArtifact, workspace),
    );

    const processArtifact = writeCleanArtifact(workspace);
    writeFileSync(join(processArtifact, "process.js"), "github-process-secret");
    assert.throws(() =>
      assertCloudflareArtifactIsSecretFree(processArtifact, workspace, {
        GITHUB_TOKEN: "github-process-secret",
      }),
    );

    const decodedCredentialArtifact = writeCleanArtifact(workspace);
    writeFileSync(
      join(decodedCredentialArtifact, "credential.js"),
      "password/with/escapes",
    );
    assert.throws(() =>
      assertCloudflareArtifactIsSecretFree(
        decodedCredentialArtifact,
        workspace,
        {
          DATABASE_URL:
            "postgresql://opas:password%2Fwith%2Fescapes@example.invalid/opas",
        },
      ),
    );

    const outside = join(workspace, "outside.js");
    writeFileSync(outside, "export default {};\n");
    const linkedArtifact = writeCleanArtifact(workspace);
    symlinkSync(outside, join(linkedArtifact, "linked.js"));
    assert.throws(() =>
      assertCloudflareArtifactIsSecretFree(linkedArtifact, workspace),
      /escaping symbolic link/,
    );

    rmSync(join(linkedArtifact, "linked.js"));
    const secretDirectory = join(workspace, "generated-secret-directory");
    mkdirSync(secretDirectory);
    writeFileSync(join(secretDirectory, "secret.js"), "do-not-upload");
    symlinkSync(secretDirectory, join(linkedArtifact, "linked-directory"));
    assert.throws(
      () =>
        assertCloudflareArtifactIsSecretFree(
          linkedArtifact,
          workspace,
          {},
          [],
          workspace,
        ),
      /escaping symbolic link/,
    );

    rmSync(join(linkedArtifact, "linked-directory"));
    writeFileSync(join(linkedArtifact, "payload.txt"), "public payload");
    symlinkSync(join(linkedArtifact, "payload.txt"), join(linkedArtifact, ".env"));
    assert.throws(
      () => assertCloudflareArtifactIsSecretFree(linkedArtifact, workspace),
      /environment-file link/,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
