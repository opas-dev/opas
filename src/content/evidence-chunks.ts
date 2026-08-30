// ABOUTME: Turns one validated published article into deterministic heading-aware evidence chunks.
// ABOUTME: Preserves source ranges while producing portable hashes and bounded embedding text.
import { toString } from "mdast-util-to-string";

import { validateArticleMdx } from "@/content/mdx-safety";
import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

export const evidenceEmbeddingMaximumUtf8Bytes = 384;

const evidenceMarkdownMaximumUtf8Bytes = 224;
const embeddingContextMaximumUtf8Bytes = 128;
const minimumSplitUtf8Bytes = 48;

type MarkdownPosition = {
  end?: {
    line?: number;
    offset?: number;
  };
  start?: {
    line?: number;
    offset?: number;
  };
};

type MarkdownNode = {
  alt?: string;
  children?: MarkdownNode[];
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  position?: MarkdownPosition;
  type: string;
  value?: string;
};

type HeadingEntry = {
  depth: number;
  text: string;
};

type Section = {
  headingPath: readonly string[];
  occurrence: number;
  nextChunkIndex: number;
};

type PendingChunk = {
  end: number;
  headingPath: readonly string[];
  markdown: string;
  sectionChunkIndex: number;
  sectionOccurrence: number;
  start: number;
};

type MarkdownFragment = {
  end: number;
  markdown?: string;
  start: number;
};

type CurrentChunk = {
  end: number;
  markdown?: string;
  section: Section;
  start: number;
};

export type PublishedEvidenceArticle = {
  canonicalUrl: string;
  id: string;
  mdx: string;
  status: "draft" | "published";
  title: string;
  workspaceId: string;
};

export type EvidenceChunk = {
  articleId: string;
  canonicalUrl: string;
  contentHash: string;
  embeddingText: string;
  evidenceText: string;
  headingPath: readonly string[];
  id: string;
  markdown: string;
  ordinal: number;
  sourceLineRange: {
    end: number;
    start: number;
  };
  title: string;
  workspaceId: string;
};

export class EvidenceChunkingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceChunkingError";
  }
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string) {
  return utf8Encoder.encode(value).byteLength;
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function markdownNodeText(node: MarkdownNode): string {
  if (node.type === "table") {
    return (node.children ?? []).map(markdownNodeText).filter(Boolean).join("\n");
  }

  if (node.type === "tableRow") {
    return (node.children ?? []).map(markdownNodeText).join(" | ");
  }

  if (node.type === "tableCell") {
    return collapseWhitespace(
      (node.children ?? []).map(markdownNodeText).join(" "),
    );
  }

  if (node.type === "list") {
    return (node.children ?? []).map(markdownNodeText).filter(Boolean).join("\n");
  }

  if (node.type === "listItem" || node.type === "blockquote") {
    return (node.children ?? []).map(markdownNodeText).filter(Boolean).join("\n");
  }

  if (node.type === "code" || node.type === "inlineCode" || node.type === "text") {
    return node.value ?? "";
  }

  if (node.type === "image") {
    return node.alt ?? "";
  }

  if (node.type === "thematicBreak" || node.type === "definition") {
    return "";
  }

  return toString(node as Parameters<typeof toString>[0]);
}

function evidenceText(markdown: string) {
  const tree = parseArticleMarkdown(markdown) as MarkdownNode;
  const lines = (tree.children ?? [])
    .map(markdownNodeText)
    .flatMap((value) => value.replace(/\r\n?/gu, "\n").split("\n"))
    .map(collapseWhitespace)
    .filter(Boolean);

  return lines.join("\n");
}

function containsOnlyASectionHeading(markdown: string) {
  const tree = parseArticleMarkdown(markdown) as MarkdownNode;
  const children = tree.children ?? [];

  return (
    children.length === 1 &&
    children[0]?.type === "heading" &&
    typeof children[0].depth === "number" &&
    children[0].depth >= 2
  );
}

function truncateUtf8(value: string, maximumBytes: number) {
  if (utf8ByteLength(value) <= maximumBytes) {
    return value;
  }

  let bytes = 0;
  let result = "";

  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) {
      break;
    }

    bytes += characterBytes;
    result += character;
  }

  return result.trimEnd();
}

function embeddingText(
  title: string,
  headingPath: readonly string[],
  plainText: string,
) {
  const context = truncateUtf8(
    [title, ...headingPath].map(collapseWhitespace).filter(Boolean).join(" > "),
    embeddingContextMaximumUtf8Bytes,
  );
  const availableEvidenceBytes =
    evidenceEmbeddingMaximumUtf8Bytes - utf8ByteLength(context) - 2;
  const boundedEvidence = truncateUtf8(plainText, availableEvidenceBytes);

  return context ? `${context}\n\n${boundedEvidence}`.trimEnd() : boundedEvidence;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encoder.encode(value));

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new EvidenceChunkingError("Evidence chunks require an absolute canonical URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EvidenceChunkingError(
      "Evidence chunks require a canonical HTTP(S) URL without credentials, query, or fragment",
    );
  }

  return url.toString();
}

function offsetWithinUtf8Budget(source: string, start: number, maximumBytes: number) {
  let bytes = 0;
  let offset = start;

  for (const character of source.slice(start)) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) {
      break;
    }

    bytes += characterBytes;
    offset += character.length;
  }

  return offset;
}

function trimEndOffset(source: string, start: number, end: number) {
  const trailingWhitespace = source.slice(start, end).match(/\s+$/u)?.[0];
  return trailingWhitespace ? end - trailingWhitespace.length : end;
}

function skipWhitespace(source: string, start: number, end: number) {
  let offset = start;

  while (offset < end) {
    const codePoint = source.codePointAt(offset);
    if (codePoint === undefined) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    if (!/^\s$/u.test(character)) {
      break;
    }

    offset += character.length;
  }

  return offset;
}

function finalBoundary(
  source: string,
  start: number,
  maximumEnd: number,
  pattern: RegExp,
) {
  const candidate = source.slice(start, maximumEnd);
  let boundary: { contentEnd: number; nextStart: number } | null = null;

  for (const match of candidate.matchAll(pattern)) {
    const matchIndex = match.index;
    if (matchIndex === undefined) {
      continue;
    }

    const matchStart = start + matchIndex;
    const matchEnd = matchStart + match[0].length;
    const contentEnd = trimEndOffset(source, start, matchEnd);

    if (utf8ByteLength(source.slice(start, contentEnd)) >= minimumSplitUtf8Bytes) {
      boundary = { contentEnd, nextStart: matchEnd };
    }
  }

  return boundary;
}

function splitBoundary(source: string, start: number, maximumEnd: number) {
  const sentenceBoundary = finalBoundary(
    source,
    start,
    maximumEnd,
    /[.!?。！？]["')\]}»”’]*\s+/gu,
  );
  if (sentenceBoundary) {
    return sentenceBoundary;
  }

  const wordBoundary = finalBoundary(source, start, maximumEnd, /\s+/gu);
  if (wordBoundary) {
    return wordBoundary;
  }

  return {
    contentEnd: maximumEnd,
    nextStart: maximumEnd,
  };
}

function splitRawTextRange(source: string, start: number, end: number) {
  const fragments: MarkdownFragment[] = [];
  let cursor = start;

  while (cursor < end) {
    const maximumEnd = offsetWithinUtf8Budget(
      source,
      cursor,
      evidenceMarkdownMaximumUtf8Bytes,
    );

    if (end <= maximumEnd) {
      const contentEnd = trimEndOffset(source, cursor, end);
      if (contentEnd > cursor) {
        fragments.push({ start: cursor, end: contentEnd });
      }
      break;
    }

    const boundary = splitBoundary(source, cursor, maximumEnd);
    if (boundary.contentEnd <= cursor) {
      throw new EvidenceChunkingError("Markdown could not be split at a UTF-8 boundary");
    }

    fragments.push({ start: cursor, end: boundary.contentEnd });
    cursor = skipWhitespace(source, boundary.nextStart, end);
  }

  return fragments;
}

function lineStarts(source: string) {
  const starts = [0];

  for (const match of source.matchAll(/\r\n|\r|\n/gu)) {
    const matchIndex = match.index;
    if (matchIndex !== undefined) {
      starts.push(matchIndex + match[0].length);
    }
  }

  return starts;
}

function lineAtOffset(starts: readonly number[], offset: number) {
  let low = 0;
  let high = starts.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function nodeOffsets(node: MarkdownNode) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;

  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    throw new EvidenceChunkingError("Validated Markdown is missing source positions");
  }

  return { end, start };
}

function paragraphFragments(source: string, node: MarkdownNode) {
  const { start, end } = nodeOffsets(node);
  const inlineFragments = (node.children ?? []).flatMap((child) => {
    const offsets = nodeOffsets(child);

    if (
      child.type === "text" &&
      utf8ByteLength(source.slice(offsets.start, offsets.end)) >
        evidenceMarkdownMaximumUtf8Bytes
    ) {
      return splitRawTextRange(source, offsets.start, offsets.end);
    }

    return [offsets];
  });

  if (inlineFragments.length === 0) {
    return [{ start, end }];
  }

  const fragments: MarkdownFragment[] = [];
  let currentStart = inlineFragments[0]?.start ?? start;
  let currentEnd = currentStart;

  for (const fragment of inlineFragments) {
    if (
      currentEnd > currentStart &&
      utf8ByteLength(source.slice(currentStart, fragment.end)) >
        evidenceMarkdownMaximumUtf8Bytes
    ) {
      fragments.push({ start: currentStart, end: currentEnd });
      currentStart = fragment.start;
    }

    currentEnd = fragment.end;
  }

  if (currentEnd > currentStart) {
    fragments.push({ start: currentStart, end: currentEnd });
  }

  return fragments;
}

function longestCharacterRun(value: string, character: "`" | "~") {
  let longest = 0;
  let current = 0;

  for (const candidate of value) {
    if (candidate === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function codeFence(node: MarkdownNode) {
  const information = [node.lang, node.meta].filter(Boolean).join(" ");
  const character = information.includes("`") ? "~" : "`";
  return character.repeat(
    Math.max(3, longestCharacterRun(node.value ?? "", character) + 1),
  );
}

function codeMarkdown(node: MarkdownNode, value: string, fence: string) {
  const information = [node.lang, node.meta].filter(Boolean).join(" ");
  const closingLineBreak = value.endsWith("\n") ? "" : "\n";

  return `${fence}${information}\n${value}${closingLineBreak}${fence}`;
}

function splitCodeValue(value: string, maximumBytes: number) {
  const fragments: string[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const maximumEnd = offsetWithinUtf8Budget(value, cursor, maximumBytes);
    if (maximumEnd >= value.length) {
      fragments.push(value.slice(cursor));
      break;
    }

    const candidate = value.slice(cursor, maximumEnd);
    const finalLineBreak = candidate.lastIndexOf("\n");
    const end = finalLineBreak >= 0 ? cursor + finalLineBreak + 1 : maximumEnd;

    if (end <= cursor) {
      throw new EvidenceChunkingError("Code could not be split at a UTF-8 boundary");
    }

    fragments.push(value.slice(cursor, end));
    cursor = end;
  }

  return fragments;
}

function codeFragments(source: string, node: MarkdownNode) {
  const { start, end } = nodeOffsets(node);
  const original = source.slice(start, end);
  if (utf8ByteLength(original) <= evidenceMarkdownMaximumUtf8Bytes) {
    return [{ start, end }];
  }

  const fence = codeFence(node);
  const emptyMarkdown = codeMarkdown(node, "", fence);
  const availableBytes =
    evidenceMarkdownMaximumUtf8Bytes - utf8ByteLength(emptyMarkdown);

  if (availableBytes <= 0 || !(node.value ?? "")) {
    return [{ start, end }];
  }

  return splitCodeValue(node.value ?? "", availableBytes).map((value) => ({
    start,
    end,
    markdown: codeMarkdown(node, value, fence),
  }));
}

function listFragments(source: string, node: MarkdownNode) {
  const { start, end } = nodeOffsets(node);
  const items = node.children ?? [];
  if (
    utf8ByteLength(source.slice(start, end)) <=
      evidenceMarkdownMaximumUtf8Bytes ||
    items.length < 2
  ) {
    return [{ start, end }];
  }

  const fragments: MarkdownFragment[] = [];
  let current = nodeOffsets(items[0] as MarkdownNode);

  for (const item of items.slice(1)) {
    const offsets = nodeOffsets(item);
    if (
      utf8ByteLength(source.slice(current.start, offsets.end)) >
        evidenceMarkdownMaximumUtf8Bytes
    ) {
      fragments.push(current);
      current = offsets;
    } else {
      current.end = offsets.end;
    }
  }

  fragments.push(current);
  return fragments;
}

function tableFragments(source: string, node: MarkdownNode) {
  const { start, end } = nodeOffsets(node);
  const [header, ...rows] = node.children ?? [];
  if (
    utf8ByteLength(source.slice(start, end)) <=
      evidenceMarkdownMaximumUtf8Bytes ||
    !header ||
    rows.length === 0
  ) {
    return [{ start, end }];
  }

  const headerOffsets = nodeOffsets(header);
  const firstRowOffsets = nodeOffsets(rows[0] as MarkdownNode);
  const separator = source
    .slice(headerOffsets.end, firstRowOffsets.start)
    .trim();
  if (!separator) {
    return [{ start, end }];
  }

  const prefix = `${source.slice(headerOffsets.start, headerOffsets.end)}\n${separator}`;
  const fragments: MarkdownFragment[] = [];
  let current = firstRowOffsets;

  function markdown(range: { start: number; end: number }) {
    return `${prefix}\n${source.slice(range.start, range.end)}`;
  }

  for (const row of rows.slice(1)) {
    const offsets = nodeOffsets(row);
    const candidate = { start: current.start, end: offsets.end };

    if (
      utf8ByteLength(markdown(candidate)) > evidenceMarkdownMaximumUtf8Bytes
    ) {
      fragments.push({ ...current, markdown: markdown(current) });
      current = offsets;
    } else {
      current.end = offsets.end;
    }
  }

  fragments.push({ ...current, markdown: markdown(current) });
  return fragments;
}

function nodeFragments(source: string, node: MarkdownNode) {
  const { start, end } = nodeOffsets(node);
  if (
    utf8ByteLength(source.slice(start, end)) <= evidenceMarkdownMaximumUtf8Bytes
  ) {
    return [{ start, end }];
  }

  if (node.type === "paragraph") {
    return paragraphFragments(source, node);
  }

  if (node.type === "code") {
    return codeFragments(source, node);
  }

  if (node.type === "list") {
    return listFragments(source, node);
  }

  if (node.type === "table") {
    return tableFragments(source, node);
  }

  return [{ start, end }];
}

function sectionOccurrence(
  headingPath: readonly string[],
  occurrences: Map<string, number>,
) {
  const key = JSON.stringify(headingPath);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);

  return occurrence;
}

function buildPendingChunks(source: string, tree: MarkdownNode) {
  const pending: PendingChunk[] = [];
  const headingStack: HeadingEntry[] = [];
  const occurrences = new Map<string, number>();
  let section: Section = {
    headingPath: [],
    occurrence: sectionOccurrence([], occurrences),
    nextChunkIndex: 0,
  };
  let current: CurrentChunk | null = null;

  function flush() {
    if (!current) {
      return;
    }

    pending.push({
      start: current.start,
      end: current.end,
      headingPath: current.section.headingPath,
      markdown: current.markdown ?? source.slice(current.start, current.end),
      sectionOccurrence: current.section.occurrence,
      sectionChunkIndex: current.section.nextChunkIndex,
    });
    current.section.nextChunkIndex += 1;
    current = null;
  }

  function appendFragment(fragment: MarkdownFragment) {
    if (current && current.section !== section) {
      flush();
    }

    const fragmentMarkdown =
      fragment.markdown ?? source.slice(fragment.start, fragment.end);

    if (current) {
      const currentMarkdown =
        current.markdown ?? source.slice(current.start, current.end);
      const combinedMarkdown =
        current.markdown === undefined && fragment.markdown === undefined
          ? source.slice(current.start, fragment.end)
          : `${currentMarkdown}\n\n${fragmentMarkdown}`;

      if (
        utf8ByteLength(combinedMarkdown) <= evidenceMarkdownMaximumUtf8Bytes
      ) {
        current.end = fragment.end;
        current.markdown =
          current.markdown === undefined && fragment.markdown === undefined
            ? undefined
            : combinedMarkdown;
        return;
      }

      flush();
    }

    current = {
      start: fragment.start,
      end: fragment.end,
      markdown: fragment.markdown,
      section,
    };

    if (
      utf8ByteLength(fragmentMarkdown) > evidenceMarkdownMaximumUtf8Bytes
    ) {
      flush();
    }
  }

  for (const child of tree.children ?? []) {
    if (child.type === "heading" && child.depth === 1) {
      continue;
    }

    if (
      child.type === "heading" &&
      typeof child.depth === "number" &&
      child.depth >= 2 &&
      child.depth <= 6
    ) {
      flush();

      while (
        headingStack.length > 0 &&
        (headingStack.at(-1)?.depth ?? 0) >= child.depth
      ) {
        headingStack.pop();
      }

      headingStack.push({
        depth: child.depth,
        text: collapseWhitespace(toString(child as Parameters<typeof toString>[0])),
      });
      const headingPath = headingStack.map((heading) => heading.text);
      section = {
        headingPath,
        occurrence: sectionOccurrence(headingPath, occurrences),
        nextChunkIndex: 0,
      };
    }

    for (const fragment of nodeFragments(source, child)) {
      appendFragment(fragment);
    }
  }

  flush();
  return pending;
}

function validateArticleInput(article: PublishedEvidenceArticle) {
  if (article.status !== "published") {
    throw new EvidenceChunkingError("Only published articles can produce evidence chunks");
  }

  if (!article.workspaceId.trim() || !article.id.trim() || !article.title.trim()) {
    throw new EvidenceChunkingError(
      "Evidence chunks require workspace, article, and title metadata",
    );
  }
}

export async function chunkPublishedArticle(
  article: PublishedEvidenceArticle,
): Promise<EvidenceChunk[]> {
  validateArticleInput(article);
  const resolvedCanonicalUrl = canonicalUrl(article.canonicalUrl);
  await validateArticleMdx(article.mdx, article.title);

  const source = article.mdx.replace(/^\uFEFF/u, "");
  const tree = parseArticleMarkdown(source) as MarkdownNode;
  const starts = lineStarts(source);
  const pending = buildPendingChunks(source, tree);
  const chunks: EvidenceChunk[] = [];

  for (const candidate of pending) {
    const markdown = candidate.markdown;
    if (containsOnlyASectionHeading(markdown)) {
      continue;
    }

    const plainText = evidenceText(markdown);
    if (!plainText) {
      continue;
    }

    const providerText = embeddingText(article.title, candidate.headingPath, plainText);
    const contentHash = await sha256(
      JSON.stringify([
        article.title,
        candidate.headingPath,
        resolvedCanonicalUrl,
        markdown,
        plainText,
        providerText,
      ]),
    );
    const id = await sha256(
      JSON.stringify([
        "opas-evidence-chunk-v1",
        article.workspaceId,
        article.id,
        candidate.headingPath,
        candidate.sectionOccurrence,
        candidate.sectionChunkIndex,
      ]),
    );

    chunks.push({
      id,
      contentHash,
      ordinal: chunks.length,
      workspaceId: article.workspaceId,
      articleId: article.id,
      title: article.title,
      headingPath: candidate.headingPath,
      canonicalUrl: resolvedCanonicalUrl,
      markdown,
      evidenceText: plainText,
      embeddingText: providerText,
      sourceLineRange: {
        start: lineAtOffset(starts, candidate.start),
        end: lineAtOffset(starts, Math.max(candidate.start, candidate.end - 1)),
      },
    });
  }

  return chunks;
}
