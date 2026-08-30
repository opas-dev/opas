// ABOUTME: Defines the shared Markdown syntax contract for article validation and output.
// ABOUTME: Keeps GFM parsing identical across preview, runtime compilation, and export.
import type { CompilerOptions } from "@fumadocs/mdx-remote";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Pluggable } from "unified";

type MarkdownNode = {
  children?: MarkdownNode[];
  depth?: number;
  type: string;
};

export const articleMdxRemarkPlugins: readonly Pluggable[] = [remarkGfm];

export async function createArticleMdxCompiler(
  additionalRemarkPlugins: readonly Pluggable[] = [],
) {
  const { createCompiler } = await import("@fumadocs/mdx-remote");

  return createCompiler({
    preset: "minimal",
    outputFormat: "function-body",
    remarkPlugins: [...articleMdxRemarkPlugins, ...additionalRemarkPlugins],
  } satisfies CompilerOptions);
}

export const articleMdxCompiler = createArticleMdxCompiler();

const articleMarkdownParser = unified()
  .use(remarkParse)
  .use([...articleMdxRemarkPlugins])
  .freeze();

export function parseArticleMarkdown(source: string) {
  return articleMarkdownParser.parse(source);
}

function collectHeadings(node: MarkdownNode, headings: MarkdownNode[]) {
  if (node.type === "heading") {
    headings.push(node);
  }

  for (const child of node.children ?? []) {
    collectHeadings(child, headings);
  }
}

function headingText(node: MarkdownNode) {
  return toString(node as Parameters<typeof toString>[0]).trim();
}

export function articleTitleHeadingIssue(source: string, title: string) {
  const tree = parseArticleMarkdown(source.replace(/^\uFEFF/u, "")) as MarkdownNode;
  const headings: MarkdownNode[] = [];
  collectHeadings(tree, headings);

  const levelOneHeadings = headings.filter((heading) => heading.depth === 1);
  if (levelOneHeadings.length !== 1) {
    return "Article MDX must contain exactly one level-one heading";
  }

  const titleHeading = levelOneHeadings[0];
  if (tree.children?.[0] !== titleHeading) {
    return "The level-one heading must be the first content block";
  }

  if (headingText(titleHeading) !== title.trim()) {
    return "The level-one heading must exactly match the article title";
  }

  return null;
}
