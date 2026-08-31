// ABOUTME: Builds the Vercel compatibility artifact in an environment-file-free project copy.
// ABOUTME: Validates local Neon/admin inputs and rejects dotenv files or secret bytes in output.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { resolveSiteOrigin } from "../src/site";
import { embedParentOrigins } from "../src/embed/config";
import { artifactContentForms, encodedSecretForms } from "./artifact-secrets";
import {
  registerArtifactCleanup,
  runCloudflareProcess as runVercelProcess,
} from "./cloudflare-process";
import { requireNeonConnectionStrings } from "./neon-connections";
import { pnpmStoreDirectory } from "./pnpm-store";

const vercelTeamDomain = "timo-bejans-projects.vercel.app";
const maintainedVercelOrigin = `https://opas-mvp-${vercelTeamDomain}`;
// The digests pin Vercel's non-secret link identifiers without echoing them in errors.
const maintainedVercelProject = {
  name: "opas-mvp",
  orgIdHash:
    "ca975073c0d947f120319a3e1a3108b43140160028ff0dc891661469c186b19e",
  projectIdHash:
    "dc514d45f08806eb1b4fbe5f0b1b6fe536ff9b247f35443f42a5afaf1fb99e89",
} as const;
const acceptanceVercelProjectPrefix = "opas-v02-acceptance-";

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
const deployableProjectEntries = new Set([
  "next-env.d.ts",
  "next.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "postcss.config.mjs",
  "public",
  "src",
  "tsconfig.json",
  "vercel.json",
  "worker-configuration.d.ts",
]);
const secretProjectFilePattern = /(?:^\.dev\.vars(?:\.|$)|^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.|$)|^service-account\.json$|\.(?:jks|key|keystore|p12|pem|pfx)$)/iu;
const sourceCodeFilePattern = /\.(?:[cm]?[jt]sx?|d\.ts)$/iu;
const secretEnvironmentPattern = /(?:^ADMIN_EMAIL$|^PGPASSWORD$|(?:^|_)(?:ACCESS_KEY(?:_ID)?|API_KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIALS?|DATABASE_URL|DSN|EMAIL|PASSWORD|PASSWD|POSTGRES_URL|PRIVATE_KEY|REDIS_URL|SECRET|SESSION_SECRET|TOKEN)(?:$|_))/iu;
const inheritedEnvironmentNames = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "LANG",
  "LANGUAGE",
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
  "WINDIR",
]);

type PreparedProject = {
  directory: string;
  dispose: () => void;
  environmentHome: string;
};

type Environment = Record<string, string | undefined>;

export type VercelBuildConfiguration = {
  environment: Environment;
  neonIdentityHash: string;
  secretValues: string[];
  siteOrigin: string;
};

type BuildOptions = {
  acceptance?: boolean;
  environment?: Environment;
  workspace?: string;
};

type VercelTargetOptions = {
  acceptance?: boolean;
};

type VercelTarget = {
  link: string;
  projectName: string;
  vercelDirectory: string;
  workspace: string;
};

type DeploymentSnapshot = PreparedProject;

function isEnvironmentFile(path: string) {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

function isPathWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isAcceptanceProjectName(name: string) {
  return (
    name.startsWith(acceptanceVercelProjectPrefix) &&
    name.length <= 100 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
  );
}

function requiredVercelOrigin(acceptanceProject?: string) {
  if (!acceptanceProject) {
    return maintainedVercelOrigin;
  }
  if (!isAcceptanceProjectName(acceptanceProject)) {
    throw new Error(
      `A disposable Vercel target must begin with ${acceptanceVercelProjectPrefix}.`,
    );
  }
  return `https://${acceptanceProject}-${vercelTeamDomain}`;
}

function readVercelProjectLink(
  path: string,
  options: VercelTargetOptions = {},
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The Vercel project link is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Vercel project link must contain one project object.");
  }

  const link = parsed as Record<string, unknown>;
  if (
    typeof link.projectName !== "string" ||
    typeof link.projectId !== "string" ||
    link.projectId.length === 0 ||
    typeof link.orgId !== "string" ||
    link.orgId.length === 0
  ) {
    throw new Error(
      "The Vercel project link must contain one complete project identity.",
    );
  }

  if (options.acceptance) {
    if (
      !isAcceptanceProjectName(link.projectName) ||
      sha256(link.projectId) === maintainedVercelProject.projectIdHash ||
      sha256(link.orgId) !== maintainedVercelProject.orgIdHash
    ) {
      throw new Error(
        `A disposable Vercel target must be distinct and begin with ${acceptanceVercelProjectPrefix}.`,
      );
    }
    return link.projectName;
  }

  if (
    link.projectName !== maintainedVercelProject.name ||
    sha256(link.projectId) !== maintainedVercelProject.projectIdHash ||
    sha256(link.orgId) !== maintainedVercelProject.orgIdHash
  ) {
    throw new Error(
      "The Vercel project link does not identify the maintained OPAS project.",
    );
  }

  return link.projectName;
}

export function validateVercelTarget(
  requestedWorkspace = process.cwd(),
  options: VercelTargetOptions = {},
): VercelTarget {
  const requested = resolve(requestedWorkspace);
  let workspace: string;
  try {
    workspace = realpathSync(requested);
  } catch {
    throw new Error("The Vercel workspace does not exist.");
  }

  const vercelDirectory = join(workspace, ".vercel");
  let vercelStatus;
  try {
    vercelStatus = lstatSync(vercelDirectory);
  } catch {
    throw new Error("Run vercel link before building or deploying OPAS.");
  }
  if (vercelStatus.isSymbolicLink() || !vercelStatus.isDirectory()) {
    throw new Error("The .vercel path must be a real directory inside the OPAS workspace.");
  }
  if (!isPathWithin(workspace, realpathSync(vercelDirectory))) {
    throw new Error("The .vercel directory must remain inside the OPAS workspace.");
  }

  const link = join(vercelDirectory, "project.json");
  let linkStatus;
  try {
    linkStatus = lstatSync(link);
  } catch {
    throw new Error("Run vercel link before building or deploying OPAS.");
  }
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) {
    throw new Error("The Vercel project link must be a regular non-symbolic-link file.");
  }
  const projectName = readVercelProjectLink(link, options);

  return { link, projectName, vercelDirectory, workspace };
}

function shouldCopyProjectPath(workspace: string, source: string) {
  const path = relative(workspace, source);

  if (path === "") {
    return true;
  }
  if (lstatSync(source).isSymbolicLink()) {
    return false;
  }

  const segments = path.split(/[\\/]/u);
  if (
    excludedProjectEntries.has(segments[0]) ||
    !deployableProjectEntries.has(segments[0])
  ) {
    return false;
  }

  const name = basename(source);
  if (
    secretProjectFilePattern.test(name) ||
    (/^credentials?(?:\.|$)/iu.test(name) &&
      !sourceCodeFilePattern.test(name))
  ) {
    throw new Error("A deployable Vercel input has a secret-bearing filename.");
  }
  return (
    !isEnvironmentFile(source) &&
    name !== ".npmrc" &&
    !name.endsWith(".log") &&
    !name.endsWith(".tsbuildinfo")
  );
}

function readEnvironmentFile(path: string): Record<string, string> {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error("A root .env file is required for the isolated Vercel build.");
  }

  try {
    return definedEnvironment(parseEnv(readFileSync(path, "utf8")));
  } catch {
    throw new Error("The root .env file could not be parsed.");
  }
}

function definedEnvironment(environment: Environment): Record<string, string> {
  const defined: Record<string, string> = {};

  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[name] = value;
    }
  }

  return defined;
}

function requireAdminConfiguration(environment: Readonly<Record<string, string>>) {
  const email = (environment.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = environment.ADMIN_PASSWORD ?? "";
  const sessionSecret = environment.ADMIN_SESSION_SECRET ?? "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error("ADMIN_EMAIL must contain a valid email address.");
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters.");
  }
  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }

  return { email, password, sessionSecret };
}

function secretParts(value: string) {
  const parts = new Set<string>();

  if (Buffer.byteLength(value) >= 4) {
    parts.add(value);
  }

  try {
    const url = new URL(value);
    for (const credential of [url.username, url.password]) {
      if (credential) {
        for (const part of [credential, decodeURIComponent(credential)]) {
          // The complete URL remains covered; short derived values collide with ordinary bundle text.
          if (Buffer.byteLength(part) >= 12) {
            parts.add(part);
          }
        }
      }
    }
  } catch {
    // Non-URL secrets are already represented by their complete value.
  }

  return [...parts];
}

function containsUrlCredentials(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function collectSecretValues(
  local: Readonly<Record<string, string>>,
  environment: Environment,
) {
  const values = new Set<string>();

  for (const source of [local, definedEnvironment(environment)]) {
    for (const [name, value] of Object.entries(source)) {
      if (secretEnvironmentPattern.test(name) || containsUrlCredentials(value)) {
        for (const part of secretParts(value)) {
          values.add(part);
        }
      }
    }
  }

  return [...values];
}

export function vercelBuildConfiguration(
  requestedOrigin: string,
  workspace = process.cwd(),
  environment: Environment = process.env,
  options: { acceptanceProject?: string } = {},
): VercelBuildConfiguration {
  const siteOrigin = resolveSiteOrigin(requestedOrigin);
  const requiredOrigin = requiredVercelOrigin(options.acceptanceProject);
  if (siteOrigin !== requiredOrigin) {
    throw new Error(`The Vercel target must use ${requiredOrigin}.`);
  }
  const local = readEnvironmentFile(join(workspace, ".env"));
  const combined = { ...local, ...definedEnvironment(environment) };
  const admin = requireAdminConfiguration(combined);
  const neon = requireNeonConnectionStrings(combined);
  const neonIdentityHash = sha256(neon.pooled);
  const sanitized: Environment = {};

  for (const [key, value] of Object.entries(environment)) {
    if (
      (inheritedEnvironmentNames.has(key) || key.startsWith("LC_")) &&
      !containsUrlCredentials(value)
    ) {
      sanitized[key] = value;
    }
  }

  const vercelToken = environment.VERCEL_TOKEN || local.VERCEL_TOKEN;
  if (vercelToken) {
    sanitized.VERCEL_TOKEN = vercelToken;
  }
  sanitized.OPAS_DATABASE_DRIVER = "neon";
  sanitized.OPAS_SITE_URL = siteOrigin;
  sanitized.OPAS_EMBED_PARENT_ORIGINS = embedParentOrigins(
    combined.OPAS_EMBED_PARENT_ORIGINS,
  ).join(",");
  sanitized.NEON_DATABASE_URL = neon.pooled;
  sanitized.ADMIN_EMAIL = admin.email;
  sanitized.ADMIN_PASSWORD = admin.password;
  sanitized.ADMIN_SESSION_SECRET = admin.sessionSecret;

  const secretValues = new Set(collectSecretValues(local, environment));
  for (const value of secretParts(admin.email)) {
    secretValues.add(value);
  }

  return {
    environment: sanitized,
    neonIdentityHash,
    secretValues: [...secretValues],
    siteOrigin,
  };
}

function prepareCommandHome(directory: string) {
  const home = join(directory, "home");
  mkdirSync(home, { mode: 0o700 });
  for (const path of ["cache", "config", "corepack", "data", "local", "pnpm"]) {
    mkdirSync(join(home, path), { mode: 0o700 });
  }
  for (const name of ["npmrc", "npmrc-global"]) {
    const path = join(home, name);
    writeFileSync(path, "");
    chmodSync(path, 0o600);
  }
  return home;
}

function removePrivateDirectory(directory: string) {
  rmSync(directory, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}

export function prepareVercelProject(
  workspace = process.cwd(),
  options: VercelTargetOptions = {},
): PreparedProject {
  const target = validateVercelTarget(workspace, options);
  const directory = mkdtempSync(join(tmpdir(), "opas-vercel-project-"));
  chmodSync(directory, 0o700);
  const environmentHome = prepareCommandHome(directory);
  const cleanup = () => removePrivateDirectory(directory);
  const unregisterCleanup = registerArtifactCleanup(cleanup);
  const project = join(directory, "project");
  try {
    cpSync(target.workspace, project, {
      dereference: false,
      filter: (source) => shouldCopyProjectPath(target.workspace, source),
      recursive: true,
    });
    mkdirSync(join(project, ".vercel"), { recursive: true });
    copyFileSync(target.link, join(project, ".vercel", "project.json"));
    readVercelProjectLink(join(project, ".vercel", "project.json"), options);
  } catch (error) {
    unregisterCleanup();
    cleanup();
    throw error;
  }

  return {
    directory: project,
    dispose: () => {
      unregisterCleanup();
      cleanup();
    },
    environmentHome,
  };
}

type ArtifactFile = {
  displayPath: string;
  path: string;
};

const deploymentFilesDirectory = ".opas-deployment-files";
const artifactDatabaseIdentityFile = ".opas-database-identity.json";

function requireArtifactDirectory(path: string) {
  let status;
  try {
    status = lstatSync(path);
  } catch {
    throw new Error("The Vercel output directory does not exist.");
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("The Vercel output path must be a real directory.");
  }
  return realpathSync(path);
}

function resolveArtifactEntry(root: string, path: string) {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    throw new Error(
      `The Vercel output contains a broken link at ${relative(root, path)}.`,
    );
  }
  if (!isPathWithin(root, resolved)) {
    throw new Error(
      `The Vercel output contains an escaping link at ${relative(root, path)}.`,
    );
  }
  return resolved;
}

function artifactFiles(path: string): ArtifactFile[] {
  const root = requireArtifactDirectory(path);
  const files: ArtifactFile[] = [];
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();

  const visit = (current: string, displayPath: string) => {
    const status = lstatSync(current);
    const resolved = resolveArtifactEntry(root, current);
    const resolvedStatus = status.isSymbolicLink() ? statSync(current) : status;

    if (resolvedStatus.isDirectory()) {
      if (visitedDirectories.has(resolved)) return;
      visitedDirectories.add(resolved);
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const child = join(current, entry.name);
        const childDisplayPath = join(displayPath, entry.name);
        if (isEnvironmentFile(childDisplayPath)) {
          throw new Error(
            `The Vercel output contains a dotenv path at ${childDisplayPath}.`,
          );
        }
        visit(child, childDisplayPath);
      }
      return;
    }
    if (!resolvedStatus.isFile()) {
      throw new Error(
        `The Vercel output contains an unsupported entry at ${displayPath}.`,
      );
    }
    if (visitedFiles.has(resolved)) return;
    visitedFiles.add(resolved);
    files.push({ displayPath, path: current });
  };

  visit(path, "");
  return files;
}

export function assertVercelArtifactIsSecretFree(
  artifact: string,
  secretValues: readonly string[],
) {
  const forbiddenValues = secretValues
    .flatMap(encodedSecretForms)
    .map((value) => Buffer.from(value));
  const leakedFiles: string[] = [];

  for (const file of artifactFiles(artifact)) {
    const contents = artifactContentForms(readFileSync(file.path));
    if (
      forbiddenValues.some((value) =>
        contents.some((candidate) => candidate.includes(value)),
      )
    ) {
      leakedFiles.push(file.displayPath);
    }
  }

  if (leakedFiles.length > 0) {
    throw new Error(
      `Vercel artifact safety check failed for ${[...new Set(leakedFiles)].sort().join(", ")}.`,
    );
  }
}

function deploymentSourcePath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value.split("/").some((part) => isEnvironmentFile(part)) ||
    (!value.startsWith(".next/") && !value.startsWith("node_modules/"))
  ) {
    throw new Error("The Vercel function manifest contains an unsafe source path.");
  }
  return value;
}

type DeploymentSourceLeaf = Readonly<{
  mode: number;
  relativePath: string;
  resolvedSource: string;
}>;

type PortableDeploymentLeaf = Readonly<{
  deployedPath: string;
  packagedSource: string;
  resolvedSource: string;
}>;

type PnpmPackageLocation = Readonly<{
  packageName: string;
  packageRoot: string;
  virtualRoot: string;
}>;

type PnpmPackagePlacement = Readonly<{
  deployedRoot: string;
  packageRoot: string;
}>;

function deploymentSourceLeaves(
  projectRoot: string,
  requestedSource: string,
  relativePath = "",
  ancestors = new Set<string>(),
): DeploymentSourceLeaf[] {
  let resolvedSource: string;
  try {
    resolvedSource = realpathSync(requestedSource);
  } catch {
    throw new Error("A Vercel function manifest references a missing source entry.");
  }
  if (!isPathWithin(projectRoot, resolvedSource)) {
    throw new Error("A Vercel function manifest references an unsafe source entry.");
  }

  const status = statSync(requestedSource);
  if (status.isFile()) {
    return [{ mode: status.mode, relativePath, resolvedSource }];
  }
  if (!status.isDirectory()) {
    throw new Error("A Vercel function manifest references an unsafe source entry.");
  }
  if (ancestors.has(resolvedSource)) {
    throw new Error("A Vercel function manifest contains a source directory cycle.");
  }

  const nestedAncestors = new Set(ancestors).add(resolvedSource);
  const leaves: DeploymentSourceLeaf[] = [];
  for (const entry of readdirSync(requestedSource).sort()) {
    if (isEnvironmentFile(entry)) {
      throw new Error("A Vercel function manifest references a dotenv entry.");
    }
    leaves.push(
      ...deploymentSourceLeaves(
        projectRoot,
        join(requestedSource, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
        nestedAncestors,
      ),
    );
  }
  return leaves;
}

function pnpmPackageLocation(
  projectRoot: string,
  resolvedPath: string,
): PnpmPackageLocation | undefined {
  if (!isPathWithin(projectRoot, resolvedPath)) return undefined;
  const pathParts = relative(projectRoot, resolvedPath).split(sep);

  for (let index = 0; index < pathParts.length; index += 1) {
    if (
      pathParts[index] !== "node_modules" ||
      pathParts[index + 1] !== ".pnpm" ||
      !pathParts[index + 2] ||
      pathParts[index + 3] !== "node_modules" ||
      !pathParts[index + 4]
    ) {
      continue;
    }

    const packageStart = index + 4;
    const scoped = pathParts[packageStart]!.startsWith("@");
    if (scoped && !pathParts[packageStart + 1]) continue;
    const packageEnd = packageStart + (scoped ? 2 : 1);
    const packageParts = pathParts.slice(packageStart, packageEnd);
    return {
      packageName: packageParts.join("/"),
      packageRoot: join(projectRoot, ...pathParts.slice(0, packageEnd)),
      virtualRoot: join(projectRoot, ...pathParts.slice(0, packageStart)),
    };
  }

  return undefined;
}

function packageRelativePath(packageRoot: string, resolvedSource: string) {
  const sourcePath = relative(packageRoot, resolvedSource);
  if (
    sourcePath.length === 0 ||
    isAbsolute(sourcePath) ||
    sourcePath.split(sep).some((part) => part === "..")
  ) {
    throw new Error("A traced pnpm package contains an unsafe source path.");
  }
  return sourcePath.split(sep).join("/");
}

function deployedPackageRoot(deployedPath: string) {
  const pathParts = deployedPath.split("/");
  let packageRoot: string | undefined;

  for (let index = 0; index < pathParts.length; index += 1) {
    if (pathParts[index] !== "node_modules") continue;
    const aliasStart = index + 1;
    const alias = pathParts[aliasStart];
    if (!alias || alias.startsWith(".")) continue;
    const scoped = alias.startsWith("@");
    if (scoped && !pathParts[aliasStart + 1]) continue;
    const packageEnd = aliasStart + (scoped ? 2 : 1);
    if (packageEnd >= pathParts.length) continue;
    packageRoot = pathParts.slice(0, packageEnd).join("/");
  }

  return packageRoot;
}

function inferredPnpmPackagePlacements(
  projectRoot: string,
  leaves: readonly PortableDeploymentLeaf[],
) {
  const placements: PnpmPackagePlacement[] = [];
  for (const leaf of leaves) {
    const location = pnpmPackageLocation(projectRoot, leaf.resolvedSource);
    const deployedRoot = deployedPackageRoot(leaf.deployedPath);
    if (!location || !deployedRoot) continue;
    placements.push({
      deployedRoot,
      packageRoot: location.packageRoot,
    });
  }
  return placements;
}

function boundPnpmPackagePlacements(
  placements: readonly PnpmPackagePlacement[],
) {
  const targets = new Map<string, string>();
  for (const placement of placements) {
    const existing = targets.get(placement.deployedRoot);
    if (existing && existing !== placement.packageRoot) {
      throw new Error(
        "A Vercel function manifest maps one package placement to different sources.",
      );
    }
    targets.set(placement.deployedRoot, placement.packageRoot);
  }
  return [...targets].map(([deployedRoot, packageRoot]) => ({
    deployedRoot,
    packageRoot,
  }));
}

function assertPnpmPackagePlacementOwnership(
  leaves: readonly PortableDeploymentLeaf[],
  placements: readonly PnpmPackagePlacement[],
) {
  const enclosingPlacements = boundPnpmPackagePlacements(placements).sort(
    (left, right) => right.deployedRoot.length - left.deployedRoot.length,
  );

  for (const leaf of leaves) {
    const placement = enclosingPlacements.find((candidate) =>
      leaf.deployedPath.startsWith(`${candidate.deployedRoot}/`),
    );
    if (!placement) continue;
    const deployedSuffix = leaf.deployedPath.slice(
      placement.deployedRoot.length + 1,
    );
    if (
      !isPathWithin(placement.packageRoot, leaf.resolvedSource) ||
      packageRelativePath(placement.packageRoot, leaf.resolvedSource) !==
        deployedSuffix
    ) {
      throw new Error(
        "A Vercel function manifest combines files from different package sources.",
      );
    }
  }
}

function linkedPnpmDependencies(
  projectRoot: string,
  packageRoot: string,
) {
  const location = pnpmPackageLocation(projectRoot, packageRoot);
  if (!location || location.packageRoot !== packageRoot) return [];

  const candidates: Array<Readonly<{ alias: string; path: string }>> = [];
  for (const entry of readdirSync(location.virtualRoot).sort()) {
    if (entry.startsWith(".")) continue;
    const entryPath = join(location.virtualRoot, entry);
    const status = lstatSync(entryPath);
    if (entry.startsWith("@") && status.isDirectory()) {
      for (const name of readdirSync(entryPath).sort()) {
        candidates.push({ alias: `${entry}/${name}`, path: join(entryPath, name) });
      }
    } else {
      candidates.push({ alias: entry, path: entryPath });
    }
  }

  const dependencies: Array<Readonly<{ alias: string; packageRoot: string }>> = [];
  for (const candidate of candidates) {
    let status;
    try {
      status = lstatSync(candidate.path);
    } catch {
      continue;
    }
    if (!status.isSymbolicLink()) continue;

    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(candidate.path);
    } catch {
      continue;
    }
    if (
      !isPathWithin(projectRoot, resolvedRoot) ||
      !statSync(resolvedRoot).isDirectory()
    ) {
      continue;
    }
    const dependencyLocation = pnpmPackageLocation(projectRoot, resolvedRoot);
    if (!dependencyLocation || dependencyLocation.packageRoot !== resolvedRoot) {
      continue;
    }
    dependencies.push({ alias: candidate.alias, packageRoot: resolvedRoot });
  }
  return dependencies;
}

function tracedPnpmPackageLeaves(
  projectRoot: string,
  leaves: readonly PortableDeploymentLeaf[],
) {
  const packages = new Map<string, Map<string, PortableDeploymentLeaf>>();
  for (const leaf of leaves) {
    const location = pnpmPackageLocation(projectRoot, leaf.resolvedSource);
    if (!location) continue;
    const relativePath = packageRelativePath(
      location.packageRoot,
      leaf.resolvedSource,
    );
    const packageLeaves = packages.get(location.packageRoot) ?? new Map();
    const existing = packageLeaves.get(relativePath);
    if (existing && existing.resolvedSource !== leaf.resolvedSource) {
      throw new Error(
        "A traced pnpm package maps one path to different sources.",
      );
    }
    if (!existing || leaf.packagedSource < existing.packagedSource) {
      packageLeaves.set(relativePath, leaf);
    }
    packages.set(location.packageRoot, packageLeaves);
  }
  return packages;
}

function addPnpmDependencyAliases(
  projectRoot: string,
  leaves: readonly PortableDeploymentLeaf[],
  placements: readonly PnpmPackagePlacement[],
  addMapping: (
    deployedPath: string,
    packagedSource: string,
    resolvedSource: string,
  ) => void,
) {
  const tracedPackages = tracedPnpmPackageLeaves(projectRoot, leaves);
  const placementTargets = new Map<string, string>();
  const sortedPackageLeaves = new Map(
    [...tracedPackages].map(([packageRoot, packageLeaves]) => [
      packageRoot,
      [...packageLeaves].sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
  const dependencyCache = new Map<
    string,
    ReturnType<typeof linkedPnpmDependencies>
  >();
  const queue = boundPnpmPackagePlacements(placements)
    .sort((left, right) => left.deployedRoot.localeCompare(right.deployedRoot))
    .map((placement) => ({
      ...placement,
      ancestors: new Set([placement.packageRoot]),
    }));
  const expanded = new Set<string>();
  let queueIndex = 0;

  const bindPlacement = (deployedRoot: string, packageRoot: string) => {
    const existing = placementTargets.get(deployedRoot);
    if (existing && existing !== packageRoot) {
      throw new Error(
        "A Vercel function manifest maps one package placement to different sources.",
      );
    }
    placementTargets.set(deployedRoot, packageRoot);
  };

  while (queueIndex < queue.length) {
    const placement = queue[queueIndex]!;
    queueIndex += 1;
    bindPlacement(placement.deployedRoot, placement.packageRoot);
    const placementKey = `${placement.deployedRoot}\0${placement.packageRoot}`;
    if (expanded.has(placementKey)) continue;
    expanded.add(placementKey);

    let dependencies = dependencyCache.get(placement.packageRoot);
    if (!dependencies) {
      dependencies = linkedPnpmDependencies(projectRoot, placement.packageRoot);
      dependencyCache.set(placement.packageRoot, dependencies);
    }
    for (const dependency of dependencies) {
      const dependencyLeaves = sortedPackageLeaves.get(dependency.packageRoot);
      if (!dependencyLeaves || dependencyLeaves.length === 0) continue;
      const deployedRoot = `${placement.deployedRoot}/node_modules/${dependency.alias}`;
      bindPlacement(deployedRoot, dependency.packageRoot);

      for (const [relativePath, leaf] of dependencyLeaves) {
        addMapping(
          `${deployedRoot}/${relativePath}`,
          leaf.packagedSource,
          leaf.resolvedSource,
        );
      }

      if (!placement.ancestors.has(dependency.packageRoot)) {
        queue.push({
          ancestors: new Set(placement.ancestors).add(dependency.packageRoot),
          deployedRoot,
          packageRoot: dependency.packageRoot,
        });
      }
    }
  }
}

export function makeVercelArtifactPortable(
  artifact: string,
  project: string,
) {
  const artifactRoot = requireArtifactDirectory(artifact);
  const projectRoot = realpathSync(project);
  if (!isPathWithin(projectRoot, artifactRoot)) {
    throw new Error("The Vercel output must remain inside its build project.");
  }

  const packagedRoot = join(artifactRoot, deploymentFilesDirectory);
  if (existsSync(packagedRoot)) {
    throw new Error("The Vercel output already contains deployment files.");
  }

  const copied = new Map<string, string>();
  for (const file of artifactFiles(artifactRoot).filter(
    ({ displayPath }) => basename(displayPath) === ".vc-config.json",
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file.path, "utf8"));
    } catch {
      throw new Error("A Vercel function manifest is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("A Vercel function manifest must contain one object.");
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.filePathMap === undefined) continue;
    if (
      !manifest.filePathMap ||
      typeof manifest.filePathMap !== "object" ||
      Array.isArray(manifest.filePathMap)
    ) {
      throw new Error("A Vercel function manifest has an invalid file map.");
    }

    const portableMap: Record<string, string> = {};
    const mappedSources = new Map<string, string>();
    const mappedPrefixes = new Set<string>();
    const tracedLeaves: PortableDeploymentLeaf[] = [];
    const packagePlacements: PnpmPackagePlacement[] = [];
    const addMapping = (
      requestedDeployedPath: string,
      packagedSource: string,
      resolvedSource: string,
    ) => {
      const deployedPath = deploymentSourcePath(requestedDeployedPath);
      const deployedParts = deployedPath.split("/");
      for (let index = 1; index < deployedParts.length; index += 1) {
        if (mappedSources.has(deployedParts.slice(0, index).join("/"))) {
          throw new Error(
            "A Vercel function manifest contains a runtime path prefix collision.",
          );
        }
      }
      if (mappedPrefixes.has(deployedPath)) {
        throw new Error(
          "A Vercel function manifest contains a runtime path prefix collision.",
        );
      }

      const existingSource = mappedSources.get(deployedPath);
      if (existingSource && existingSource !== resolvedSource) {
        throw new Error(
          "A Vercel function manifest maps one runtime path to different sources.",
        );
      }
      if (existingSource) return;

      portableMap[deployedPath] = [
        ".vercel",
        "output",
        deploymentFilesDirectory,
        ...packagedSource.split("/"),
      ].join("/");
      mappedSources.set(deployedPath, resolvedSource);
      for (let index = 1; index < deployedParts.length; index += 1) {
        mappedPrefixes.add(deployedParts.slice(0, index).join("/"));
      }
    };
    for (const [deployedPath, value] of Object.entries(
      manifest.filePathMap as Record<string, unknown>,
    )) {
      const deployedPrefix = deploymentSourcePath(deployedPath);
      const sourcePath = deploymentSourcePath(value);
      const requestedSource = join(projectRoot, sourcePath);
      const leaves = deploymentSourceLeaves(projectRoot, requestedSource);
      const resolvedEntry = realpathSync(requestedSource);
      const packageLocation = pnpmPackageLocation(projectRoot, resolvedEntry);
      if (
        statSync(requestedSource).isDirectory() &&
        packageLocation?.packageRoot === resolvedEntry
      ) {
        packagePlacements.push({
          deployedRoot: deployedPrefix,
          packageRoot: resolvedEntry,
        });
      }
      for (const leaf of leaves) {
        const deployedLeaf = leaf.relativePath
          ? `${deployedPrefix}/${leaf.relativePath}`
          : deployedPrefix;
        const packagedSource = leaf.relativePath
          ? `${sourcePath}/${leaf.relativePath}`
          : sourcePath;
        const packagedPath = join(packagedRoot, packagedSource);
        const existingCopy = copied.get(packagedSource);
        if (existingCopy && existingCopy !== leaf.resolvedSource) {
          throw new Error(
            "Vercel function manifests map one packaged path to different sources.",
          );
        }
        if (!existingCopy) {
          mkdirSync(dirname(packagedPath), { recursive: true });
          copyFileSync(leaf.resolvedSource, packagedPath);
          chmodSync(packagedPath, leaf.mode);
          copied.set(packagedSource, leaf.resolvedSource);
        }
        tracedLeaves.push({
          deployedPath: deployedLeaf,
          packagedSource,
          resolvedSource: leaf.resolvedSource,
        });
        addMapping(deployedLeaf, packagedSource, leaf.resolvedSource);
      }
    }
    const boundPackagePlacements = boundPnpmPackagePlacements([
      ...packagePlacements,
      ...inferredPnpmPackagePlacements(projectRoot, tracedLeaves),
    ]);
    assertPnpmPackagePlacementOwnership(tracedLeaves, boundPackagePlacements);
    addPnpmDependencyAliases(
      projectRoot,
      tracedLeaves,
      boundPackagePlacements,
      addMapping,
    );
    manifest.filePathMap = portableMap;
    writeFileSync(file.path, `${JSON.stringify(manifest)}\n`);
  }
}

export function writeVercelDatabaseIdentity(
  project: string,
  neonIdentityHash: string,
) {
  requireNeonIdentityHash(neonIdentityHash);
  const projectRoot = realpathSync(project);
  const path = join(projectRoot, "src", "db", "deployment-identity.ts");
  const status = lstatSync(path);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !isPathWithin(projectRoot, realpathSync(path))
  ) {
    throw new Error("The Vercel database identity source must be a project file.");
  }
  writeFileSync(
    path,
    [
      "// ABOUTME: Holds the database identity embedded by the guarded Vercel build.",
      "// ABOUTME: Prevents project settings from selecting a different runtime database.",
      'export const artifactDatabaseDriver = "neon" as const;',
      `export const artifactNeonDatabaseUrlSha256 = ${JSON.stringify(neonIdentityHash)};`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o400);
}

function requireNeonIdentityHash(neonIdentityHash: string) {
  if (!/^[a-f0-9]{64}$/u.test(neonIdentityHash)) {
    throw new Error("The Neon connection identity hash is invalid.");
  }
}

function vercelArtifactIdentityContents(neonIdentityHash: string) {
  return `${JSON.stringify({
    driver: "neon",
    neonDatabaseUrlSha256: neonIdentityHash,
  })}\n`;
}

export function writeVercelArtifactIdentity(
  artifact: string,
  neonIdentityHash: string,
) {
  requireNeonIdentityHash(neonIdentityHash);
  const artifactRoot = requireArtifactDirectory(artifact);
  const path = join(artifactRoot, artifactDatabaseIdentityFile);
  if (existsSync(path)) {
    throw new Error("The Vercel database identity file already exists.");
  }
  writeFileSync(path, vercelArtifactIdentityContents(neonIdentityHash), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o400,
  });
}

export function assertVercelArtifactIdentity(
  artifact: string,
  expectedNeonIdentityHash: string,
) {
  requireNeonIdentityHash(expectedNeonIdentityHash);
  const artifactRoot = requireArtifactDirectory(artifact);
  const path = join(artifactRoot, artifactDatabaseIdentityFile);
  let status;
  try {
    status = lstatSync(path);
  } catch {
    throw new Error("The Vercel database identity file is missing.");
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !isPathWithin(artifactRoot, realpathSync(path))
  ) {
    throw new Error(
      "The Vercel database identity must be a regular non-symbolic-link file.",
    );
  }

  const contents = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("The Vercel database identity file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "The Vercel database identity must contain exactly driver and neonDatabaseUrlSha256.",
    );
  }
  const identity = parsed as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "driver" ||
    keys[1] !== "neonDatabaseUrlSha256"
  ) {
    throw new Error(
      "The Vercel database identity must contain exactly driver and neonDatabaseUrlSha256.",
    );
  }
  if (identity.driver !== "neon") {
    throw new Error("The Vercel database identity driver must be neon.");
  }
  if (
    typeof identity.neonDatabaseUrlSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(identity.neonDatabaseUrlSha256)
  ) {
    throw new Error("The Vercel database identity hash is invalid.");
  }
  if (identity.neonDatabaseUrlSha256 !== expectedNeonIdentityHash) {
    throw new Error(
      "The Vercel database identity does not match the selected Neon connection.",
    );
  }
  if (contents !== vercelArtifactIdentityContents(expectedNeonIdentityHash)) {
    throw new Error("The Vercel database identity encoding is invalid.");
  }
}

export function copyPortableArtifact(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
) {
  const sourceRoot = requireArtifactDirectory(source);

  const copyEntry = (
    sourcePath: string,
    destinationPath: string,
    ancestors = new Set<string>(),
  ) => {
    const status = lstatSync(sourcePath);
    const resolved = resolveArtifactEntry(sourceRoot, sourcePath);
    const resolvedStatus = status.isSymbolicLink()
      ? statSync(sourcePath)
      : status;

    if (status.isSymbolicLink() && platform !== "win32") {
      const targetInDestination = join(
        destination,
        relative(sourceRoot, resolved),
      );
      const portableTarget = relative(
        dirname(destinationPath),
        targetInDestination,
      );
      symlinkSync(
        portableTarget || ".",
        destinationPath,
        resolvedStatus.isDirectory() ? "dir" : "file",
      );
      return;
    }

    if (resolvedStatus.isDirectory()) {
      if (ancestors.has(resolved)) {
        throw new Error(
          `The Vercel output contains a directory cycle at ${relative(sourceRoot, sourcePath)}.`,
        );
      }
      const nestedAncestors = new Set(ancestors).add(resolved);
      mkdirSync(destinationPath, {
        mode: resolvedStatus.mode,
        recursive: false,
      });
      for (const entry of readdirSync(sourcePath)) {
        copyEntry(
          join(sourcePath, entry),
          join(destinationPath, entry),
          nestedAncestors,
        );
      }
      return;
    }
    if (!resolvedStatus.isFile()) {
      throw new Error(
        `The Vercel output contains an unsupported entry at ${relative(sourceRoot, sourcePath)}.`,
      );
    }
    copyFileSync(resolved, destinationPath);
    chmodSync(destinationPath, resolvedStatus.mode);
  };

  copyEntry(source, destination);
}

export function copyVerifiedVercelOutput(
  source: string,
  workspace: string,
  secretValues: readonly string[],
  options: VercelTargetOptions = {},
) {
  const target = validateVercelTarget(workspace, options);
  assertVercelArtifactIsSecretFree(source, secretValues);

  const stagingDirectory = mkdtempSync(
    join(target.vercelDirectory, ".verified-output-"),
  );
  const stagedOutput = join(stagingDirectory, "output");
  const destination = join(target.vercelDirectory, "output");

  try {
    copyPortableArtifact(source, stagedOutput);
    assertVercelArtifactIsSecretFree(stagedOutput, secretValues);
    validateVercelTarget(target.workspace, options);
    rmSync(destination, { force: true, recursive: true });
    renameSync(stagedOutput, destination);
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

function commandEnvironment(
  configuration: VercelBuildConfiguration,
  includeToken: boolean,
  environmentHome: string,
) {
  const environment: Environment = {};
  for (const [key, value] of Object.entries(configuration.environment)) {
    if (
      (inheritedEnvironmentNames.has(key) || key.startsWith("LC_")) &&
      !containsUrlCredentials(value)
    ) {
      environment[key] = value;
    }
  }
  if (includeToken && configuration.environment.VERCEL_TOKEN) {
    environment.VERCEL_TOKEN = configuration.environment.VERCEL_TOKEN;
  }
  Object.assign(environment, {
    COREPACK_HOME: join(environmentHome, "corepack"),
    HOME: environmentHome,
    LOCALAPPDATA: join(environmentHome, "local"),
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_GLOBALCONFIG: join(environmentHome, "npmrc-global"),
    NPM_CONFIG_USERCONFIG: join(environmentHome, "npmrc"),
    PNPM_HOME: join(environmentHome, "pnpm"),
    USERPROFILE: environmentHome,
    VERCEL_TELEMETRY_DISABLED: "1",
    XDG_CACHE_HOME: join(environmentHome, "cache"),
    XDG_CONFIG_HOME: join(environmentHome, "config"),
    XDG_DATA_HOME: join(environmentHome, "data"),
  });
  return environment;
}

function buildCommandEnvironment(
  configuration: VercelBuildConfiguration,
  environmentHome: string,
  storeDirectory: string,
) {
  return {
    ...configuration.environment,
    ...commandEnvironment(configuration, true, environmentHome),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_STORE_DIR: storeDirectory,
  };
}

function freezeArtifact(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return;
  if (status.isDirectory()) {
    for (const entry of readdirSync(path)) {
      freezeArtifact(join(path, entry));
    }
    chmodSync(path, 0o500);
    return;
  }
  chmodSync(path, 0o400);
}

function unfreezeArtifact(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return;
  if (status.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) {
      unfreezeArtifact(join(path, entry));
    }
    return;
  }
  chmodSync(path, 0o600);
}

function removeDeploymentSnapshot(directory: string, output: string) {
  if (existsSync(output)) {
    unfreezeArtifact(output);
  }
  removePrivateDirectory(directory);
}

function prepareVercelDeployment(
  workspace: string,
  secretValues: readonly string[],
  neonIdentityHash: string,
  options: VercelTargetOptions = {},
): DeploymentSnapshot {
  const target = validateVercelTarget(workspace, options);
  const source = join(target.vercelDirectory, "output");
  assertVercelArtifactIdentity(source, neonIdentityHash);
  assertVercelArtifactIsSecretFree(source, secretValues);

  const directory = mkdtempSync(join(tmpdir(), "opas-vercel-deploy-"));
  chmodSync(directory, 0o700);
  const environmentHome = prepareCommandHome(directory);
  const project = join(directory, "project");
  const output = join(project, ".vercel", "output");
  const cleanup = () => removeDeploymentSnapshot(directory, output);
  const unregisterCleanup = registerArtifactCleanup(cleanup);
  try {
    mkdirSync(join(project, ".vercel"), { mode: 0o700, recursive: true });
    copyFileSync(target.link, join(project, ".vercel", "project.json"));
    chmodSync(join(project, ".vercel", "project.json"), 0o400);
    readVercelProjectLink(join(project, ".vercel", "project.json"), options);
    copyPortableArtifact(source, join(project, ".vercel", "output"));
    assertVercelArtifactIsSecretFree(
      join(project, ".vercel", "output"),
      secretValues,
    );
    assertVercelArtifactIdentity(
      join(project, ".vercel", "output"),
      neonIdentityHash,
    );
    freezeArtifact(join(project, ".vercel", "output"));
  } catch (error) {
    unregisterCleanup();
    cleanup();
    throw error;
  }

  return {
    directory: project,
    dispose: () => {
      unregisterCleanup();
      cleanup();
    },
    environmentHome,
  };
}

export async function buildVercelArtifact(
  requestedOrigin: string,
  options: BuildOptions = {},
) {
  const targetOptions = { acceptance: options.acceptance };
  const target = validateVercelTarget(
    options.workspace ?? process.cwd(),
    targetOptions,
  );
  const destination = join(target.vercelDirectory, "output");

  rmSync(destination, { force: true, recursive: true });
  const configuration = vercelBuildConfiguration(
    requestedOrigin,
    target.workspace,
    options.environment ?? process.env,
    {
      acceptanceProject: options.acceptance ? target.projectName : undefined,
    },
  );
  const storeDirectory = pnpmStoreDirectory(target.workspace, "Vercel");
  const prepared = prepareVercelProject(target.workspace, targetOptions);

  try {
    writeVercelDatabaseIdentity(
      prepared.directory,
      configuration.neonIdentityHash,
    );
    const installationEnvironment = commandEnvironment(
      configuration,
      false,
      prepared.environmentHome,
    );
    await runVercelProcess(
      "pnpm",
      [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--store-dir",
        storeDirectory,
      ],
      {
        cwd: prepared.directory,
        environment: installationEnvironment,
      },
    );

    await runVercelProcess("vercel", ["build", "--prod", "--yes"], {
      cwd: prepared.directory,
      environment: buildCommandEnvironment(
        configuration,
        prepared.environmentHome,
        storeDirectory,
      ),
    });

    makeVercelArtifactPortable(
      join(prepared.directory, ".vercel", "output"),
      prepared.directory,
    );
    writeVercelArtifactIdentity(
      join(prepared.directory, ".vercel", "output"),
      configuration.neonIdentityHash,
    );

    copyVerifiedVercelOutput(
      join(prepared.directory, ".vercel", "output"),
      target.workspace,
      configuration.secretValues,
      targetOptions,
    );
  } finally {
    prepared.dispose();
  }
}

export async function deployVercelArtifact(
  requestedOrigin: string,
  options: BuildOptions = {},
) {
  const targetOptions = { acceptance: options.acceptance };
  const target = validateVercelTarget(
    options.workspace ?? process.cwd(),
    targetOptions,
  );
  const configuration = vercelBuildConfiguration(
    requestedOrigin,
    target.workspace,
    options.environment ?? process.env,
    {
      acceptanceProject: options.acceptance ? target.projectName : undefined,
    },
  );
  const prepared = prepareVercelDeployment(
    target.workspace,
    configuration.secretValues,
    configuration.neonIdentityHash,
    targetOptions,
  );

  try {
    await runVercelProcess(
      "vercel",
      [
        "deploy",
        "--prebuilt",
        "--prod",
        "--regions",
        "fra1",
        "--skip-domain",
        "--yes",
      ],
      {
        cwd: prepared.directory,
        environment: commandEnvironment(
          configuration,
          true,
          prepared.environmentHome,
        ),
      },
    );
  } finally {
    prepared.dispose();
  }
}

async function main(args: string[]) {
  const deploy = args[0] === "deploy";
  const commandArguments = deploy ? args.slice(1) : args;
  const acceptance = commandArguments[0] === "--acceptance";
  const targetArguments = acceptance
    ? commandArguments.slice(1)
    : commandArguments;
  if (targetArguments.length !== 1) {
    const command = deploy ? "deploy" : "build";
    throw new Error(
      `Usage: pnpm vercel:${command} [--acceptance] https://your-stable-origin`,
    );
  }
  const action = deploy ? deployVercelArtifact : buildVercelArtifact;
  await action(targetArguments[0], { acceptance });
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
