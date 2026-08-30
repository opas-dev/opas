// ABOUTME: Splits stored article MDX into its title-owned heading and Visual editor body.
// ABOUTME: Refuses syntax the bounded Visual grammar cannot round-trip without loss.
import { toMarkdown } from "mdast-util-to-markdown";

import {
  articleImageUrlIssue,
  articleLinkUrlIssue,
} from "@/content/article-url-policy";
import {
  articleTitleHeadingIssue,
  parseArticleMarkdown,
} from "@/content/runtime-mdx-plugins";

type MarkdownNode = {
  children?: MarkdownNode[];
  checked?: boolean | null;
  depth?: number;
  position?: {
    end?: { offset?: number };
    start?: { line?: number; offset?: number };
  };
  type: string;
  url?: string;
};

type VisualSourceResult =
  | { status: "ready"; body: string }
  | { status: "unsupported"; message: string };

const visualNodeTypes = new Set([
  "blockquote",
  "break",
  "code",
  "delete",
  "emphasis",
  "heading",
  "image",
  "inlineCode",
  "link",
  "list",
  "listItem",
  "paragraph",
  "root",
  "strong",
  "table",
  "tableCell",
  "tableRow",
  "text",
  "thematicBreak",
]);

const unsupportedNodeLabels: Record<string, string> = {
  definition: "reference-style links",
  footnoteDefinition: "footnotes",
  footnoteReference: "footnotes",
  html: "raw HTML",
  imageReference: "reference-style images",
  linkReference: "reference-style links",
  mdxFlowExpression: "MDX expressions",
  mdxJsxFlowElement: "MDX components",
  mdxJsxTextElement: "MDX components",
  mdxTextExpression: "MDX expressions",
  mdxjsEsm: "MDX imports or exports",
  toml: "frontmatter",
  yaml: "frontmatter",
};

function nodeLine(node: MarkdownNode) {
  return node.position?.start?.line ?? 1;
}

function unsupportedMessage(label: string, line: number) {
  return `Visual mode cannot represent ${label} at line ${line}.`;
}

function inspectVisualNode(node: MarkdownNode): string | null {
  const unsupportedLabel = unsupportedNodeLabels[node.type];
  if (unsupportedLabel) {
    return unsupportedMessage(unsupportedLabel, nodeLine(node));
  }

  if (!visualNodeTypes.has(node.type)) {
    return unsupportedMessage(`the ${node.type} Markdown construct`, nodeLine(node));
  }

  if (node.type === "heading" && node.depth === 1) {
    return unsupportedMessage("additional level-one headings", nodeLine(node));
  }

  if (node.type === "link" && typeof node.url === "string") {
    const issue = articleLinkUrlIssue(node.url);
    if (issue) {
      return `${issue.slice(0, -1)} The unsafe link is at line ${nodeLine(node)}.`;
    }
  }

  if (node.type === "image" && typeof node.url === "string") {
    const issue = articleImageUrlIssue(node.url);
    if (issue) {
      return `${issue.slice(0, -1)} The unsafe image is at line ${nodeLine(node)}.`;
    }
  }

  for (const child of node.children ?? []) {
    const issue = inspectVisualNode(child);
    if (issue) {
      return issue;
    }
  }

  return null;
}

function rawSyntaxIssue(source: string, tree: MarkdownNode) {
  const ignoredRanges: Array<{ start: number; end: number }> = [];

  function collectIgnoredRanges(node: MarkdownNode) {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        ignoredRanges.push({ start, end });
      }
      return;
    }

    for (const child of node.children ?? []) {
      collectIgnoredRanges(child);
    }
  }

  collectIgnoredRanges(tree);

  function isIgnored(offset: number) {
    return ignoredRanges.some((range) => offset >= range.start && offset < range.end);
  }

  let lineOffset = 0;
  let lineNumber = 1;

  while (lineOffset <= source.length) {
    const lineBreak = /\r\n?|\n/u.exec(source.slice(lineOffset));
    const lineEnd = lineBreak ? lineOffset + lineBreak.index : source.length;
    const line = source.slice(lineOffset, lineEnd);
    const firstContentOffset = line.search(/\S/u);
    const contentOffset = firstContentOffset === -1 ? lineOffset : lineOffset + firstContentOffset;

    if (
      firstContentOffset !== -1 &&
      !isIgnored(contentOffset) &&
      /^(?:import|export)(?:\s|\{|$)/u.test(line.slice(firstContentOffset))
    ) {
      return unsupportedMessage("MDX imports or exports", lineNumber);
    }

    for (let column = 0; column < line.length; column += 1) {
      const offset = lineOffset + column;
      if (isIgnored(offset)) {
        continue;
      }

      const character = line[column];
      let precedingSlashes = 0;
      for (let slash = column - 1; slash >= 0 && line[slash] === "\\"; slash -= 1) {
        precedingSlashes += 1;
      }
      const escaped = precedingSlashes % 2 === 1;

      if (character === "{" && !escaped) {
        return unsupportedMessage("MDX expressions", lineNumber);
      }

      if (character === "=" && line[column + 1] === "=" && !escaped) {
        return unsupportedMessage("highlight formatting", lineNumber);
      }
    }

    if (!lineBreak) {
      break;
    }
    lineOffset = lineEnd + lineBreak[0].length;
    lineNumber += 1;
  }

  return null;
}

export function serializeArticleTitle(title: string) {
  return toMarkdown({
    type: "root",
    children: [
      {
        type: "heading",
        depth: 1,
        children: [{ type: "text", value: title.trim() }],
      },
    ],
  }).trimEnd();
}

export function splitArticleSource(source: string): VisualSourceResult {
  const parsedSource = source.replace(/^\uFEFF/u, "");
  const tree = parseArticleMarkdown(parsedSource) as MarkdownNode;
  const firstChild = tree.children?.[0];
  const headingEnd = firstChild?.position?.end?.offset;

  if (firstChild?.type !== "heading" || firstChild.depth !== 1 || typeof headingEnd !== "number") {
    return {
      status: "unsupported",
      message: "Visual mode is unavailable because the level-one title must be the first content block.",
    };
  }

  const levelOneHeadings: MarkdownNode[] = [];
  function collectLevelOneHeadings(node: MarkdownNode) {
    if (node.type === "heading" && node.depth === 1) {
      levelOneHeadings.push(node);
    }
    for (const child of node.children ?? []) {
      collectLevelOneHeadings(child);
    }
  }
  collectLevelOneHeadings(tree);

  if (levelOneHeadings.length !== 1) {
    return {
      status: "unsupported",
      message:
        "Visual mode is unavailable because the article must contain exactly one level-one heading.",
    };
  }

  const body = parsedSource.slice(headingEnd).replace(/^(?:[ \t]*\r?\n)+/u, "");
  const issue = articleVisualBodyIssue(body);

  return issue ? { status: "unsupported", message: issue } : { status: "ready", body };
}

export function inspectArticleVisualSource(source: string, title: string): VisualSourceResult {
  const headingIssue = articleTitleHeadingIssue(source, title);
  if (headingIssue) {
    if (headingIssue === "Article MDX must contain exactly one level-one heading") {
      return {
        status: "unsupported",
        message:
          "Visual mode is unavailable because the article must contain exactly one level-one heading.",
      };
    }
    if (headingIssue === "The level-one heading must be the first content block") {
      return {
        status: "unsupported",
        message:
          "Visual mode is unavailable because the level-one title must be the first content block.",
      };
    }
    return {
      status: "unsupported",
      message: "Visual mode is unavailable because the level-one heading must match the title field.",
    };
  }

  return splitArticleSource(source);
}

export function articleVisualBodyIssue(body: string) {
  const tree = parseArticleMarkdown(body) as MarkdownNode;
  return rawSyntaxIssue(body, tree) ?? inspectVisualNode(tree);
}

export function joinArticleSource(title: string, body: string) {
  const heading = serializeArticleTitle(title);
  const content = body.replace(/^(?:[ \t]*\r?\n)+/u, "");

  return content ? `${heading}\n\n${content}` : `${heading}\n`;
}

export function replaceArticleTitleHeading(source: string, title: string) {
  const parsedSource = source.replace(/^\uFEFF/u, "");
  const tree = parseArticleMarkdown(parsedSource) as MarkdownNode;
  const firstChild = tree.children?.[0];
  const headingEnd = firstChild?.position?.end?.offset;

  if (firstChild?.type !== "heading" || firstChild.depth !== 1 || typeof headingEnd !== "number") {
    return source;
  }

  let levelOneHeadingCount = 0;
  function countLevelOneHeadings(node: MarkdownNode) {
    if (node.type === "heading" && node.depth === 1) {
      levelOneHeadingCount += 1;
    }
    for (const child of node.children ?? []) {
      countLevelOneHeadings(child);
    }
  }
  countLevelOneHeadings(tree);

  if (levelOneHeadingCount !== 1) {
    return source;
  }

  return joinArticleSource(title, parsedSource.slice(headingEnd));
}
