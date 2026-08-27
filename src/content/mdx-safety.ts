// ABOUTME: Validates database-backed article MDX before its generated code can execute.
// ABOUTME: Rejects executable syntax, unsafe URLs, and unregistered components.

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
const linkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const imageProtocols = new Set(["http:", "https:"]);

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

function hasAllowedProtocol(value: string, protocols: ReadonlySet<string>) {
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  const protocolMatch = /^([a-z][a-z\d+.-]*:)/i.exec(normalized);

  return protocolMatch === null || protocols.has(protocolMatch[1].toLowerCase());
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

  if (node.type === "link" && typeof node.url === "string" && !hasAllowedProtocol(node.url, linkProtocols)) {
    rejectMdx("This link protocol is not allowed in article MDX", node);
  }

  if (
    (node.type === "image" || node.type === "definition") &&
    typeof node.url === "string" &&
    !hasAllowedProtocol(node.url, imageProtocols)
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

const validationCompiler = import("@fumadocs/mdx-remote").then(({ createCompiler }) =>
  createCompiler({
    preset: "minimal",
    outputFormat: "function-body",
    remarkPlugins: [protectArticleMdx],
  }),
);

export async function validateArticleMdx(source: string) {
  try {
    if (/^\uFEFF?[ \t]*---(?:\r?\n|$)/.test(source)) {
      throw new ArticleMdxValidationError(
        "Frontmatter is not allowed; article metadata belongs in the editor fields",
      );
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
