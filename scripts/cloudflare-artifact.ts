// ABOUTME: Builds and deploys Cloudflare artifacts without exposing local application secrets.
// ABOUTME: Copies only deployable project inputs into an isolated workspace and scans every output.
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";

import { artifactContentForms, encodedSecretForms } from "./artifact-secrets";
import {
  registerArtifactCleanup,
  runCloudflareProcess,
} from "./cloudflare-process";

const excludedProjectEntries = new Set([
  ".git",
  ".next",
  ".open-next",
  ".pnpm-store",
  ".turbo",
  ".vercel",
  ".wrangler",
  "coverage",
  "node_modules",
  "test-results",
]);
const cloudflareCredentialNames = new Set([
  "CF_EMAIL",
  "CF_API_KEY",
  "CF_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_EMAIL",
]);
const inheritedEnvironmentNames = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);
const sensitiveEnvironmentNamePattern = /(?:ACCESS_KEY(?:_ID)?|API_KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIAL|DATABASE_URL|EMAIL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|SESSION|TOKEN|WEBHOOK)/i;
const mappedPathOptions = new Set([
  "--config",
  "--configPath",
  "--openNextConfigPath",
  "-c",
]);
const sharedValueOptions = new Set([
  "--config",
  "--configPath",
  "-c",
]);
const buildValueOptions = new Set(["--openNextConfigPath"]);
const buildFlagOptions = new Set([
  "--dangerouslyUseUnsupportedNextVersion",
  "--noMinify",
  "--skipBuild",
  "--skipNextBuild",
  "--skipWranglerConfigCheck",
]);
const externalCommandPathOptions = new Set(["--secrets-file"]);
const safeCloudflarePathPattern = process.platform === "win32"
  ? /^[A-Za-z0-9_./:\\@+-]+$/
  : /^[A-Za-z0-9_./:@+-]+$/;

export type CloudflareArtifactCommand = "deploy" | "preview";
type CloudflareArgumentMode = CloudflareArtifactCommand | "build" | "data";

export type CloudflareBuild = {
  directory: string;
  dispose: () => void;
};

export function assertSafeCloudflarePath(value: string, field = "Cloudflare path") {
  if (!value || !safeCloudflarePathPattern.test(value)) {
    throw new Error(`${field} contains characters that cannot be passed safely.`);
  }
}

type RunOptions = {
  environment?: Record<string, string | undefined>;
  expectedSecrets?: Readonly<Record<string, string>>;
  expectedTarget?: Readonly<{
    accountId: string;
    config: unknown;
    databaseId: string | undefined;
    databaseName: string;
    secretNames: readonly string[];
    siteOrigin: string;
    workerName: string;
  }>;
  workspace?: string;
};

export function registerCloudflareCleanup(cleanup: () => void) {
  return registerArtifactCleanup(cleanup);
}

function isWithin(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isEnvironmentFile(path: string) {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.") || name === ".dev.vars" || name.startsWith(".dev.vars.");
}

function shouldCopyProjectPath(workspace: string, source: string) {
  const path = relative(workspace, source);

  if (path === "") {
    return true;
  }

  if (lstatSync(source).isSymbolicLink()) {
    throw new Error("Cloudflare project inputs must not contain symbolic links.");
  }

  const segments = path.split(/[\\/]/);
  if (excludedProjectEntries.has(segments[0])) {
    return false;
  }

  const name = basename(source);
  return (
    !isEnvironmentFile(source) &&
    name !== ".npmrc" &&
    !name.endsWith(".log") &&
    !name.endsWith(".tsbuildinfo")
  );
}

function localEnvironmentFiles(workspace: string) {
  return readdirSync(workspace, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        isEnvironmentFile(entry.name) &&
        !entry.name.endsWith(".example") &&
        !entry.name.endsWith(".sample") &&
        !entry.name.endsWith(".template"),
    )
    .map((entry) => join(workspace, entry.name));
}

function localEnvironment(workspace: string) {
  const values: Record<string, string> = {};

  for (const path of localEnvironmentFiles(workspace)) {
    Object.assign(values, parseEnv(readFileSync(path, "utf8")));
  }

  return values;
}

function localEnvironmentEntries(workspace: string) {
  return localEnvironmentFiles(workspace).flatMap((path) =>
    Object.entries(parseEnv(readFileSync(path, "utf8"))).flatMap(
      ([name, value]) => (value === undefined ? [] : [[name, value] as const]),
    ),
  );
}

export function sanitizedCloudflareEnvironment(
  workspace = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
) {
  const local = localEnvironment(workspace);
  const sanitized: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(environment)) {
    const inherited = inheritedEnvironmentNames.has(key) || key.startsWith("LC_");
    if (
      key in local ||
      (!inherited && !cloudflareCredentialNames.has(key)) ||
      (value !== undefined && hasCredentialedUrl(value))
    ) continue;
    sanitized[key] = value;
  }

  sanitized.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  return sanitized;
}

export function cloudflareBuildEnvironment(
  workspace = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
) {
  const sanitized = sanitizedCloudflareEnvironment(workspace, environment);

  for (const key of cloudflareCredentialNames) {
    delete sanitized[key];
  }

  return sanitized;
}

function hasCredentialedUrl(value: string) {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

export function prepareCloudflareProject(workspace = process.cwd()): CloudflareBuild {
  const directory = mkdtempSync(join(tmpdir(), "opas-cloudflare-project-"));
  const project = join(directory, "project");
  chmodSync(directory, 0o700);
  const cleanup = () => rmSync(directory, { force: true, recursive: true });
  const unregisterCleanup = registerCloudflareCleanup(cleanup);
  const dispose = () => {
    unregisterCleanup();
    cleanup();
  };

  try {
    assertSafeCloudflarePath(directory, "Cloudflare temporary directory");
    assertSafeCloudflarePath(project, "Cloudflare isolated project path");
    cpSync(workspace, project, {
      dereference: false,
      filter: (source) => shouldCopyProjectPath(workspace, source),
      recursive: true,
    });
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    directory: project,
    dispose,
  };
}

function workspacePath(workspace: string, value: string) {
  const source = resolve(workspace, value);

  if (!isWithin(workspace, source) || !existsSync(source)) {
    throw new Error("Cloudflare config paths must remain inside the project workspace.");
  }

  const workspaceRealPath = realpathSync(workspace);
  const workspaceRelativePath = relative(workspace, source);
  const expectedRealPath = resolve(workspaceRealPath, workspaceRelativePath);
  const sourceRealPath = realpathSync(source);
  if (
    lstatSync(source).isSymbolicLink() ||
    sourceRealPath !== expectedRealPath ||
    !isWithin(workspaceRealPath, sourceRealPath)
  ) {
    throw new Error("Cloudflare config paths must not traverse symbolic links.");
  }

  return { source, workspaceRelativePath };
}

function remapWorkspacePath(workspace: string, project: string, value: string) {
  const { workspaceRelativePath } = workspacePath(workspace, value);

  const destination = join(project, workspaceRelativePath);
  assertSafeCloudflarePath(destination, "Cloudflare isolated config path");
  if (!existsSync(destination)) {
    throw new Error("The isolated Cloudflare project is missing a requested config file.");
  }

  return destination;
}

function remapCommandArguments(workspace: string, project: string, args: string[]) {
  const mapped: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const externalEqualsOption = matchingEqualsOption(
      argument,
      externalCommandPathOptions,
    );
    const equalsOption = [...mappedPathOptions].find((option) =>
      argument.startsWith(`${option}=`),
    );

    if (externalEqualsOption) {
      const value = resolve(
        workspace,
        argument.slice(externalEqualsOption.length + 1),
      );
      assertSafeCloudflarePath(value, "Cloudflare secrets path");
      mapped.push(
        `${externalEqualsOption}=${value}`,
      );
      continue;
    }
    if (equalsOption) {
      mapped.push(
        `${equalsOption}=${remapWorkspacePath(
          workspace,
          project,
          argument.slice(equalsOption.length + 1),
        )}`,
      );
      continue;
    }

    mapped.push(argument);
    if (externalCommandPathOptions.has(argument)) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path.`);
      }
      const resolvedValue = resolve(workspace, value);
      assertSafeCloudflarePath(resolvedValue, "Cloudflare secrets path");
      mapped.push(resolvedValue);
      index += 1;
      continue;
    }
    if (mappedPathOptions.has(argument)) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path.`);
      }
      mapped.push(remapWorkspacePath(workspace, project, value));
      index += 1;
    }
  }

  return mapped;
}

function selectedOpenNextConfigPath(args: string[]) {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--openNextConfigPath=")) {
      paths.push(argument.slice("--openNextConfigPath=".length));
      continue;
    }
    if (argument === "--openNextConfigPath") {
      const value = args[index + 1];
      if (!value) throw new Error("--openNextConfigPath requires a path.");
      paths.push(value);
      index += 1;
    }
  }
  if (paths.length > 1) {
    throw new Error("Only one OpenNext config selector is permitted.");
  }
  return paths[0] ?? "open-next.config.ts";
}

export function validateCloudflareDeploymentCacheContract(path: string) {
  if (
    !existsSync(path) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isFile()
  ) {
    throw new Error("The OpenNext deployment config must be a regular file.");
  }
  const statements = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  if (
    statements.length !== 2 ||
    statements[0] !==
      'import { defineCloudflareConfig } from "@opennextjs/cloudflare";' ||
    statements[1] !== "export default defineCloudflareConfig({});"
  ) {
    throw new Error(
      "Direct Cloudflare deployment requires the reviewed no-cache, no-skew OpenNext config.",
    );
  }
}

async function run(
  command: string,
  args: string[],
  project: string,
  environment: Record<string, string | undefined>,
) {
  await runCloudflareProcess(command, args, {
    cwd: project,
    environment,
  });
}

async function installDependencies(
  project: string,
  environment: Record<string, string | undefined>,
) {
  await run(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile"],
    project,
    environment,
  );
}

function filesBelow(
  path: string,
  root = path,
  allowedRoot = root,
  visited = new Set<string>(),
): string[] {
  if (!existsSync(path)) {
    return [];
  }

  const realPath = realpathSync(path);
  if (visited.has(realPath)) {
    return [];
  }
  visited.add(realPath);

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      if (isEnvironmentFile(child)) {
        throw new Error(
          `Cloudflare output contains an environment-file link: ${relative(root, child)}.`,
        );
      }
      let target: string;
      try {
        target = realpathSync(child);
      } catch {
        throw new Error(
          `Cloudflare output contains a broken symbolic link: ${relative(root, child)}.`,
        );
      }
      const rootRealPath = realpathSync(root);
      const allowedRealPath = realpathSync(allowedRoot);
      const dependencyRoot = join(allowedRealPath, "node_modules");
      const targetStats = statSync(target);
      if (targetStats.isDirectory() && isWithin(rootRealPath, target)) {
        return filesBelow(target, root, allowedRoot, visited);
      }
      if (
        targetStats.isDirectory() &&
        existsSync(dependencyRoot) &&
        isWithin(realpathSync(dependencyRoot), target)
      ) {
        return [];
      }
      if (!isWithin(rootRealPath, target)) {
        throw new Error(
          `Cloudflare output contains an escaping symbolic link: ${relative(root, child)}.`,
        );
      }
      return targetStats.isFile() ? [target] : [];
    }
    if (entry.isDirectory()) {
      return filesBelow(child, root, allowedRoot, visited);
    }
    if (entry.isFile()) {
      return [child];
    }
    return [];
  });
}

function credentialValues(value: string) {
  if (!hasCredentialedUrl(value)) {
    return [];
  }

  const url = new URL(value);
  const passwords = [url.password];
  try {
    passwords.push(decodeURIComponent(url.password));
  } catch {
    // The complete URL and its encoded password remain covered.
  }
  return [...new Set(passwords)].filter((password) => password.length >= 12);
}

export function assertCloudflareArtifactIsSecretFree(
  artifact: string,
  workspace = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
  extraSecrets: string[] = [],
  allowedRoot = artifact,
) {
  if (!existsSync(artifact) || !lstatSync(artifact).isDirectory()) {
    throw new Error("The Cloudflare artifact directory does not exist.");
  }

  const leakedFiles = secretCarrierFiles(
    artifact,
    workspace,
    environment,
    extraSecrets,
    allowedRoot,
  );

  const compiledEnvironmentPath = join(artifact, "cloudflare", "next-env.mjs");
  const expectedCompiledEnvironment = ["production", "development", "test"]
    .map((mode) => `export const ${mode} = {};\n`)
    .join("");
  if (
    !existsSync(compiledEnvironmentPath) ||
    readFileSync(compiledEnvironmentPath, "utf8") !== expectedCompiledEnvironment
  ) {
    leakedFiles.push("cloudflare/next-env.mjs");
  }

  if (leakedFiles.length > 0) {
    throw new Error(
      `Cloudflare artifact safety check failed for ${[...new Set(leakedFiles)].sort().join(", ")}.`,
    );
  }
}

function secretCarrierFiles(
  directory: string,
  workspace: string,
  environment: Record<string, string | undefined>,
  extraSecrets: string[] = [],
  allowedRoot = directory,
) {
  const forbiddenValues = [
    ...[
      ...localEnvironmentEntries(workspace),
      ...Object.entries(environment),
    ]
      .filter(
        ([key, value]) =>
          value !== undefined &&
          (sensitiveEnvironmentNamePattern.test(key) ||
            cloudflareCredentialNames.has(key) ||
            hasCredentialedUrl(value)),
      )
      .flatMap(([, value]) =>
        value === undefined ? [] : [value, ...credentialValues(value)],
      ),
    ...extraSecrets,
  ].flatMap(encodedSecretForms);
  const forbiddenBuffers = forbiddenValues.map((value) => Buffer.from(value));
  const leakedFiles: string[] = [];

  for (const path of filesBelow(directory, directory, allowedRoot)) {
    if (isEnvironmentFile(path)) {
      leakedFiles.push(relative(directory, path));
      continue;
    }

    const contents = artifactContentForms(readFileSync(path));
    if (
      forbiddenBuffers.some((value) =>
        contents.some((candidate) => candidate.includes(value)),
      )
    ) {
      leakedFiles.push(relative(directory, path));
    }
  }

  return leakedFiles;
}

export function assertCloudflareBundleIsSecretFree(
  directory: string,
  workspace: string,
  environment: Record<string, string | undefined>,
  extraSecrets: string[] = [],
) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error("Cloudflare dry-run did not create a bundle directory.");
  }

  const leakedFiles = secretCarrierFiles(
    directory,
    workspace,
    environment,
    extraSecrets,
  );
  if (leakedFiles.length > 0) {
    throw new Error(
      `Cloudflare bundle safety check failed for ${[...new Set(leakedFiles)].sort().join(", ")}.`,
    );
  }
}

function hasOption(args: string[], option: string) {
  return args.some(
    (argument) => argument === option || argument.startsWith(`${option}=`),
  );
}

function matchingEqualsOption(argument: string, options: Set<string>) {
  return [...options].find((option) => argument.startsWith(`${option}=`));
}

export function cloudflareCommandArguments(
  args: string[],
  mode: CloudflareArgumentMode = "deploy",
) {
  const build: string[] = [];
  const command: string[] = [];
  let configPath: string | undefined;

  const selectConfig = (value: string) => {
    if (!value || value.startsWith("-")) {
      throw new Error("Cloudflare config options require a path value.");
    }
    if (configPath !== undefined) {
      throw new Error("Only one Cloudflare config selector is permitted.");
    }
    configPath = value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const sharedEqualsOption = matchingEqualsOption(argument, sharedValueOptions);
    const buildEqualsOption = matchingEqualsOption(argument, buildValueOptions);
    const buildEqualsFlag = matchingEqualsOption(argument, buildFlagOptions);
    const externalEqualsOption = matchingEqualsOption(
      argument,
      externalCommandPathOptions,
    );

    if (sharedEqualsOption) {
      selectConfig(argument.slice(sharedEqualsOption.length + 1));
      build.push(argument);
      command.push(argument);
      continue;
    }
    if (buildEqualsOption || buildEqualsFlag || buildFlagOptions.has(argument)) {
      if (mode === "data") {
        throw new Error(`Unsupported guarded Cloudflare option: ${argument}.`);
      }
      if (buildEqualsOption) {
        const value = argument.slice(buildEqualsOption.length + 1);
        if (!value || value.startsWith("-")) {
          throw new Error(`${buildEqualsOption} requires a path.`);
        }
      }
      build.push(argument);
      continue;
    }
    if (sharedValueOptions.has(argument) || buildValueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      if (value.startsWith("-")) {
        throw new Error(`${argument} requires a value that is not another option.`);
      }
      if (sharedValueOptions.has(argument)) {
        selectConfig(value);
      } else if (mode === "data") {
        throw new Error(`Unsupported guarded Cloudflare option: ${argument}.`);
      }
      build.push(argument, value);
      if (sharedValueOptions.has(argument)) {
        command.push(argument, value);
      }
      index += 1;
      continue;
    }
    if (externalEqualsOption) {
      if (mode === "build" || mode === "data") {
        throw new Error(
          `${externalEqualsOption} is not supported for this Cloudflare command.`,
        );
      }
      assertSafeCloudflarePath(
        argument.slice(externalEqualsOption.length + 1),
        `${externalEqualsOption} path`,
      );
      command.push(argument);
      continue;
    }
    if (externalCommandPathOptions.has(argument)) {
      if (mode === "build" || mode === "data") {
        throw new Error(
          `${argument} is not supported for this Cloudflare command.`,
        );
      }
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path.`);
      }
      if (value.startsWith("-")) {
        throw new Error(`${argument} requires a path that is not another option.`);
      }
      assertSafeCloudflarePath(value, `${argument} path`);
      command.push(argument, value);
      index += 1;
      continue;
    }
    if (argument === "--dry-run" && mode === "deploy") {
      command.push(argument);
      continue;
    }
    if (argument === "--test-scheduled" && mode === "preview") {
      command.push(argument);
      continue;
    }

    throw new Error(`Unsupported guarded Cloudflare option: ${argument}.`);
  }

  return { build, command, configPath: configPath ?? "wrangler.jsonc" };
}

export function validateCloudflareSecretSource(
  source: string,
  expectedSecrets: Readonly<Record<string, string>>,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Cloudflare deployment secrets must be one JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cloudflare deployment secrets must be one JSON object.");
  }

  const secrets = parsed as Record<string, unknown>;
  const actualNames = Object.keys(secrets).sort();
  const expectedNames = Object.keys(expectedSecrets).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index]) ||
    actualNames.some(
      (name) =>
        typeof secrets[name] !== "string" ||
        secrets[name] !== expectedSecrets[name],
    )
  ) {
    throw new Error(
      "Cloudflare deployment secrets must exactly match the validated bootstrap set.",
    );
  }

  return expectedNames.map((name) => expectedSecrets[name]);
}

function assertCommandSecretPaths(
  args: string[],
  workspace: string,
  expectedSecrets: RunOptions["expectedSecrets"],
) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.startsWith("--secrets-file=");
    if (!equals && argument !== "--secrets-file") continue;
    const value = equals
      ? argument.slice("--secrets-file=".length)
      : args[index + 1];
    if (!value) throw new Error("--secrets-file requires a path.");
    const path = resolve(workspace, value);
    assertSafeCloudflarePath(path, "Cloudflare secrets path");
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile()
    ) {
      throw new Error("The Cloudflare secrets file does not exist.");
    }
    if (!expectedSecrets) {
      throw new Error(
        "Cloudflare secret files are restricted to the validated bootstrap workflow.",
      );
    }
    if (!equals) index += 1;
  }
}

function snapshotCommandSecrets(
  args: string[],
  workspace: string,
  project: string,
  expectedSecrets: RunOptions["expectedSecrets"],
) {
  let snapshotDirectory: string | undefined;
  const command = [...args];
  const secrets: string[] = [];
  const files: string[] = [];
  let snapshotCount = 0;

  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index];
    const equals = argument.startsWith("--secrets-file=");
    if (!equals && argument !== "--secrets-file") continue;

    const value = equals
      ? argument.slice("--secrets-file=".length)
      : command[index + 1];
    if (!value) throw new Error("--secrets-file requires a path.");
    const sourcePath = resolve(workspace, value);
    assertSafeCloudflarePath(sourcePath, "Cloudflare secrets path");
    if (
      !existsSync(sourcePath) ||
      lstatSync(sourcePath).isSymbolicLink() ||
      !lstatSync(sourcePath).isFile()
    ) {
      throw new Error("The Cloudflare secrets file does not exist.");
    }

    const source = readFileSync(sourcePath, "utf8");
    if (!expectedSecrets || snapshotCount > 0) {
      throw new Error(
        "Cloudflare accepts one validated bootstrap secret file.",
      );
    }
    secrets.push(...validateCloudflareSecretSource(source, expectedSecrets));
    if (snapshotCount === 0) {
      snapshotDirectory = mkdtempSync(
        join(project, ".opas-cloudflare-secrets-"),
      );
      chmodSync(snapshotDirectory, 0o700);
    }
    const snapshotPath = join(snapshotDirectory!, `${snapshotCount}.json`);
    writeFileSync(snapshotPath, source, { mode: 0o600 });
    files.push(snapshotPath);
    if (equals) {
      command[index] = `--secrets-file=${snapshotPath}`;
    } else {
      command[index + 1] = snapshotPath;
      index += 1;
    }
    snapshotCount += 1;
  }

  return { command, files, secrets };
}

function dryRunArguments(project: string, args: string[]) {
  if (
    hasOption(args, "--outdir") ||
    hasOption(args, "--outfile") ||
    hasOption(args, "--metafile")
  ) {
    throw new Error("Cloudflare dry-run output paths are managed by the safety check.");
  }

  const output = join(project, ".opas-cloudflare-dry-run");
  rmSync(output, { force: true, recursive: true });
  return {
    args: [...args, "--dry-run", "--outdir", output],
    output,
  };
}

function cloudflareTreeDigest(directory: string) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error("A scanned Cloudflare upload tree is missing.");
  }

  const hash = createHash("sha256");
  for (const path of filesBelow(directory).sort((left, right) =>
    relative(directory, left).localeCompare(relative(directory, right)),
  )) {
    const name = relative(directory, path);
    const contents = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:${name}:${contents.byteLength}:`);
    hash.update(contents);
  }

  return hash.digest("hex");
}

function cloudflareFilesDigest(paths: string[]) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile()
    ) {
      throw new Error("A validated Cloudflare command input changed type.");
    }
    const contents = readFileSync(path);
    hash.update(`${Buffer.byteLength(path)}:${path}:${contents.byteLength}:`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

function freezeCloudflareUploadInputs(paths: string[]) {
  const restores: Array<() => void> = [];

  const freeze = (path: string): (() => void) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      throw new Error("Cloudflare upload inputs must not contain symbolic links.");
    }
    const mode = status.mode & 0o777;
    if (status.isDirectory()) {
      const childRestores: Array<() => void> = [];
      try {
        readdirSync(path).forEach((name) =>
          childRestores.push(freeze(join(path, name))),
        );
        chmodSync(path, 0o500);
      } catch (error) {
        [...childRestores].reverse().forEach((restore) => restore());
        throw error;
      }
      return () => {
        chmodSync(path, mode);
        childRestores.forEach((restore) => restore());
      };
    }
    if (!status.isFile()) {
      throw new Error("Cloudflare upload inputs contain an unsupported entry.");
    }
    chmodSync(path, 0o400);
    return () => chmodSync(path, mode);
  };

  try {
    paths.forEach((path) => restores.push(freeze(path)));
  } catch (error) {
    [...restores].reverse().forEach((restore) => restore());
    throw error;
  }

  return () => [...restores].reverse().forEach((restore) => restore());
}

function cloudflareUploadEntry(bundle: string) {
  const entry = join(bundle, "custom-worker.js");
  if (
    !existsSync(entry) ||
    lstatSync(entry).isSymbolicLink() ||
    !lstatSync(entry).isFile()
  ) {
    throw new Error("Cloudflare dry-run did not emit custom-worker.js.");
  }

  const unexpectedJavascript = filesBelow(bundle)
    .map((path) => relative(bundle, path))
    .filter(
      (path) =>
        /\.(?:c|m)?js$/u.test(path) && path !== "custom-worker.js",
    );
  if (unexpectedJavascript.length > 0) {
    throw new Error(
      `Cloudflare dry-run emitted unsupported JavaScript modules: ${unexpectedJavascript.sort().join(", ")}.`,
    );
  }

  return entry;
}

export function cloudflareExactUploadArguments(
  entry: string,
  commandArguments: string[],
) {
  return [
    "exec",
    "wrangler",
    "deploy",
    entry,
    "--no-bundle",
    "--strict",
    ...commandArguments.filter(
      (argument) =>
        argument !== "--dry-run" && !argument.startsWith("--dry-run="),
    ),
  ];
}

export function cloudflareSecretListArguments(configPath: string) {
  assertSafeCloudflarePath(configPath, "Cloudflare isolated config path");
  return [
    "exec",
    "wrangler",
    "secret",
    "list",
    "--format",
    "json",
    "--config",
    configPath,
  ];
}

export function parseCloudflareSecretList(source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Wrangler returned an invalid Cloudflare secret list.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler returned an invalid Cloudflare secret list.");
  }

  const names = parsed.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).name !== "string"
    ) {
      throw new Error("Wrangler returned an invalid Cloudflare secret list.");
    }
    const name = (item as Record<string, string>).name;
    if (
      name.length === 0 ||
      name.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error("Wrangler returned an invalid Cloudflare secret list.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("Wrangler returned duplicate Cloudflare secret names.");
  }
  return names.sort();
}

export function validateCloudflareRemoteSecretNames(
  remoteNames: readonly string[],
  requiredNames: readonly string[],
  allowMissingRequired: boolean,
) {
  const remote = new Set(remoteNames);
  const required = new Set(requiredNames);
  if (
    remote.size !== remoteNames.length ||
    required.size !== requiredNames.length
  ) {
    throw new Error("Cloudflare secret names must be unique.");
  }
  if (remoteNames.some((name) => !required.has(name))) {
    throw new Error(
      "The remote Worker contains secrets outside secrets.required.",
    );
  }
  if (
    !allowMissingRequired &&
    requiredNames.some((name) => !remote.has(name))
  ) {
    throw new Error(
      "The remote Worker is missing a secret declared in secrets.required.",
    );
  }
}

export function isMissingCloudflareWorkerSecretListError(
  errorOutput: string,
  workerName: string,
) {
  return errorOutput.includes(`Worker "${workerName}" not found.`);
}

class MissingCloudflareWorkerError extends Error {}

async function readCloudflareRemoteSecretNames(
  project: string,
  configPath: string,
  workerName: string,
  environment: Record<string, string | undefined>,
) {
  const commandEnvironment: Record<string, string | undefined> = {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
  };
  delete commandEnvironment.FORCE_COLOR;

  try {
    const output = await runCloudflareProcess(
      "pnpm",
      cloudflareSecretListArguments(configPath),
      {
        captureOutput: true,
        classifyFailure(errorOutput) {
          return isMissingCloudflareWorkerSecretListError(
            errorOutput,
            workerName,
          )
            ? new MissingCloudflareWorkerError(
                "The validated Cloudflare Worker does not exist.",
              )
            : undefined;
        },
        cwd: project,
        environment: commandEnvironment,
      },
    );
    return { exists: true as const, names: parseCloudflareSecretList(output) };
  } catch (error) {
    if (error instanceof MissingCloudflareWorkerError) {
      return { exists: false as const, names: [] as string[] };
    }
    throw error;
  }
}

export function validateCloudflareRemoteSecretState(
  state: Readonly<{ exists: boolean; names: readonly string[] }>,
  requiredNames: readonly string[],
  allowMissingRequired: boolean,
) {
  if (!state.exists) {
    if (state.names.length > 0) {
      throw new Error("Cloudflare returned an inconsistent secret-list state.");
    }
    if (!allowMissingRequired) {
      throw new Error(
        "The Cloudflare Worker does not exist and no exact secret file can create it.",
      );
    }
    return;
  }
  validateCloudflareRemoteSecretNames(
    state.names,
    requiredNames,
    allowMissingRequired,
  );
}

async function runScannedCloudflareDeployment(
  project: string,
  workspace: string,
  commandArguments: string[],
  environment: Record<string, string | undefined>,
  scanEnvironment: Record<string, string | undefined>,
  secrets: string[],
  secretFiles: string[],
  upload: boolean,
  configPath: string,
  expectedTarget: RunOptions["expectedTarget"],
  requiredSecretNames: readonly string[],
  workerName: string,
) {
  const dryRun = dryRunArguments(
    project,
    commandArguments.filter(
      (argument) =>
        argument !== "--dry-run" && !argument.startsWith("--dry-run="),
    ),
  );

  try {
    const directEnvironment = {
      ...environment,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      OPEN_NEXT_DEPLOY: "true",
    };
    const preparedConfigPath = remapWorkspacePath(
      workspace,
      project,
      configPath,
    );
    const guardedFiles = [preparedConfigPath, ...secretFiles];
    const guardedDigest = cloudflareFilesDigest(guardedFiles);
    await run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        ...remapCommandArguments(workspace, project, dryRun.args),
      ],
      project,
      directEnvironment,
    );
    assertCloudflareArtifactIsSecretFree(
      join(project, ".open-next"),
      workspace,
      scanEnvironment,
      secrets,
      project,
    );
    assertCloudflareBundleIsSecretFree(
      dryRun.output,
      workspace,
      scanEnvironment,
      secrets,
    );
    const validateGuardedInputs = async () => {
      await validatePreparedCloudflareConfig(
        workspace,
        project,
        configPath,
        expectedTarget,
      );
      if (cloudflareFilesDigest(guardedFiles) !== guardedDigest) {
        throw new Error(
          "Cloudflare config or secret inputs changed during deployment validation.",
        );
      }
    };
    await validateGuardedInputs();
    if (!upload) return;

    const entry = cloudflareUploadEntry(dryRun.output);
    const assets = join(project, ".open-next", "assets");
    const bundleDigest = cloudflareTreeDigest(dryRun.output);
    const assetsDigest = cloudflareTreeDigest(assets);
    const uploadsAllRequiredSecrets = secretFiles.length === 1;
    const restoreInputs = freezeCloudflareUploadInputs([
      dryRun.output,
      assets,
      ...guardedFiles,
    ]);
    try {
      const beforeUpload = await readCloudflareRemoteSecretNames(
        project,
        preparedConfigPath,
        workerName,
        directEnvironment,
      );
      validateCloudflareRemoteSecretState(
        beforeUpload,
        requiredSecretNames,
        uploadsAllRequiredSecrets,
      );
      await validateGuardedInputs();
      await run(
        "pnpm",
        cloudflareExactUploadArguments(
          entry,
          remapCommandArguments(workspace, project, commandArguments),
        ),
        project,
        directEnvironment,
      );
      await validateGuardedInputs();
      const afterUpload = await readCloudflareRemoteSecretNames(
        project,
        preparedConfigPath,
        workerName,
        directEnvironment,
      );
      validateCloudflareRemoteSecretState(
        afterUpload,
        requiredSecretNames,
        false,
      );
      await validateGuardedInputs();
    } finally {
      restoreInputs();
    }
    await validateGuardedInputs();
    if (
      cloudflareTreeDigest(dryRun.output) !== bundleDigest ||
      cloudflareTreeDigest(assets) !== assetsDigest
    ) {
      throw new Error("Cloudflare upload inputs changed while Wrangler read them.");
    }
  } finally {
    rmSync(dryRun.output, { force: true, recursive: true });
  }
}

async function buildInPreparedProject(
  project: string,
  workspace: string,
  args: string[],
  buildEnvironment: Record<string, string | undefined>,
  scanEnvironment: Record<string, string | undefined>,
) {
  await run(
    "pnpm",
    ["exec", "opennextjs-cloudflare", "build", ...remapCommandArguments(workspace, project, args)],
    project,
    buildEnvironment,
  );
  const nextArtifact = join(project, ".next");
  if (!existsSync(nextArtifact) || !lstatSync(nextArtifact).isDirectory()) {
    throw new Error("Cloudflare build did not create .next.");
  }
  const nextLeaks = secretCarrierFiles(
    nextArtifact,
    workspace,
    scanEnvironment,
    [],
    project,
  );
  if (nextLeaks.length > 0) {
    throw new Error(
      `Cloudflare Next.js safety check failed for ${[...new Set(nextLeaks)].sort().join(", ")}.`,
    );
  }
  assertCloudflareArtifactIsSecretFree(
    join(project, ".open-next"),
    workspace,
    scanEnvironment,
    [],
    project,
  );
}

function clearWorkspaceBuildArtifacts(workspace: string) {
  rmSync(join(workspace, ".next"), { force: true, recursive: true });
  rmSync(join(workspace, ".open-next"), { force: true, recursive: true });
}

export async function prepareCloudflareBuild(
  args: string[] = [],
  options: RunOptions = {},
): Promise<CloudflareBuild> {
  const workspace = resolve(options.workspace ?? process.cwd());
  clearWorkspaceBuildArtifacts(workspace);
  const scanEnvironment = options.environment ?? process.env;
  const environment = cloudflareBuildEnvironment(workspace, scanEnvironment);

  const parsedArguments = cloudflareCommandArguments(args, "build");
  const buildArguments = parsedArguments.build;
  const prepared = prepareCloudflareProject(workspace);
  try {
    await validatePreparedCloudflareConfig(
      workspace,
      prepared.directory,
      parsedArguments.configPath,
      options.expectedTarget,
    );
    await installDependencies(prepared.directory, environment);
    const openNextConfig = remapWorkspacePath(
      workspace,
      prepared.directory,
      selectedOpenNextConfigPath(buildArguments),
    );
    validateCloudflareDeploymentCacheContract(openNextConfig);
    await buildInPreparedProject(
      prepared.directory,
      workspace,
      buildArguments,
      environment,
      scanEnvironment,
    );
    return prepared;
  } catch (error) {
    prepared.dispose();
    clearWorkspaceBuildArtifacts(workspace);
    throw error;
  }
}

export async function buildCloudflareArtifact(
  args: string[] = [],
  options: RunOptions = {},
) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const build = await prepareCloudflareBuild(args, options);
  build.dispose();
  clearWorkspaceBuildArtifacts(workspace);
}

function synchronizeCommandPaths(workspace: string, project: string, args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equalsOption = [...mappedPathOptions].find((option) =>
      argument.startsWith(`${option}=`),
    );
    const value = equalsOption
      ? argument.slice(equalsOption.length + 1)
      : mappedPathOptions.has(argument)
        ? args[index + 1]
        : undefined;
    if (!value) continue;

    const { source, workspaceRelativePath } = workspacePath(workspace, value);
    const destination = join(project, workspaceRelativePath);
    assertSafeCloudflarePath(destination, "Cloudflare isolated config path");
    cpSync(source, destination, { force: true });
    if (!equalsOption) index += 1;
  }
}

async function validatePreparedCloudflareConfig(
  workspace: string,
  project: string,
  configPath: string,
  expectedTarget: RunOptions["expectedTarget"],
) {
  const { workspaceRelativePath } = workspacePath(workspace, configPath);
  const { readCloudflareTarget } = await import("./bootstrap-cloudflare");
  const target = readCloudflareTarget(workspaceRelativePath, project);

  if (
    expectedTarget &&
    (!isDeepStrictEqual(target.config, expectedTarget.config) ||
      target.accountId !== expectedTarget.accountId ||
      target.databaseId !== expectedTarget.databaseId ||
      target.databaseName !== expectedTarget.databaseName ||
      !isDeepStrictEqual(target.secretNames, expectedTarget.secretNames) ||
      target.siteOrigin !== expectedTarget.siteOrigin ||
      target.workerName !== expectedTarget.workerName)
  ) {
    throw new Error(
      "The isolated Cloudflare config no longer matches the validated target.",
    );
  }
  return target;
}

export async function runBuiltCloudflareCommand(
  command: CloudflareArtifactCommand,
  args: string[] = [],
  build: CloudflareBuild,
  options: RunOptions = {},
) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const project = build.directory;
  const scanEnvironment = options.environment ?? process.env;
  assertCloudflareArtifactIsSecretFree(
    join(project, ".open-next"),
    workspace,
    scanEnvironment,
    [],
    project,
  );
  const environment = sanitizedCloudflareEnvironment(
    workspace,
    scanEnvironment,
  );
  const parsedArguments = cloudflareCommandArguments(args, command);
  const snapshot = snapshotCommandSecrets(
    parsedArguments.command,
    workspace,
    project,
    options.expectedSecrets,
  );
  const commandArguments = snapshot.command;
  const secrets = snapshot.secrets;

  synchronizeCommandPaths(workspace, project, commandArguments);
  const preparedTarget = await validatePreparedCloudflareConfig(
    workspace,
    project,
    parsedArguments.configPath,
    options.expectedTarget,
  );
  if (
    snapshot.files.length > 0 &&
    !isDeepStrictEqual(
      Object.keys(options.expectedSecrets ?? {}).sort(),
      [...preparedTarget.secretNames].sort(),
    )
  ) {
    throw new Error(
      "The validated secret file must match secrets.required in the isolated config.",
    );
  }
  if (command === "deploy") {
    await runScannedCloudflareDeployment(
      project,
      workspace,
      commandArguments,
      environment,
      scanEnvironment,
      secrets,
      snapshot.files,
      !hasOption(commandArguments, "--dry-run"),
      parsedArguments.configPath,
      options.expectedTarget,
      preparedTarget.secretNames,
      preparedTarget.workerName,
    );
    return;
  }

  await run(
    "pnpm",
    [
      "exec",
      "opennextjs-cloudflare",
      command,
      ...remapCommandArguments(workspace, project, commandArguments),
    ],
    project,
    environment,
  );
  assertCloudflareArtifactIsSecretFree(
    join(project, ".open-next"),
    workspace,
    scanEnvironment,
    secrets,
    project,
  );
}

export async function buildAndRunCloudflareCommand(
  command: CloudflareArtifactCommand,
  args: string[] = [],
  options: RunOptions = {},
) {
  const workspace = resolve(options.workspace ?? process.cwd());
  clearWorkspaceBuildArtifacts(workspace);
  const commandArguments = cloudflareCommandArguments(args, command);
  assertCommandSecretPaths(
    commandArguments.command,
    workspace,
    options.expectedSecrets,
  );
  const prepared = await prepareCloudflareBuild(commandArguments.build, options);

  try {
    await runBuiltCloudflareCommand(command, args, prepared, options);
  } finally {
    prepared.dispose();
    clearWorkspaceBuildArtifacts(workspace);
  }
}
