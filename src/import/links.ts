// ABOUTME: Rewrites parsed local Markdown links and images to canonical OPAS URLs.
// ABOUTME: Preserves untouched source syntax while reporting unsafe or missing targets.
import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

export type ResolvedImportTarget =
  | { status: "resolved"; canonicalUrl: string }
  | { status: "missing"; message: string }
  | { status: "unsafe"; message: string };

export type LinkRewriteIssue = {
  code: "missing-link-target" | "unsafe-link-target";
  line: number;
  message: string;
};

export type LinkRewriteResult = {
  markdown: string;
  issues: LinkRewriteIssue[];
};

type TargetResolver = (target: string) => ResolvedImportTarget;

type MarkdownNode = {
  children?: MarkdownNode[];
  identifier?: string;
  position?: {
    start?: { line?: number; offset?: number };
    end?: { offset?: number };
  };
  type: string;
  url?: string;
};

type Replacement = {
  end: number;
  start: number;
  value: string;
};

function normalizedIdentifier(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function splitTargetSuffix(target: string) {
  const queryOffset = target.indexOf("?");
  const fragmentOffset = target.indexOf("#");
  const offsets = [queryOffset, fragmentOffset].filter((offset) => offset >= 0);
  const suffixOffset = offsets.length > 0 ? Math.min(...offsets) : -1;

  return suffixOffset < 0
    ? { path: target, suffix: "" }
    : { path: target.slice(0, suffixOffset), suffix: target.slice(suffixOffset) };
}

function resolvedTarget(
  target: string,
  image: boolean,
  line: number,
  resolve: TargetResolver,
): { issue?: LinkRewriteIssue; replacement?: string } {
  if (target.startsWith("#")) {
    return {};
  }

  if (target.startsWith("//") || target.includes("\\") || target.includes("\u0000")) {
    return {
      issue: {
        code: "unsafe-link-target",
        line,
        message: `Unsafe Markdown target ${JSON.stringify(target)}.`,
      },
    };
  }

  const protocol = /^([a-z][a-z\d+.-]*):/iu.exec(target)?.[1].toLocaleLowerCase("en-US");
  if (protocol) {
    const allowed = image
      ? protocol === "https"
      : new Set(["http", "https", "mailto", "tel"]).has(protocol);
    return allowed
      ? {}
      : {
          issue: {
            code: "unsafe-link-target",
            line,
            message: `Markdown target protocol ${protocol}: is not allowed.`,
          },
        };
  }

  const { path, suffix } = splitTargetSuffix(target);
  if (!path) {
    return {};
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return {
      issue: {
        code: "unsafe-link-target",
        line,
        message: `Markdown target ${JSON.stringify(target)} is not valid percent-encoding.`,
      },
    };
  }

  const resolution = resolve(decodedPath);
  if (resolution.status === "resolved") {
    return { replacement: `${resolution.canonicalUrl}${suffix}` };
  }

  return {
    issue: {
      code:
        resolution.status === "missing"
          ? "missing-link-target"
          : "unsafe-link-target",
      line,
      message: resolution.message,
    },
  };
}

function matchingBracket(source: string, start: number, end: number) {
  let depth = 1;

  for (let offset = start + 1; offset < end; offset += 1) {
    if (source[offset] === "\\") {
      offset += 1;
    } else if (source[offset] === "[") {
      depth += 1;
    } else if (source[offset] === "]") {
      depth -= 1;
      if (depth === 0) {
        return offset;
      }
    }
  }

  return null;
}

function destinationRange(source: string, node: MarkdownNode) {
  const nodeStart = node.position?.start?.offset;
  const nodeEnd = node.position?.end?.offset;
  if (typeof nodeStart !== "number" || typeof nodeEnd !== "number") {
    return null;
  }

  const labelStart = node.type === "image" ? nodeStart + 1 : nodeStart;
  if (source[labelStart] !== "[") {
    return null;
  }

  const labelEnd = matchingBracket(source, labelStart, nodeEnd);
  if (labelEnd === null) {
    return null;
  }

  let offset = labelEnd + 1;
  while (offset < nodeEnd && /\s/u.test(source[offset])) {
    offset += 1;
  }

  if (node.type === "definition") {
    if (source[offset] !== ":") {
      return null;
    }
    offset += 1;
  } else if (source[offset] === "(") {
    offset += 1;
  } else {
    return null;
  }

  while (offset < nodeEnd && /\s/u.test(source[offset])) {
    offset += 1;
  }
  if (offset >= nodeEnd) {
    return null;
  }

  if (source[offset] === "<") {
    const start = offset + 1;
    for (let end = start; end < nodeEnd; end += 1) {
      if (source[end] === "\\") {
        end += 1;
      } else if (source[end] === ">") {
        return { start, end };
      }
    }
    return null;
  }

  const start = offset;
  let parentheses = 0;
  for (; offset < nodeEnd; offset += 1) {
    const character = source[offset];
    if (character === "\\") {
      offset += 1;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
      continue;
    }
    if (character === ")") {
      if (parentheses === 0) {
        return { start, end: offset };
      }
      parentheses -= 1;
      continue;
    }
    if (/\s/u.test(character) && parentheses === 0) {
      return { start, end: offset };
    }
  }

  return start < offset ? { start, end: offset } : null;
}

export function rewriteMarkdownLinks(
  source: string,
  resolve: TargetResolver,
): LinkRewriteResult {
  const markdown = source.replace(/\r\n?/gu, "\n");
  const tree = parseArticleMarkdown(markdown) as MarkdownNode;
  const imageDefinitions = new Set<string>();
  const targetNodes: MarkdownNode[] = [];

  function visit(node: MarkdownNode) {
    if (node.type === "imageReference" && typeof node.identifier === "string") {
      imageDefinitions.add(normalizedIdentifier(node.identifier));
    }
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition") &&
      typeof node.url === "string"
    ) {
      targetNodes.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }
  visit(tree);

  const issues: LinkRewriteIssue[] = [];
  const replacements: Replacement[] = [];
  for (const node of targetNodes) {
    const line = node.position?.start?.line ?? 1;
    const isImage =
      node.type === "image" ||
      (node.type === "definition" &&
        typeof node.identifier === "string" &&
        imageDefinitions.has(normalizedIdentifier(node.identifier)));
    const result = resolvedTarget(node.url!, isImage, line, resolve);
    if (result.issue) {
      issues.push(result.issue);
    }
    if (!result.replacement) {
      continue;
    }

    const range = destinationRange(markdown, node);
    if (!range) {
      issues.push({
        code: "missing-link-target",
        line,
        message: `Local target ${JSON.stringify(node.url)} could not be rewritten without changing surrounding Markdown.`,
      });
      continue;
    }
    replacements.push({ ...range, value: result.replacement });
  }

  replacements.sort((left, right) => right.start - left.start);
  let output = markdown;
  for (const replacement of replacements) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }

  return { markdown: output, issues };
}
