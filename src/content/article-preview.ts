// ABOUTME: Prepares immutable revision Markdown for the private signed-preview surface.
// ABOUTME: Rewrites only stored OPAS asset references and discloses remote image hosts.

import { assetHashFromUrl } from "@/assets/identity";
import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

type MarkdownNode = Readonly<{
  children?: readonly MarkdownNode[];
  identifier?: string;
  position?: Readonly<{
    end?: Readonly<{ offset?: number }>;
    start?: Readonly<{ offset?: number }>;
  }>;
  type: string;
  url?: string;
}>;

type Replacement = Readonly<{
  end: number;
  replacement: string;
  start: number;
}>;

function normalizedIdentifier(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function walk(node: MarkdownNode, visit: (candidate: MarkdownNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function replacementForNode(source: string, node: MarkdownNode): Replacement | null {
  const hash = typeof node.url === "string" ? assetHashFromUrl(node.url) : null;
  if (!hash || !["definition", "image", "link"].includes(node.type)) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number)
  ) {
    throw new Error("PREVIEW_ASSET_POSITION_INVALID");
  }

  const excerpt = source.slice(start, end);
  const destinationBoundary = node.type === "definition"
    ? excerpt.indexOf("]:")
    : excerpt.indexOf("](");
  if (destinationBoundary < 0) throw new Error("PREVIEW_ASSET_REFERENCE_INVALID");
  const relativeStart = excerpt.indexOf(node.url as string, destinationBoundary + 2);
  if (relativeStart < 0) throw new Error("PREVIEW_ASSET_REFERENCE_INVALID");

  return {
    end: (start as number) + relativeStart + (node.url as string).length,
    replacement: `/preview/assets/${hash}`,
    start: (start as number) + relativeStart,
  };
}

export function rewriteArticlePreviewAssetUrls(source: string) {
  const tree = parseArticleMarkdown(source) as MarkdownNode;
  const replacements: Replacement[] = [];
  walk(tree, (node) => {
    const replacement = replacementForNode(source, node);
    if (replacement) replacements.push(replacement);
  });

  let rewritten = source;
  let precedingStart = source.length;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    if (replacement.end > precedingStart) throw new Error("PREVIEW_ASSET_REFERENCE_OVERLAP");
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.replacement}${rewritten.slice(replacement.end)}`;
    precedingStart = replacement.start;
  }
  return rewritten;
}

export function articlePreviewRemoteImageHosts(source: string) {
  const tree = parseArticleMarkdown(source) as MarkdownNode;
  const definitions = new Map<string, string>();
  const imageReferences = new Set<string>();
  const remoteUrls = new Set<string>();

  walk(tree, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      const identifier = normalizedIdentifier(node.identifier);
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    if (
      node.type === "imageReference" &&
      typeof node.identifier === "string"
    ) {
      imageReferences.add(normalizedIdentifier(node.identifier));
    }
    if (node.type === "image" && typeof node.url === "string") {
      remoteUrls.add(node.url);
    }
  });

  for (const identifier of imageReferences) {
    const url = definitions.get(identifier);
    if (url) remoteUrls.add(url);
  }

  const hosts = new Set<string>();
  for (const value of remoteUrls) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") hosts.add(url.host);
    } catch {
      // Relative and malformed URLs are not remote disclosure hosts.
    }
  }
  return Object.freeze([...hosts].sort());
}
