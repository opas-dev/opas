// ABOUTME: Renders the assistant's deliberately small Markdown vocabulary as React elements.
// ABOUTME: Rejects HTML, links, images, headings, and every node outside the answer contract.
import { Fragment, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const maximumAnswerBlockUtf8Bytes = 8_192;
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const directionalControls = /[\u202a-\u202e\u2066-\u2069]/u;
const languagePattern = /^[a-z\d_+-]{1,32}$/iu;
const parser = unified().use(remarkParse).use(remarkGfm);

type MarkdownNode = {
  children?: MarkdownNode[];
  lang?: string | null;
  meta?: string | null;
  ordered?: boolean;
  type: string;
  value?: string;
};

const containerTypes = new Set([
  "emphasis",
  "list",
  "listItem",
  "paragraph",
  "root",
  "strong",
]);
const leafTypes = new Set(["code", "inlineCode", "text"]);

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function validateNode(node: MarkdownNode, root = false): void {
  if (!containerTypes.has(node.type) && !leafTypes.has(node.type)) {
    throw new Error("Answer contains unsupported Markdown");
  }
  if (root && (!Array.isArray(node.children) || node.children.length !== 1)) {
    throw new Error("Answer Markdown must contain one block");
  }
  if (containerTypes.has(node.type)) {
    if (!Array.isArray(node.children)) {
      throw new Error("Answer Markdown is malformed");
    }
    for (const child of node.children) validateNode(child);
  } else if (typeof node.value !== "string") {
    throw new Error("Answer Markdown is malformed");
  }
  if (
    node.type === "code" &&
    ((node.lang !== undefined &&
      node.lang !== null &&
      !languagePattern.test(node.lang)) ||
      (node.meta !== undefined && node.meta !== null))
  ) {
    throw new Error("Answer contains unsupported Markdown");
  }
}

export function validateAnswerMarkdown(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Answer Markdown must be text");
  }
  const markdown = value.replace(/\r\n?/gu, "\n").trim();
  if (
    !markdown ||
    utf8ByteLength(markdown) > maximumAnswerBlockUtf8Bytes ||
    forbiddenControls.test(markdown) ||
    directionalControls.test(markdown)
  ) {
    throw new Error("Answer contains unsupported Markdown");
  }
  const tree = parser.parse(markdown) as MarkdownNode;
  validateNode(tree, true);
  return { markdown, tree } as const;
}

function renderChildren(node: MarkdownNode, key: string) {
  return node.children?.map((child, index) =>
    renderNode(child, `${key}-${index}`),
  );
}

function renderNode(node: MarkdownNode, key: string): ReactNode {
  switch (node.type) {
    case "root":
      return <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    case "paragraph":
      return <p key={key}>{renderChildren(node, key)}</p>;
    case "list": {
      const children = renderChildren(node, key);
      return node.ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>;
    }
    case "listItem":
      return <li key={key}>{renderChildren(node, key)}</li>;
    case "strong":
      return <strong key={key}>{renderChildren(node, key)}</strong>;
    case "emphasis":
      return <em key={key}>{renderChildren(node, key)}</em>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case "text":
      return node.value;
    default:
      throw new Error("Answer contains unsupported Markdown");
  }
}

type AnswerMarkdownProps = Readonly<{ markdown: string }>;

export function AnswerMarkdown({ markdown }: AnswerMarkdownProps) {
  const validated = validateAnswerMarkdown(markdown);
  return <>{renderNode(validated.tree, "answer")}</>;
}
