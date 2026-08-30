// ABOUTME: Defines structured dry-run and completion reports for knowledge imports.
// ABOUTME: Keeps every rename, conflict, skipped item, and deterministic repair inspectable.
export type ImportConflictCode =
  | "asset-limit"
  | "duplicate-path"
  | "duplicate-summary-target"
  | "invalid-configuration"
  | "invalid-content"
  | "invalid-frontmatter"
  | "invalid-metadata"
  | "invalid-path"
  | "metadata-conflict"
  | "mime-spoofing"
  | "missing-configuration-target"
  | "missing-link-target"
  | "missing-summary-target"
  | "redirect-conflict"
  | "slug-conflict"
  | "unsafe-link-target"
  | "unsupported-markup";

export type ImportConflict = {
  code: ImportConflictCode;
  severity: "error" | "warning";
  path: string;
  field?: string;
  message: string;
};

export type ImportRename = {
  path: string;
  from: string;
  to: string;
  reason: "canonical-path" | "frontmatter-slug" | "metadata-slug";
};

export type ImportUnknownField = {
  path: string;
  field: string;
  scope: "configuration" | "frontmatter";
};

export type ImportSkippedContent = {
  path: string;
  reason:
    | "configuration-file"
    | "duplicate-asset"
    | "external-summary-link"
    | "outside-content-root"
    | "summary-file"
    | "unlisted-markdown"
    | "unreferenced-asset"
    | "unsupported-file";
};

export type ImportChange = {
  path: string;
  kind: "demoted-heading" | "inserted-title";
  line?: number;
  message: string;
};

export type ImportReport = {
  dryRun: {
    sourceFiles: number;
    contentRoot: string;
    summaryPath: string | null;
  };
  renames: ImportRename[];
  conflicts: ImportConflict[];
  unknownFields: ImportUnknownField[];
  skippedContent: ImportSkippedContent[];
  changes: ImportChange[];
  completion: {
    status: "blocked" | "complete" | "ready";
    categories: number;
    articles: number;
    assets: number;
    redirects: number;
  };
};

export function createImportReport(sourceFiles: number): ImportReport {
  return {
    dryRun: {
      sourceFiles,
      contentRoot: "",
      summaryPath: null,
    },
    renames: [],
    conflicts: [],
    unknownFields: [],
    skippedContent: [],
    changes: [],
    completion: {
      status: "blocked",
      categories: 0,
      articles: 0,
      assets: 0,
      redirects: 0,
    },
  };
}

export function reportHasErrors(report: ImportReport) {
  return report.conflicts.some((conflict) => conflict.severity === "error");
}

export function completedImportReport(report: ImportReport): ImportReport {
  return {
    ...report,
    completion: {
      ...report.completion,
      status: "complete",
    },
  };
}
