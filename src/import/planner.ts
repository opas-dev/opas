// ABOUTME: Produces a deterministic, write-free plan for Markdown and GitBook imports.
// ABOUTME: Validates all content before exposing categories, articles, assets, or redirects.
import type { ArchiveFile } from "@/import/archive";
import {
  extractFrontmatter,
  type ImportedArticleFields,
} from "@/import/frontmatter";
import {
  rewriteMarkdownLinks,
  type ResolvedImportTarget,
} from "@/import/links";
import {
  findLevelOneHeadings,
  findUnsupportedMarkup,
  normalizeTitleHeading,
} from "@/import/markdown";
import {
  createImportReport,
  reportHasErrors,
  type ImportConflictCode,
  type ImportReport,
} from "@/import/report";
import {
  joinSourcePath,
  parseGitBookConfiguration,
  parseSummary,
  sourceDirectory,
  type SummaryEntry,
} from "@/import/summary";
import { validateArticleMdx } from "@/content/mdx-safety";
import { referencedArticleAssetHashes } from "@/content/article-assets";

export type PlannedImportCategory = {
  name: string;
  slug: string;
  position: number;
};

export type PlannedImportArticle = {
  sourcePath: string;
  categorySlug: string;
  slug: string;
  title: string;
  mdx: string;
  status: "draft" | "published";
  isFaq: boolean;
  authorName: string;
  position: number;
  assetHashes: string[];
  canonicalUrl: string;
};

export type PlannedImportAsset = {
  sourcePaths: string[];
  hash: string;
  mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  byteSize: number;
  content: Uint8Array;
  canonicalUrl: string;
};

export type PlannedImportRedirect = {
  source: string;
  destination: string;
  reason: "canonical-path" | "configured";
};

export type KnowledgeImportPlan = {
  ready: boolean;
  categories: PlannedImportCategory[];
  articles: PlannedImportArticle[];
  assets: PlannedImportAsset[];
  redirects: PlannedImportRedirect[];
  report: ImportReport;
};

export type KnowledgeImportOptions = {
  articleMetadata?: Readonly<Record<string, ImportedArticleFields>>;
  existingArticleSlugs?: readonly string[];
  existingCategorySlugs?: readonly string[];
  defaultStatus?: "draft" | "published";
  defaultAuthorName?: string;
};

type NormalizedFile = ArchiveFile & { path: string };

type ArticleCandidate = SummaryEntry & {
  summaryTitle?: string;
};

type PreparedArticle = Omit<PlannedImportArticle, "assetHashes" | "canonicalUrl" | "mdx"> & {
  body: string;
  bodyStartLine: number;
  canonicalUrl: string;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const markdownExtensions = new Set([".markdown", ".md"]);
const assetByteLimit = 1_024 * 1_024;
const reservedCategorySlugs = new Set(["admin", "api", "spike"]);

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathExtension(path: string) {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLocaleLowerCase("en-US");
}

function withoutMarkdownExtension(path: string) {
  return path.replace(/\.(?:markdown|md)$/iu, "");
}

function withinRoot(path: string, root: string) {
  return root === "" || path === root || path.startsWith(`${root}/`);
}

function relativeToRoot(path: string, root: string) {
  return root ? path.slice(root.length + 1) : path;
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slugify(value: string, fallbackPrefix: string) {
  let slug = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");

  if (!slug) {
    slug = `${fallbackPrefix}-${stableHash(value)}`;
  }
  if (slug.length > 120) {
    slug = `${slug.slice(0, 111).replace(/-+$/u, "")}-${stableHash(value)}`;
  }
  return slug;
}

function humanize(value: string) {
  const words = value
    .replace(/\.(?:markdown|md)$/iu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return words ? words.replace(/(^|\s)(\p{Letter})/gu, (_, prefix, letter: string) => `${prefix}${letter.toLocaleUpperCase("en-US")}`) : "Documentation";
}

function normalizeInputPath(value: string) {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    return null;
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.map((segment) => segment.normalize("NFC")).join("/");
}

function addConflict(
  report: ImportReport,
  code: ImportConflictCode,
  path: string,
  message: string,
  field?: string,
  severity: "error" | "warning" = "error",
) {
  report.conflicts.push({ code, severity, path, field, message });
}

function blockedPlan(report: ImportReport): KnowledgeImportPlan {
  report.completion = {
    status: "blocked",
    categories: 0,
    articles: 0,
    assets: 0,
    redirects: 0,
  };
  return {
    ready: false,
    categories: [],
    articles: [],
    assets: [],
    redirects: [],
    report,
  };
}

function normalizeFiles(files: readonly ArchiveFile[], report: ImportReport) {
  const normalized: NormalizedFile[] = [];
  const paths = new Map<string, string>();

  for (const file of files) {
    const path = normalizeInputPath(file.path);
    if (!path) {
      addConflict(report, "invalid-path", file.path, "Import file paths must be safe archive-relative paths.");
      continue;
    }

    const key = path.toLocaleLowerCase("en-US");
    const existing = paths.get(key);
    if (existing) {
      addConflict(
        report,
        "duplicate-path",
        path,
        `Import paths ${JSON.stringify(existing)} and ${JSON.stringify(path)} collide after Unicode and case normalization.`,
      );
      continue;
    }

    paths.set(key, path);
    normalized.push({ path, content: new Uint8Array(file.content) });
  }

  return normalized.sort((left, right) => {
    const folded = compareText(
      left.path.toLocaleLowerCase("en-US"),
      right.path.toLocaleLowerCase("en-US"),
    );
    return folded || compareText(left.path, right.path);
  });
}

function decodeFile(file: NormalizedFile, report: ImportReport) {
  try {
    return decoder.decode(file.content);
  } catch {
    addConflict(report, "invalid-content", file.path, "Markdown and configuration files must be valid UTF-8.");
    return null;
  }
}

function startsWith(content: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => content[index] === byte);
}

function sniffMediaType(content: Uint8Array): PlannedImportAsset["mediaType"] | null {
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(content, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWith(content, [0x52, 0x49, 0x46, 0x46]) &&
    content[8] === 0x57 &&
    content[9] === 0x45 &&
    content[10] === 0x42 &&
    content[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function expectedMediaType(path: string): PlannedImportAsset["mediaType"] | null {
  switch (pathExtension(path)) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

async function sha256(content: Uint8Array) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function planAssets(files: readonly NormalizedFile[], root: string, report: ImportReport) {
  const assetsByHash = new Map<string, PlannedImportAsset>();
  const assetByPath = new Map<string, PlannedImportAsset>();

  for (const file of files) {
    if (!withinRoot(file.path, root)) {
      continue;
    }
    const expected = expectedMediaType(file.path);
    if (!expected) {
      continue;
    }
    if (file.content.byteLength > assetByteLimit) {
      addConflict(report, "asset-limit", file.path, "Imported images must be 1 MiB or smaller.");
      continue;
    }

    const detected = sniffMediaType(file.content);
    if (detected !== expected) {
      addConflict(
        report,
        "mime-spoofing",
        file.path,
        `The ${pathExtension(file.path)} extension does not match the image signature.`,
      );
      continue;
    }

    const hash = await sha256(file.content);
    let asset = assetsByHash.get(hash);
    if (!asset) {
      asset = {
        sourcePaths: [file.path],
        hash,
        mediaType: detected,
        byteSize: file.content.byteLength,
        content: file.content,
        canonicalUrl: `/api/assets/${hash}`,
      };
      assetsByHash.set(hash, asset);
    } else {
      asset.sourcePaths.push(file.path);
      report.skippedContent.push({ path: file.path, reason: "duplicate-asset" });
    }
    assetByPath.set(file.path.toLocaleLowerCase("en-US"), asset);
  }

  return { assets: [...assetsByHash.values()], assetByPath };
}

function inferredCategory(path: string, root: string) {
  const relative = relativeToRoot(path, root);
  if (/^README\.(?:markdown|md)$/iu.test(relative)) {
    return "Overview";
  }
  const segments = relative.split("/");
  return segments.length > 1 ? humanize(segments[0]) : "Documentation";
}

function articlePathSlug(path: string, root: string) {
  return slugify(withoutMarkdownExtension(relativeToRoot(path, root)), "article");
}

function fallbackTitle(path: string) {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  return /^README\.(?:markdown|md)$/iu.test(fileName) ? "Overview" : humanize(fileName);
}

function metadataDisagreements<T>(
  report: ImportReport,
  path: string,
  field: string,
  selectedSource: string,
  selectedValue: T,
  candidates: readonly { source: string; value: T | undefined }[],
) {
  for (const candidate of candidates) {
    if (candidate.value !== undefined && candidate.value !== selectedValue) {
      addConflict(
        report,
        "metadata-conflict",
        path,
        `${selectedSource} ${field} ${JSON.stringify(selectedValue)} takes precedence over ${candidate.source} ${JSON.stringify(candidate.value)}.`,
        field,
        "warning",
      );
    }
  }
}

function validateMetadata(
  sourcePath: string,
  fields: ImportedArticleFields,
  report: ImportReport,
) {
  const value = fields as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (!new Set(["title", "slug", "status", "isFaq", "authorName"]).has(field)) {
      addConflict(report, "invalid-metadata", sourcePath, `Operator metadata field ${field} is unsupported.`, field);
    }
  }
  if (fields.title !== undefined && (typeof fields.title !== "string" || !fields.title.trim() || fields.title.length > 160 || fields.title.includes("\n"))) {
    addConflict(report, "invalid-metadata", sourcePath, "Operator title metadata is invalid.", "title");
  }
  if (fields.slug !== undefined && (typeof fields.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fields.slug) || fields.slug.length > 120)) {
    addConflict(report, "invalid-metadata", sourcePath, "Operator slug metadata is invalid.", "slug");
  }
  if (fields.status !== undefined && fields.status !== "draft" && fields.status !== "published") {
    addConflict(report, "invalid-metadata", sourcePath, "Operator status metadata is invalid.", "status");
  }
  if (fields.isFaq !== undefined && typeof fields.isFaq !== "boolean") {
    addConflict(report, "invalid-metadata", sourcePath, "Operator isFaq metadata is invalid.", "isFaq");
  }
  if (fields.authorName !== undefined && (typeof fields.authorName !== "string" || !fields.authorName.trim() || fields.authorName.length > 100 || fields.authorName.includes("\n"))) {
    addConflict(report, "invalid-metadata", sourcePath, "Operator authorName metadata is invalid.", "authorName");
  }
  return fields;
}

function sourceRoute(path: string, root: string) {
  let relative = withoutMarkdownExtension(relativeToRoot(path, root));
  relative = relative.replace(/(?:^|\/)README$/iu, "").replace(/\/+$/u, "");
  return relative
    ? `/${relative.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`
    : "/";
}

function addArticleAlias(
  aliases: Map<string, PreparedArticle>,
  alias: string,
  article: PreparedArticle,
  report: ImportReport,
) {
  const key = alias.toLocaleLowerCase("en-US");
  const existing = aliases.get(key);
  if (existing && existing.sourcePath !== article.sourcePath) {
    addConflict(
      report,
      "slug-conflict",
      article.sourcePath,
      `Source paths ${existing.sourcePath} and ${article.sourcePath} share the internal route ${alias}.`,
      "slug",
    );
  } else {
    aliases.set(key, article);
  }
}

export async function planKnowledgeImport(
  sourceFiles: readonly ArchiveFile[],
  options: KnowledgeImportOptions = {},
): Promise<KnowledgeImportPlan> {
  const report = createImportReport(sourceFiles.length);
  const files = normalizeFiles(sourceFiles, report);
  if (reportHasErrors(report)) {
    return blockedPlan(report);
  }
  const filesByPath = new Map(files.map((file) => [file.path, file]));

  const configFile = filesByPath.get(".gitbook.yaml");
  const configSource = configFile ? decodeFile(configFile, report) : undefined;
  const configuration = parseGitBookConfiguration(configSource ?? undefined);
  report.dryRun.contentRoot = configuration.root;
  for (const field of configuration.unknownFields) {
    report.unknownFields.push({ path: ".gitbook.yaml", field, scope: "configuration" });
  }
  for (const message of configuration.errors) {
    addConflict(report, "invalid-configuration", ".gitbook.yaml", message);
  }
  if (configFile) {
    report.skippedContent.push({ path: configFile.path, reason: "configuration-file" });
  }
  if (reportHasErrors(report)) {
    return blockedPlan(report);
  }

  const rootFiles = files.filter((file) => withinRoot(file.path, configuration.root));
  for (const file of files) {
    if (file.path !== ".gitbook.yaml" && !withinRoot(file.path, configuration.root)) {
      report.skippedContent.push({ path: file.path, reason: "outside-content-root" });
    }
  }

  const summaryFile = filesByPath.get(configuration.summaryPath);
  const readmeFile = filesByPath.get(configuration.readmePath);
  if (configuration.summaryExplicit && !summaryFile) {
    addConflict(
      report,
      "missing-configuration-target",
      configuration.summaryPath,
      "The configured GitBook summary file is missing.",
    );
  }
  if (configuration.readmeExplicit && !readmeFile) {
    addConflict(
      report,
      "missing-configuration-target",
      configuration.readmePath,
      "The configured GitBook readme file is missing.",
    );
  }

  const markdownFiles = rootFiles.filter((file) => markdownExtensions.has(pathExtension(file.path)));
  let summaryEntries: SummaryEntry[] | null = null;
  if (summaryFile) {
    const summarySource = decodeFile(summaryFile, report);
    report.dryRun.summaryPath = summaryFile.path;
    report.skippedContent.push({ path: summaryFile.path, reason: "summary-file" });
    if (summarySource !== null) {
      const summary = parseSummary(summarySource, summaryFile.path);
      summaryEntries = summary.entries;
      for (const target of summary.externalLinks) {
        report.skippedContent.push({ path: target, reason: "external-summary-link" });
      }
      for (const issue of summary.errors) {
        addConflict(report, issue.code, summaryFile.path, issue.message);
      }
      for (const entry of summary.entries) {
        if (!filesByPath.has(entry.sourcePath) || !markdownExtensions.has(pathExtension(entry.sourcePath))) {
          addConflict(
            report,
            "missing-summary-target",
            entry.sourcePath,
            `SUMMARY.md page ${entry.sourcePath} is missing or is not Markdown.`,
          );
        }
      }
    }
  }
  if (reportHasErrors(report)) {
    return blockedPlan(report);
  }

  const candidates: ArticleCandidate[] = [];
  if (summaryEntries) {
    const listed = new Set(summaryEntries.map((entry) => entry.sourcePath));
    if (readmeFile && !listed.has(readmeFile.path)) {
      candidates.push({
        sourcePath: readmeFile.path,
        title: "Overview",
        summaryTitle: undefined,
        categoryName: "Overview",
        position: 0,
      });
      listed.add(readmeFile.path);
    }
    for (const entry of summaryEntries) {
      candidates.push({ ...entry, summaryTitle: entry.title });
    }
    for (const file of markdownFiles) {
      if (file.path !== summaryFile?.path && !listed.has(file.path)) {
        report.skippedContent.push({ path: file.path, reason: "unlisted-markdown" });
      }
    }
  } else {
    for (const file of markdownFiles.filter((file) => file.path !== summaryFile?.path)) {
      candidates.push({
        sourcePath: file.path,
        title: "",
        categoryName: inferredCategory(file.path, configuration.root),
        position: candidates.length,
      });
    }
  }
  candidates.forEach((candidate, position) => {
    candidate.position = position;
  });

  if (candidates.length === 0) {
    addConflict(report, "invalid-configuration", configuration.root || ".", "The import contains no Markdown articles.");
    return blockedPlan(report);
  }

  for (const file of rootFiles) {
    const extension = pathExtension(file.path);
    if (
      file.path === summaryFile?.path ||
      file.path === ".gitbook.yaml" ||
      markdownExtensions.has(extension) ||
      expectedMediaType(file.path)
    ) {
      continue;
    }
    if (extension === ".html" || extension === ".htm" || extension === ".mdx") {
      addConflict(report, "unsupported-markup", file.path, "HTML and MDX source files require manual conversion to safe Markdown.");
    } else {
      report.skippedContent.push({ path: file.path, reason: "unsupported-file" });
    }
  }

  const { assets, assetByPath } = await planAssets(rootFiles, configuration.root, report);
  const metadataByPath = new Map<string, ImportedArticleFields>();
  for (const [rawPath, metadata] of Object.entries(options.articleMetadata ?? {}).sort(([left], [right]) => compareText(left, right))) {
    const path = normalizeInputPath(rawPath);
    if (!path) {
      addConflict(report, "invalid-path", rawPath, "Operator metadata paths must be safe archive-relative paths.");
    } else {
      metadataByPath.set(path, validateMetadata(path, metadata, report));
    }
  }

  const existingCategorySlugs = new Set((options.existingCategorySlugs ?? []).map((slug) => slug.toLocaleLowerCase("en-US")));
  const categories: PlannedImportCategory[] = [];
  const categoryByName = new Map<string, PlannedImportCategory>();
  const categoryBySlug = new Map<string, PlannedImportCategory>();
  for (const candidate of candidates) {
    let category = categoryByName.get(candidate.categoryName);
    if (category) {
      continue;
    }
    if (!candidate.categoryName || candidate.categoryName.length > 100) {
      addConflict(report, "invalid-metadata", candidate.sourcePath, "Category names must contain 1 to 100 characters.", "category");
      continue;
    }

    let slug = slugify(candidate.categoryName, "category");
    if (reservedCategorySlugs.has(slug)) {
      slug = `docs-${slug}`;
    }
    const collision = categoryBySlug.get(slug);
    if (collision && collision.name !== candidate.categoryName) {
      addConflict(report, "slug-conflict", candidate.sourcePath, `Categories ${collision.name} and ${candidate.categoryName} both map to /${slug}.`, "category");
      continue;
    }
    if (existingCategorySlugs.has(slug)) {
      addConflict(report, "slug-conflict", candidate.sourcePath, `Category slug ${slug} already exists in the workspace.`, "category");
      continue;
    }

    category = { name: candidate.categoryName, slug, position: categories.length };
    categories.push(category);
    categoryByName.set(candidate.categoryName, category);
    categoryBySlug.set(slug, category);
  }

  const defaultStatus = options.defaultStatus ?? "draft";
  const defaultAuthorName = options.defaultAuthorName?.trim() || "OPAS";
  if (defaultAuthorName.length > 100) {
    addConflict(report, "invalid-metadata", ".", "The default author name exceeds 100 characters.", "authorName");
  }
  const existingArticleSlugs = new Set((options.existingArticleSlugs ?? []).map((slug) => slug.toLocaleLowerCase("en-US")));
  const preparedArticles: PreparedArticle[] = [];
  const articleBySlug = new Map<string, PreparedArticle>();

  for (const candidate of candidates) {
    const file = filesByPath.get(candidate.sourcePath);
    const category = categoryByName.get(candidate.categoryName);
    if (!file || !category) {
      continue;
    }
    const source = decodeFile(file, report);
    if (source === null) {
      continue;
    }

    const frontmatter = extractFrontmatter(source);
    for (const field of frontmatter.unknownFields) {
      report.unknownFields.push({ path: file.path, field, scope: "frontmatter" });
    }
    for (const issue of frontmatter.errors) {
      addConflict(report, "invalid-frontmatter", file.path, issue.message, issue.field);
    }
    for (const issue of findUnsupportedMarkup(frontmatter.body)) {
      addConflict(
        report,
        "unsupported-markup",
        file.path,
        `${issue.message} Found at line ${frontmatter.bodyStartLine + issue.line - 1}.`,
      );
    }

    const metadata = metadataByPath.get(file.path) ?? {};
    const firstHeading = findLevelOneHeadings(frontmatter.body)[0]?.title;
    const titleChoices = [
      { source: "operator metadata", value: metadata.title?.trim() },
      { source: "frontmatter", value: frontmatter.fields.title },
      { source: "SUMMARY.md", value: candidate.summaryTitle },
      { source: "first H1", value: firstHeading },
      { source: "filename", value: fallbackTitle(file.path) },
    ];
    const selectedTitle = titleChoices.find((choice) => choice.value)?.value as string;
    const selectedTitleSource = titleChoices.find((choice) => choice.value)?.source as string;
    if (!selectedTitle || selectedTitle.length > 160 || selectedTitle.includes("\n")) {
      addConflict(report, "invalid-metadata", file.path, "The selected article title must contain 1 to 160 characters.", "title");
      continue;
    }
    metadataDisagreements(
      report,
      file.path,
      "title",
      selectedTitleSource,
      selectedTitle,
      titleChoices.filter((choice) => choice.source !== selectedTitleSource),
    );

    const derivedSlug = articlePathSlug(file.path, configuration.root);
    const slug = metadata.slug ?? frontmatter.fields.slug ?? derivedSlug;
    const slugSource = metadata.slug ? "operator metadata" : frontmatter.fields.slug ? "frontmatter" : "source path";
    metadataDisagreements(report, file.path, "slug", slugSource, slug, [
      { source: "frontmatter", value: metadata.slug ? frontmatter.fields.slug : undefined },
      { source: "source path", value: derivedSlug },
    ]);
    if (slug !== derivedSlug) {
      report.renames.push({
        path: file.path,
        from: derivedSlug,
        to: slug,
        reason: metadata.slug ? "metadata-slug" : "frontmatter-slug",
      });
    }

    const status = metadata.status ?? frontmatter.fields.status ?? defaultStatus;
    const statusSource =
      metadata.status !== undefined
        ? "operator metadata"
        : frontmatter.fields.status !== undefined
          ? "frontmatter"
          : "default";
    metadataDisagreements(report, file.path, "status", statusSource, status, [
      { source: "frontmatter", value: metadata.status ? frontmatter.fields.status : undefined },
      { source: "default", value: defaultStatus },
    ]);
    const isFaq = metadata.isFaq ?? frontmatter.fields.isFaq ?? false;
    const isFaqSource =
      metadata.isFaq !== undefined
        ? "operator metadata"
        : frontmatter.fields.isFaq !== undefined
          ? "frontmatter"
          : "default";
    metadataDisagreements(report, file.path, "isFaq", isFaqSource, isFaq, [
      {
        source: "frontmatter",
        value: metadata.isFaq !== undefined ? frontmatter.fields.isFaq : undefined,
      },
      { source: "default", value: false },
    ]);

    const metadataAuthorName = metadata.authorName?.trim();
    const authorName = metadataAuthorName ?? frontmatter.fields.authorName ?? defaultAuthorName;
    const authorNameSource =
      metadataAuthorName !== undefined
        ? "operator metadata"
        : frontmatter.fields.authorName !== undefined
          ? "frontmatter"
          : "default";
    metadataDisagreements(report, file.path, "authorName", authorNameSource, authorName, [
      {
        source: "frontmatter",
        value: metadataAuthorName !== undefined ? frontmatter.fields.authorName : undefined,
      },
      { source: "default", value: defaultAuthorName },
    ]);

    const normalizedSlug = slug.toLocaleLowerCase("en-US");
    const collision = articleBySlug.get(normalizedSlug);
    if (collision || existingArticleSlugs.has(normalizedSlug)) {
      addConflict(
        report,
        "slug-conflict",
        file.path,
        collision
          ? `Articles ${collision.sourcePath} and ${file.path} both map to /${slug}.`
          : `Article slug ${slug} already exists in the workspace.`,
        "slug",
      );
      continue;
    }

    const canonicalUrl = `/${category.slug}/${slug}`;
    const prepared: PreparedArticle = {
      sourcePath: file.path,
      categorySlug: category.slug,
      slug,
      title: selectedTitle,
      status,
      isFaq,
      authorName,
      position: candidate.position,
      body: frontmatter.body,
      bodyStartLine: frontmatter.bodyStartLine,
      canonicalUrl,
    };
    preparedArticles.push(prepared);
    articleBySlug.set(normalizedSlug, prepared);
  }

  const articleAliases = new Map<string, PreparedArticle>();
  for (const article of preparedArticles) {
    addArticleAlias(articleAliases, article.sourcePath, article, report);
    addArticleAlias(articleAliases, withoutMarkdownExtension(article.sourcePath), article, report);
    if (/\/(?:README)\.(?:markdown|md)$/iu.test(article.sourcePath) || /^(?:README)\.(?:markdown|md)$/iu.test(article.sourcePath)) {
      addArticleAlias(articleAliases, sourceDirectory(article.sourcePath), article, report);
    }
  }

  const articles: PlannedImportArticle[] = [];
  for (const article of preparedArticles) {
    const heading = normalizeTitleHeading(
      article.body,
      article.title,
      article.bodyStartLine - 1,
    );
    for (const change of heading.changes) {
      report.changes.push({ path: article.sourcePath, ...change });
    }

    const rewritten = rewriteMarkdownLinks(heading.markdown, (target): ResolvedImportTarget => {
      const resolved = target.startsWith("/")
        ? joinSourcePath(configuration.root, target.slice(1))
        : joinSourcePath(sourceDirectory(article.sourcePath), target);
      if (!resolved) {
        return { status: "unsafe", message: `Local target ${JSON.stringify(target)} leaves the import root.` };
      }
      if (!withinRoot(resolved, configuration.root)) {
        return { status: "unsafe", message: `Local target ${JSON.stringify(target)} leaves the configured content root.` };
      }

      const key = resolved.toLocaleLowerCase("en-US");
      const targetArticle = articleAliases.get(key);
      if (targetArticle) {
        return { status: "resolved", canonicalUrl: targetArticle.canonicalUrl };
      }
      const asset = assetByPath.get(key);
      if (asset) {
        return { status: "resolved", canonicalUrl: asset.canonicalUrl };
      }
      return { status: "missing", message: `Local target ${JSON.stringify(target)} does not exist in the import.` };
    });
    for (const issue of rewritten.issues) {
      addConflict(
        report,
        issue.code,
        article.sourcePath,
        `${issue.message} Found at imported body line ${issue.line}.`,
      );
    }
    if (new TextEncoder().encode(rewritten.markdown).byteLength > 100_000) {
      addConflict(report, "invalid-content", article.sourcePath, "The imported article exceeds OPAS's 100 KB content limit.");
    }
    try {
      await validateArticleMdx(rewritten.markdown, article.title);
    } catch {
      addConflict(
        report,
        "unsupported-markup",
        article.sourcePath,
        "The imported article contains syntax outside OPAS's safe Markdown contract.",
      );
    }

    const assetHashes = referencedArticleAssetHashes(rewritten.markdown);
    articles.push({
      sourcePath: article.sourcePath,
      categorySlug: article.categorySlug,
      slug: article.slug,
      title: article.title,
      mdx: rewritten.markdown,
      status: article.status,
      isFaq: article.isFaq,
      authorName: article.authorName,
      position: article.position,
      assetHashes,
      canonicalUrl: article.canonicalUrl,
    });
  }

  const referencedAssetHashes = new Set(articles.flatMap((article) => article.assetHashes));
  const plannedAssets = assets.filter((asset) => {
    if (referencedAssetHashes.has(asset.hash)) {
      return true;
    }
    for (const path of asset.sourcePaths) {
      report.skippedContent.push({ path, reason: "unreferenced-asset" });
    }
    return false;
  });

  const redirects: PlannedImportRedirect[] = [];
  const redirectBySource = new Map<string, PlannedImportRedirect>();
  const canonicalUrls = new Set(articles.map((article) => article.canonicalUrl));
  const addRedirect = (redirect: PlannedImportRedirect, path: string) => {
    const existing = redirectBySource.get(redirect.source);
    if (
      (existing && existing.destination !== redirect.destination) ||
      (canonicalUrls.has(redirect.source) && redirect.source !== redirect.destination)
    ) {
      addConflict(report, "redirect-conflict", path, `Redirect ${redirect.source} conflicts with another planned route.`);
      return;
    }
    if (!existing && redirect.source !== redirect.destination) {
      redirects.push(redirect);
      redirectBySource.set(redirect.source, redirect);
    }
  };

  for (const article of articles) {
    const previousRoute = sourceRoute(article.sourcePath, configuration.root);
    if (previousRoute !== article.canonicalUrl) {
      report.renames.push({
        path: article.sourcePath,
        from: previousRoute,
        to: article.canonicalUrl,
        reason: "canonical-path",
      });
      if (previousRoute !== "/") {
        addRedirect(
          { source: previousRoute, destination: article.canonicalUrl, reason: "canonical-path" },
          article.sourcePath,
        );
      }
    }
  }
  for (const redirect of configuration.redirects) {
    const destination = articleAliases.get(redirect.targetPath.toLocaleLowerCase("en-US"));
    if (!destination) {
      addConflict(report, "redirect-conflict", ".gitbook.yaml", `Redirect target ${redirect.targetPath} is not an imported page.`);
      continue;
    }
    addRedirect(
      { source: `/${redirect.source}`, destination: destination.canonicalUrl, reason: "configured" },
      ".gitbook.yaml",
    );
  }

  report.renames.sort((left, right) => compareText(`${left.path}\u0000${left.from}\u0000${left.to}`, `${right.path}\u0000${right.from}\u0000${right.to}`));
  report.unknownFields.sort((left, right) => compareText(`${left.path}\u0000${left.field}`, `${right.path}\u0000${right.field}`));
  report.skippedContent.sort((left, right) => compareText(`${left.path}\u0000${left.reason}`, `${right.path}\u0000${right.reason}`));

  if (reportHasErrors(report)) {
    return blockedPlan(report);
  }

  report.completion = {
    status: "ready",
    categories: categories.length,
    articles: articles.length,
    assets: plannedAssets.length,
    redirects: redirects.length,
  };
  return { ready: true, categories, articles, assets: plannedAssets, redirects, report };
}
