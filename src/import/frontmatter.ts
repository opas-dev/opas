// ABOUTME: Extracts an explicit OPAS article-field allowlist from YAML frontmatter.
// ABOUTME: Strips import metadata while reporting unknown or invalid fields without coercion.
import { parseDocument } from "yaml";

export type ImportedArticleFields = {
  title?: string;
  slug?: string;
  status?: "draft" | "published";
  isFaq?: boolean;
  authorName?: string;
};

export type FrontmatterResult = {
  body: string;
  bodyStartLine: number;
  fields: ImportedArticleFields;
  unknownFields: string[];
  errors: { field?: string; message: string }[];
};

const allowedFields = new Set(["title", "slug", "status", "isFaq", "authorName"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  field: string,
  maximum: number,
  errors: FrontmatterResult["errors"],
) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\n")) {
    errors.push({ field, message: `${field} must be a non-empty single-line string.` });
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length > maximum) {
    errors.push({ field, message: `${field} exceeds its ${maximum}-character limit.` });
    return undefined;
  }

  return normalized;
}

export function extractFrontmatter(source: string): FrontmatterResult {
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const empty: FrontmatterResult = {
    body: normalized,
    bodyStartLine: 1,
    fields: {},
    unknownFields: [],
    errors: [],
  };

  if (lines[0]?.trim() !== "---") {
    return empty;
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  if (closingIndex < 0) {
    empty.errors.push({ message: "Frontmatter is missing its closing delimiter." });
    return empty;
  }

  const result: FrontmatterResult = {
    body: lines.slice(closingIndex + 1).join("\n").replace(/^\n+/u, ""),
    bodyStartLine: closingIndex + 2,
    fields: {},
    unknownFields: [],
    errors: [],
  };
  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    result.errors.push({ message: "Frontmatter must contain valid YAML with unique keys." });
    return result;
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 10 });
  } catch {
    result.errors.push({ message: "Frontmatter contains unsupported YAML aliases." });
    return result;
  }

  if (value === null) {
    return result;
  }

  if (!isPlainRecord(value)) {
    result.errors.push({ message: "Frontmatter must be a key-value object." });
    return result;
  }

  result.unknownFields = Object.keys(value)
    .filter((field) => !allowedFields.has(field))
    .sort();

  if ("title" in value) {
    result.fields.title = boundedText(value.title, "title", 160, result.errors);
  }

  if ("slug" in value) {
    const slug = boundedText(value.slug, "slug", 120, result.errors);
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      result.errors.push({
        field: "slug",
        message: "slug must contain lowercase letters, numbers, and single hyphens only.",
      });
    } else if (slug) {
      result.fields.slug = slug;
    }
  }

  if ("status" in value) {
    if (value.status === "draft" || value.status === "published") {
      result.fields.status = value.status;
    } else {
      result.errors.push({ field: "status", message: "status must be draft or published." });
    }
  }

  if ("isFaq" in value) {
    if (typeof value.isFaq === "boolean") {
      result.fields.isFaq = value.isFaq;
    } else {
      result.errors.push({ field: "isFaq", message: "isFaq must be a boolean." });
    }
  }

  if ("authorName" in value) {
    result.fields.authorName = boundedText(
      value.authorName,
      "authorName",
      100,
      result.errors,
    );
  }

  return result;
}
