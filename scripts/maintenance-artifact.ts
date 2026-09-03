// ABOUTME: Prunes private and scheduled surfaces from isolated rollback build inputs.
// ABOUTME: Produces target configs that retain public reads without administrator bindings.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

const forbiddenArtifactText = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "OPAS_PREVIEW_SIGNING_SECRET",
  "The artifact can authenticate administrators",
  "createPostgresArticleDraftRepository",
  "createPostgresKnowledgeImportRepository",
  "createPostgresQualityAuthoringRepository",
  "createSqliteArticleDraftRepository",
  "createSqliteKnowledgeImportRepository",
  "createSqliteQualityAuthoringRepository",
] as const;

const authoringRepositoryLines = [
  /^import \{ create(?:Postgres|Sqlite)(?:ArticleDraft|KnowledgeImport|QualityAuthoring)Repository \} from "@\/db\/(?:postgres|sqlite)\/(?:article-draft|knowledge-import|quality-authoring)-repository";\n/gmu,
  /^\s*\.\.\.create(?:Postgres|Sqlite)(?:ArticleDraft|KnowledgeImport|QualityAuthoring)Repository\([^\n]+\),\n/gmu,
] as const;

function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function requireProjectDirectory(project: string) {
  const absolute = resolve(project);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) {
    throw new Error("The maintenance project must be a real directory.");
  }
  return realpathSync(absolute);
}

function projectPath(project: string, path: string) {
  const target = resolve(project, path);
  if (!isWithin(project, target)) throw new Error("A maintenance path escaped the project.");
  return target;
}

function removeAuthoringRepositoryComposition(path: string) {
  if (!existsSync(path)) return;
  let source = readFileSync(path, "utf8");
  for (const pattern of authoringRepositoryLines) source = source.replace(pattern, "");
  const repositoryEnd = "\n  });\n}";
  const trimmed = source.trimEnd();
  if (trimmed.endsWith(repositoryEnd)) {
    source = `${trimmed.slice(0, -repositoryEnd.length)}\n  } as Repository);\n}\n`;
  }
  writeFileSync(path, source);
}

export function prepareMaintenanceProject(projectPathname: string) {
  const project = requireProjectDirectory(projectPathname);
  const template = projectPath(project, "src/maintenance/proxy.ts");
  if (!existsSync(template) || !lstatSync(template).isFile()) {
    throw new Error("The maintenance proxy template is missing.");
  }

  for (const path of [
    "src/app/admin",
    "src/app/api/internal",
    "src/app/preview",
    "src/auth/preview-config.ts",
  ]) {
    rmSync(projectPath(project, path), { force: true, recursive: true });
  }
  copyFileSync(template, projectPath(project, "src/proxy.ts"));
  rmSync(projectPath(project, "src/maintenance"), { force: true, recursive: true });
  for (const path of [
    "src/db/postgres/repository.ts",
    "src/db/sqlite/repository.ts",
  ]) {
    removeAuthoringRepositoryComposition(projectPath(project, path));
  }

  const vercelPath = projectPath(project, "vercel.json");
  if (existsSync(vercelPath)) {
    const config = JSON.parse(readFileSync(vercelPath, "utf8")) as JsonObject;
    delete config.crons;
    writeFileSync(vercelPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const typescriptPath = projectPath(project, "tsconfig.json");
  if (existsSync(typescriptPath)) {
    const config = JSON.parse(readFileSync(typescriptPath, "utf8")) as JsonObject;
    config.include = [
      "next-env.d.ts",
      "worker-configuration.d.ts",
      "src/**/*.ts",
      "src/**/*.tsx",
      ".next/types/**/*.ts",
      ".next/dev/types/**/*.ts",
    ];
    writeFileSync(typescriptPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

export function maintenanceCloudflareConfig(config: JsonObject): JsonObject {
  const vars =
    typeof config.vars === "object" && config.vars !== null && !Array.isArray(config.vars)
      ? (config.vars as JsonObject)
      : {};
  const retainedVariables = Object.fromEntries(
    [
      "NEXTJS_ENV",
      "OPAS_DATABASE_DRIVER",
      "OPAS_EMBED_PARENT_ORIGINS",
      "OPAS_PUBLIC_PROFILE",
      "OPAS_SITE_URL",
    ].flatMap((name) => (typeof vars[name] === "string" ? [[name, vars[name]]] : [])),
  );
  const maintenance: JsonObject = {
    ...config,
    main: ".open-next/worker.js",
    vars: retainedVariables,
  };
  for (const field of ["ai", "send_email", "services", "triggers", "secrets"]) {
    delete maintenance[field];
  }
  return maintenance;
}

function artifactFiles(root: string, allowedRoot = root): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (path: string) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path);
      } catch {
        throw new Error(
          `The maintenance artifact contains a broken symbolic link at ${relative(root, path)}.`,
        );
      }
      const allowed = realpathSync(allowedRoot);
      const dependencies = join(allowed, "node_modules");
      if (!isWithin(allowed, target)) {
        throw new Error(
          `The maintenance artifact contains an escaping symbolic link at ${relative(root, path)}.`,
        );
      }
      if (
        statSync(target).isDirectory() &&
        existsSync(dependencies) &&
        isWithin(realpathSync(dependencies), target)
      ) {
        return;
      }
      visit(target);
      return;
    }
    if (status.isDirectory()) {
      const real = realpathSync(path);
      if (visited.has(real)) return;
      visited.add(real);
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (status.isFile()) files.push(path);
  };
  visit(root);
  return files;
}

export function assertMaintenanceArtifactBoundary(
  pathname: string,
  allowedRootPathname = pathname,
) {
  const root = requireProjectDirectory(pathname);
  const allowedRoot = requireProjectDirectory(allowedRootPathname);
  if (!isWithin(allowedRoot, root)) {
    throw new Error("The maintenance artifact must remain inside its allowed root.");
  }
  for (const path of artifactFiles(root, allowedRoot)) {
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const forbidden of forbiddenArtifactText) {
      if (text.includes(forbidden)) {
        throw new Error(
          `The maintenance artifact contains a forbidden private reference in ${basename(path)}.`,
        );
      }
    }
  }
}

function main(args: string[]) {
  const [command, pathname, ...remaining] = args;
  if (!pathname || remaining.length > 0 || !["prepare", "scan"].includes(command)) {
    throw new Error(
      "Usage: maintenance-artifact.ts <prepare|scan> <project-or-artifact-directory>",
    );
  }
  if (command === "prepare") {
    prepareMaintenanceProject(pathname);
    return;
  }
  assertMaintenanceArtifactBoundary(pathname);
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
