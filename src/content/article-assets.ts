// ABOUTME: Derives content-addressed assets genuinely referenced by canonical article Markdown.
// ABOUTME: Keeps attachment selection identical for linked and embedded assets across import and save.
import { articleAssetHash } from "@/content/article-url-policy";
import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

type ArticleMarkdownNode = {
  children?: ArticleMarkdownNode[];
  identifier?: string;
  type: string;
  url?: string;
};

function normalizedIdentifier(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function referencedArticleAssetHashes(source: string) {
  const tree = parseArticleMarkdown(source) as ArticleMarkdownNode;
  const definitions = new Map<string, string>();
  const assetReferences = new Set<string>();
  const hashes = new Set<string>();

  function visit(node: ArticleMarkdownNode) {
    if (
      (node.type === "image" || node.type === "link") &&
      typeof node.url === "string"
    ) {
      const hash = articleAssetHash(node.url);
      if (hash) {
        hashes.add(hash);
      }
    }

    if (
      (node.type === "imageReference" || node.type === "linkReference") &&
      typeof node.identifier === "string"
    ) {
      assetReferences.add(normalizedIdentifier(node.identifier));
    }

    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      const identifier = normalizedIdentifier(node.identifier);
      if (!definitions.has(identifier)) {
        definitions.set(identifier, node.url);
      }
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(tree);

  for (const identifier of assetReferences) {
    const url = definitions.get(identifier);
    const hash = url ? articleAssetHash(url) : null;
    if (hash) {
      hashes.add(hash);
    }
  }

  return [...hashes].sort();
}
