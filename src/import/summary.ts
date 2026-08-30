// ABOUTME: Parses GitBook content configuration and SUMMARY.md navigation semantics.
// ABOUTME: Resolves roots, page groups, nesting, ordering, and redirects without filesystem APIs.
import { parseDocument } from "yaml";

export type GitBookRedirect = {
  source: string;
  targetPath: string;
};

export type GitBookConfiguration = {
  root: string;
  readmePath: string;
  readmeExplicit: boolean;
  summaryPath: string;
  summaryExplicit: boolean;
  redirects: GitBookRedirect[];
  unknownFields: string[];
  errors: string[];
};

export type SummaryEntry = {
  title: string;
  sourcePath: string;
  categoryName: string;
  position: number;
};

export type SummaryResult = {
  entries: SummaryEntry[];
  externalLinks: string[];
  errors: { code: "duplicate-summary-target" | "invalid-configuration"; message: string }[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeSourcePath(value: string) {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of value.replace(/^\.\//u, "").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment.normalize("NFC"));
    }
  }

  return segments.join("/");
}

export function joinSourcePath(base: string, relative: string) {
  const candidate = normalizeSourcePath(base ? `${base}/${relative}` : relative);
  return candidate;
}

export function sourceDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function configurationPath(root: string, value: unknown, fallback: string) {
  if (value === undefined) {
    return joinSourcePath(root, fallback);
  }

  return typeof value === "string" ? joinSourcePath(root, value) : null;
}

function defaultConfiguration(): GitBookConfiguration {
  return {
    root: "",
    readmePath: "README.md",
    readmeExplicit: false,
    summaryPath: "SUMMARY.md",
    summaryExplicit: false,
    redirects: [],
    unknownFields: [],
    errors: [],
  };
}

export function parseGitBookConfiguration(source?: string): GitBookConfiguration {
  if (source === undefined) {
    return defaultConfiguration();
  }

  const result = defaultConfiguration();
  const document = parseDocument(source.replace(/^\uFEFF/u, ""), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    result.errors.push(".gitbook.yaml must contain valid YAML with unique keys.");
    return result;
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 10 });
  } catch {
    result.errors.push(".gitbook.yaml contains unsupported YAML aliases.");
    return result;
  }

  if (!isPlainRecord(value)) {
    result.errors.push(".gitbook.yaml must be a key-value object.");
    return result;
  }

  result.unknownFields.push(
    ...Object.keys(value)
      .filter((field) => !new Set(["root", "structure", "redirects"]).has(field))
      .map((field) => `.gitbook.yaml.${field}`),
  );

  if (value.root !== undefined && typeof value.root !== "string") {
    result.errors.push(".gitbook.yaml root must be a relative directory path.");
    return result;
  }

  const rootValue = typeof value.root === "string" ? value.root : "./";
  const root = normalizeSourcePath(rootValue);
  if (root === null) {
    result.errors.push(".gitbook.yaml root must remain inside the archive.");
    return result;
  }
  result.root = root;

  let structure: Record<string, unknown> = {};
  if (value.structure !== undefined) {
    if (!isPlainRecord(value.structure)) {
      result.errors.push(".gitbook.yaml structure must be a key-value object.");
      return result;
    }
    structure = value.structure;
    result.unknownFields.push(
      ...Object.keys(structure)
        .filter((field) => field !== "readme" && field !== "summary")
        .map((field) => `.gitbook.yaml.structure.${field}`),
    );
  }

  result.readmeExplicit = structure.readme !== undefined;
  result.summaryExplicit = structure.summary !== undefined;
  const readmePath = configurationPath(root, structure.readme, "README.md");
  const summaryPath = configurationPath(root, structure.summary, "SUMMARY.md");
  if (!readmePath || !summaryPath) {
    result.errors.push("GitBook structure paths must remain inside the archive.");
    return result;
  }
  result.readmePath = readmePath;
  result.summaryPath = summaryPath;

  if (value.redirects !== undefined) {
    if (!isPlainRecord(value.redirects)) {
      result.errors.push(".gitbook.yaml redirects must be a source-to-page object.");
      return result;
    }

    for (const [sourcePath, target] of Object.entries(value.redirects).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const source = normalizeSourcePath(sourcePath);
      const targetPath = typeof target === "string" ? joinSourcePath(root, target) : null;
      if (!source || !targetPath || source.includes("*") || targetPath.includes("*")) {
        result.errors.push(
          `Redirect ${JSON.stringify(sourcePath)} must use safe relative source and page paths.`,
        );
      } else {
        result.redirects.push({ source, targetPath });
      }
    }
  }

  result.unknownFields.sort();
  return result;
}

function decodeLinkTarget(value: string) {
  const target = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  try {
    return decodeURIComponent(target);
  } catch {
    return null;
  }
}

function plainTitle(value: string) {
  return value
    .replace(/\\([\\`*{}\[\]()#+.!_-])/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const summaryLinkPattern = /^([ \t]*)[-*+]\s+\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)\s*$/u;

export function parseSummary(source: string, summaryPath: string): SummaryResult {
  const result: SummaryResult = { entries: [], externalLinks: [], errors: [] };
  const summaryDirectory = sourceDirectory(summaryPath);
  const seenTargets = new Set<string>();
  let groupName: string | null = null;
  let rootPageName: string | null = null;

  for (const [index, line] of source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n").entries()) {
    const groupMatch = /^ {0,3}##(?:[ \t]+)(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (groupMatch) {
      groupName = plainTitle(groupMatch[1]);
      rootPageName = null;
      if (!groupName) {
        result.errors.push({
          code: "invalid-configuration",
          message: `SUMMARY.md has an empty page group at line ${index + 1}.`,
        });
      }
      continue;
    }

    const match = summaryLinkPattern.exec(line);
    if (!match) {
      if (/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/u.test(line)) {
        result.errors.push({
          code: "invalid-configuration",
          message: `SUMMARY.md has unsupported or malformed list content at line ${index + 1}.`,
        });
      }
      continue;
    }

    if (match[1].includes("\t")) {
      result.errors.push({
        code: "invalid-configuration",
        message: `SUMMARY.md indentation must use spaces at line ${index + 1}.`,
      });
      continue;
    }

    const title = plainTitle(match[2]);
    const rawTarget = decodeLinkTarget(match[3]);
    if (!title || rawTarget === null) {
      result.errors.push({
        code: "invalid-configuration",
        message: `SUMMARY.md has an invalid page link at line ${index + 1}.`,
      });
      continue;
    }

    if (/^[a-z][a-z\d+.-]*:/iu.test(rawTarget) || rawTarget.startsWith("//")) {
      result.externalLinks.push(rawTarget);
      continue;
    }

    const targetWithoutFragment = rawTarget.split(/[?#]/u, 1)[0];
    const targetPath = joinSourcePath(summaryDirectory, targetWithoutFragment);
    if (!targetPath) {
      result.errors.push({
        code: "invalid-configuration",
        message: `SUMMARY.md target ${JSON.stringify(rawTarget)} leaves the archive.`,
      });
      continue;
    }

    const targetKey = targetPath.toLocaleLowerCase("en-US");
    if (seenTargets.has(targetKey)) {
      result.errors.push({
        code: "duplicate-summary-target",
        message: `SUMMARY.md references ${targetPath} more than once.`,
      });
      continue;
    }
    seenTargets.add(targetKey);

    const isRootPage = match[1].length === 0;
    if (isRootPage) {
      rootPageName = title;
    }
    const categoryName = groupName ?? rootPageName;
    if (!categoryName) {
      result.errors.push({
        code: "invalid-configuration",
        message: `SUMMARY.md has a nested page without a top-level page or group at line ${index + 1}.`,
      });
      continue;
    }

    result.entries.push({
      title,
      sourcePath: targetPath,
      categoryName,
      position: result.entries.length,
    });
  }

  return result;
}
