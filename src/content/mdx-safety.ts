// ABOUTME: Validates database-backed article MDX before its generated code can execute.
// ABOUTME: Rejects executable syntax, unsafe URLs, and unregistered components.
import type { Pluggable } from "unified";

import {
  articleImageUrlIssue,
  articleLinkUrlIssue,
} from "@/content/article-url-policy";
import {
  articleTitleHeadingIssue,
  createArticleMdxCompiler,
} from "@/content/runtime-mdx-plugins";

type MdxNode = {
  attributes?: unknown;
  children?: unknown;
  name?: unknown;
  position?: {
    start?: {
      column?: unknown;
      line?: unknown;
    };
  };
  type?: unknown;
  url?: unknown;
  value?: unknown;
};

const articleMdxComponentNames = new Set<string>();

export class ArticleMdxValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArticleMdxValidationError";
  }
}

function locationSuffix(node: MdxNode) {
  const line = node.position?.start?.line;
  const column = node.position?.start?.column;

  if (typeof line !== "number" || typeof column !== "number") {
    return "";
  }

  return ` at line ${line}, column ${column}`;
}

function rejectMdx(message: string, node: MdxNode): never {
  throw new ArticleMdxValidationError(`${message}${locationSuffix(node)}`);
}

function inspectAttributes(node: MdxNode) {
  if (!Array.isArray(node.attributes)) {
    return;
  }

  for (const attribute of node.attributes) {
    if (!attribute || typeof attribute !== "object") {
      continue;
    }

    const mdxAttribute = attribute as MdxNode;
    if (
      mdxAttribute.type === "mdxJsxExpressionAttribute" ||
      (mdxAttribute.type === "mdxJsxAttribute" &&
        typeof mdxAttribute.value === "object" &&
        mdxAttribute.value !== null)
    ) {
      rejectMdx("JavaScript component properties are not allowed in article MDX", mdxAttribute);
    }
  }
}

function inspectNode(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as MdxNode;

  if (node.type === "mdxjsEsm") {
    rejectMdx("Imports and exports are not allowed in article MDX", node);
  }

  if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
    rejectMdx("JavaScript expressions are not allowed in article MDX", node);
  }

  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    inspectAttributes(node);

    if (typeof node.name !== "string" || !articleMdxComponentNames.has(node.name)) {
      rejectMdx("This component is not allowed in article MDX", node);
    }
  }

  if (
    node.type === "link" &&
    typeof node.url === "string" &&
    articleLinkUrlIssue(node.url)
  ) {
    rejectMdx("This link protocol is not allowed in article MDX", node);
  }

  if (
    (node.type === "image" || node.type === "definition") &&
    typeof node.url === "string" &&
    articleImageUrlIssue(node.url)
  ) {
    rejectMdx("This image protocol is not allowed in article MDX", node);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      inspectNode(child);
    }
  }
}

function protectArticleMdx() {
  return (tree: unknown) => {
    inspectNode(tree);
  };
}

const validationCompiler = createArticleMdxCompiler([
  protectArticleMdx as Pluggable,
]);

export async function validateArticleMdx(source: string, title?: string) {
  try {
    if (/^\uFEFF?[ \t]*---(?:\r?\n|$)/.test(source)) {
      throw new ArticleMdxValidationError(
        "Frontmatter is not allowed; article metadata belongs in the editor fields",
      );
    }

    if (title !== undefined) {
      const headingIssue = articleTitleHeadingIssue(source, title);
      if (headingIssue) {
        throw new ArticleMdxValidationError(headingIssue);
      }
    }

    await (await validationCompiler).compileFile(source);
    return source;
  } catch (error) {
    if (error instanceof ArticleMdxValidationError) {
      throw error;
    }

    throw new ArticleMdxValidationError("Article MDX could not be parsed", {
      cause: error,
    });
  }
}
