// ABOUTME: Compares immutable article snapshots as bounded metadata and source rows.
// ABOUTME: Renders every author-controlled line as escaped React text with non-color labels.

import type { ArticleRevisionDetail } from "@/db/article-drafts";

export type ArticleSourceDiffLine =
  | Readonly<{
      kind: "unchanged";
      beforeLineNumber: number;
      afterLineNumber: number;
      text: string;
    }>
  | Readonly<{
      kind: "added";
      afterLineNumber: number;
      text: string;
    }>
  | Readonly<{
      kind: "removed";
      beforeLineNumber: number;
      text: string;
    }>
  | Readonly<{
      kind: "changed";
      beforeLineNumber: number;
      afterLineNumber: number;
      beforeText: string;
      afterText: string;
    }>;

type AtomicDiffLine = Exclude<ArticleSourceDiffLine, { kind: "changed" }>;

const maximumComparisonCells = 2_000_000;

function alignChangedLines(lines: readonly AtomicDiffLine[]) {
  const result: ArticleSourceDiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "unchanged") {
      result.push(line);
      index += 1;
      continue;
    }

    const removed: Extract<AtomicDiffLine, { kind: "removed" }>[] = [];
    const added: Extract<AtomicDiffLine, { kind: "added" }>[] = [];
    while (index < lines.length && lines[index]!.kind !== "unchanged") {
      const changed = lines[index]!;
      if (changed.kind === "removed") removed.push(changed);
      if (changed.kind === "added") added.push(changed);
      index += 1;
    }
    const paired = Math.min(removed.length, added.length);
    for (let pair = 0; pair < paired; pair += 1) {
      result.push({
        kind: "changed",
        beforeLineNumber: removed[pair]!.beforeLineNumber,
        afterLineNumber: added[pair]!.afterLineNumber,
        beforeText: removed[pair]!.text,
        afterText: added[pair]!.text,
      });
    }
    result.push(...removed.slice(paired), ...added.slice(paired));
  }
  return result;
}

function simpleLineDiff(before: readonly string[], after: readonly string[]) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: ArticleSourceDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({
      kind: "unchanged",
      beforeLineNumber: index + 1,
      afterLineNumber: index + 1,
      text: before[index]!,
    });
  }
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  const paired = Math.min(beforeMiddle.length, afterMiddle.length);
  for (let index = 0; index < paired; index += 1) {
    rows.push({
      kind: "changed",
      beforeLineNumber: prefix + index + 1,
      afterLineNumber: prefix + index + 1,
      beforeText: beforeMiddle[index]!,
      afterText: afterMiddle[index]!,
    });
  }
  for (let index = paired; index < beforeMiddle.length; index += 1) {
    rows.push({
      kind: "removed",
      beforeLineNumber: prefix + index + 1,
      text: beforeMiddle[index]!,
    });
  }
  for (let index = paired; index < afterMiddle.length; index += 1) {
    rows.push({
      kind: "added",
      afterLineNumber: prefix + index + 1,
      text: afterMiddle[index]!,
    });
  }
  for (let index = suffix; index > 0; index -= 1) {
    const beforeIndex = before.length - index;
    const afterIndex = after.length - index;
    rows.push({
      kind: "unchanged",
      beforeLineNumber: beforeIndex + 1,
      afterLineNumber: afterIndex + 1,
      text: before[beforeIndex]!,
    });
  }
  return rows;
}

export function compareArticleSource(beforeSource: string, afterSource: string) {
  const before = beforeSource === "" ? [] : beforeSource.split("\n");
  const after = afterSource === "" ? [] : afterSource.split("\n");
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > maximumComparisonCells) {
    return simpleLineDiff(before, after);
  }

  const matrix = new Uint32Array(cells);
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const offset = beforeIndex * width + afterIndex;
      matrix[offset] =
        before[beforeIndex] === after[afterIndex]
          ? matrix[(beforeIndex + 1) * width + afterIndex + 1]! + 1
          : Math.max(
              matrix[(beforeIndex + 1) * width + afterIndex]!,
              matrix[beforeIndex * width + afterIndex + 1]!,
            );
    }
  }

  const rows: AtomicDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      rows.push({
        kind: "unchanged",
        beforeLineNumber: beforeIndex + 1,
        afterLineNumber: afterIndex + 1,
        text: before[beforeIndex]!,
      });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      matrix[(beforeIndex + 1) * width + afterIndex]! >=
      matrix[beforeIndex * width + afterIndex + 1]!
    ) {
      rows.push({
        kind: "removed",
        beforeLineNumber: beforeIndex + 1,
        text: before[beforeIndex]!,
      });
      beforeIndex += 1;
    } else {
      rows.push({
        kind: "added",
        afterLineNumber: afterIndex + 1,
        text: after[afterIndex]!,
      });
      afterIndex += 1;
    }
  }
  while (beforeIndex < before.length) {
    rows.push({
      kind: "removed",
      beforeLineNumber: beforeIndex + 1,
      text: before[beforeIndex]!,
    });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    rows.push({
      kind: "added",
      afterLineNumber: afterIndex + 1,
      text: after[afterIndex]!,
    });
    afterIndex += 1;
  }
  return alignChangedLines(rows);
}

export type ArticleMetadataChange = Readonly<{
  after: string;
  before: string;
  label: string;
}>;

export function compareArticleMetadata(
  before: ArticleRevisionDetail | null,
  after: ArticleRevisionDetail,
) {
  if (!before) return [];
  const values = [
    ["Title", before.article.title, after.article.title],
    ["URL slug", before.article.slug, after.article.slug],
    ["Category", before.categoryName, after.categoryName],
    ["Category path", before.categorySlug, after.categorySlug],
    ["Author", before.article.authorName, after.article.authorName],
    ["FAQ structured data", before.article.isFaq ? "Enabled" : "Disabled", after.article.isFaq ? "Enabled" : "Disabled"],
    ["Position", String(before.article.position), String(after.article.position)],
    ["Retained images", before.assetHashes.join(", ") || "None", after.assetHashes.join(", ") || "None"],
  ] as const;
  return values.flatMap(([label, previous, current]) =>
    previous === current ? [] : [{ label, before: previous, after: current }],
  );
}

function lineStyle(kind: ArticleSourceDiffLine["kind"]) {
  return kind === "unchanged"
    ? "bg-code-background text-code-foreground"
    : kind === "added"
      ? "bg-success/10 text-foreground"
      : kind === "removed"
        ? "bg-danger/10 text-foreground"
        : "bg-warning/10 text-foreground";
}

export function ArticleSourceDiff({
  after,
  before,
}: Readonly<{ after: string; before: string }>) {
  const lines = compareArticleSource(before, after);
  return (
    <ol
      aria-label="Line-by-line source comparison"
      className="m-0 min-w-full list-none p-0 font-mono text-xs leading-5"
    >
      {lines.map((line, index) => (
        <li
          className={`grid min-w-[42rem] grid-cols-[6.5rem_3rem_3rem_minmax(0,1fr)] border-b border-border last:border-b-0 ${lineStyle(line.kind)}`}
          key={`${line.kind}-${index}`}
        >
          <span className="border-r border-border px-3 py-2 font-sans text-xs font-semibold">
            {line.kind === "unchanged"
              ? "Unchanged"
              : line.kind === "added"
                ? "+ Added"
                : line.kind === "removed"
                  ? "− Removed"
                  : "± Changed"}
          </span>
          {line.kind === "changed" ? (
            <>
              <span className="border-r border-border px-2 py-2 text-right text-muted tabular-nums">
                {line.beforeLineNumber}
              </span>
              <span className="border-r border-border px-2 py-2 text-right text-muted tabular-nums">
                {line.afterLineNumber}
              </span>
              <span className="min-w-0 px-3 py-2">
                <span className="block whitespace-pre-wrap break-words">
                  <span className="font-sans font-semibold">Before: </span>
                  <code>{line.beforeText || " "}</code>
                </span>
                <span className="mt-1 block whitespace-pre-wrap break-words">
                  <span className="font-sans font-semibold">After: </span>
                  <code>{line.afterText || " "}</code>
                </span>
              </span>
            </>
          ) : (
            <>
              <span className="border-r border-border px-2 py-2 text-right text-muted tabular-nums">
                {line.kind === "added" ? "" : line.beforeLineNumber}
              </span>
              <span className="border-r border-border px-2 py-2 text-right text-muted tabular-nums">
                {line.kind === "removed" ? "" : line.afterLineNumber}
              </span>
              <code className="min-w-0 whitespace-pre-wrap break-words px-3 py-2">
                {line.text || " "}
              </code>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
