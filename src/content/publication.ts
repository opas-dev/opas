// ABOUTME: Projects database articles into safe public metadata and agent-readable documents.
// ABOUTME: Keeps SEO, Markdown, and llms outputs deterministic across database dialects.
import { toString } from "mdast-util-to-string";

import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";
import type { Article, Category, PublishedArticle } from "@/db/repository";
import {
  absoluteSiteUrl,
  publicArticleMarkdownPath,
  publicArticlePath,
  publicCategoryPath,
  publicSiteIdentity,
} from "@/site";

type ArticleRecord = Article | PublishedArticle;

export type PublicArticle = {
  article: ArticleRecord;
  category: Category;
  path: string;
  markdownPath: string;
  markdown: string;
  bodyMarkdown: string;
  plainText: string;
  description: string;
};

type PublicationInput = {
  workspaceId: string;
  articles: readonly ArticleRecord[];
  categories: readonly Category[];
};

const descriptionLength = 180;

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function isPublished(article: ArticleRecord) {
  return !("status" in article) || article.status === "published";
}

function markdownText(value: string) {
  return collapseWhitespace(value).replace(/([\\\[\]])/gu, "\\$1");
}

function publicationNodeText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const node = value as { children?: unknown; type?: unknown };
  if (node.type === "table" && Array.isArray(node.children)) {
    return node.children.map(publicationNodeText).join(" ");
  }

  if (node.type === "tableRow" && Array.isArray(node.children)) {
    return node.children.map(publicationNodeText).join(" ");
  }

  return toString(node as Parameters<typeof toString>[0]);
}

function sortedPublications(publications: readonly PublicArticle[]) {
  return [...publications].sort((left, right) => {
    const categoryPosition = left.category.position - right.category.position;

    if (categoryPosition !== 0) {
      return categoryPosition;
    }

    const categoryId = compareText(left.category.id, right.category.id);

    if (categoryId !== 0) {
      return categoryId;
    }

    const articlePosition = left.article.position - right.article.position;
    return articlePosition || compareText(left.article.id, right.article.id);
  });
}

export function normalizeArticleMarkdown(source: string) {
  const markdown = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return markdown ? `${markdown}\n` : "";
}

export function articleMarkdownBody(source: string, title: string) {
  const markdown = normalizeArticleMarkdown(source).trimEnd();

  if (!markdown) {
    return "";
  }

  const tree = parseArticleMarkdown(markdown);
  const firstNode = tree.children[0];
  const headingEnd = firstNode?.position?.end.offset;

  if (
    firstNode?.type === "heading" &&
    firstNode.depth === 1 &&
    collapseWhitespace(toString(firstNode)) === collapseWhitespace(title) &&
    typeof headingEnd === "number"
  ) {
    return markdown.slice(headingEnd).trim();
  }

  return markdown;
}

export function articlePlainText(source: string, title: string) {
  const markdown = parseArticleMarkdown(normalizeArticleMarkdown(source));
  const plainText = collapseWhitespace(
    markdown.children.map(publicationNodeText).join(" "),
  );
  const normalizedTitle = collapseWhitespace(title);

  if (plainText === normalizedTitle) {
    return "";
  }

  if (plainText.startsWith(`${normalizedTitle} `)) {
    return plainText.slice(normalizedTitle.length + 1);
  }

  return plainText;
}

export function articleDescription(source: string, title: string) {
  const text = articlePlainText(source, title) || collapseWhitespace(title);

  if (text.length <= descriptionLength) {
    return text;
  }

  const candidate = text.slice(0, descriptionLength - 1).trimEnd();
  const finalWordBoundary = candidate.lastIndexOf(" ");
  const description =
    finalWordBoundary >= 120 ? candidate.slice(0, finalWordBoundary) : candidate;

  return `${description}…`;
}

export function joinPublishedArticles({
  workspaceId,
  articles,
  categories,
}: PublicationInput): PublicArticle[] {
  const categoriesById = new Map(
    categories
      .filter(
        (category) =>
          category.workspaceId === workspaceId && publicCategoryPath(category.slug) !== null,
      )
      .map((category) => [category.id, category]),
  );
  const publications: PublicArticle[] = [];

  for (const article of articles) {
    const category = categoriesById.get(article.categoryId);
    const path = category ? publicArticlePath(category.slug, article.slug) : null;
    const markdownPath = category
      ? publicArticleMarkdownPath(category.slug, article.slug)
      : null;

    if (
      !isPublished(article) ||
      article.workspaceId !== workspaceId ||
      !category ||
      category.workspaceId !== article.workspaceId ||
      !path ||
      !markdownPath
    ) {
      continue;
    }

    publications.push({
      article,
      category,
      path,
      markdownPath,
      markdown: normalizeArticleMarkdown(article.mdx),
      bodyMarkdown: articleMarkdownBody(article.mdx, article.title),
      plainText: articlePlainText(article.mdx, article.title),
      description: articleDescription(article.mdx, article.title),
    });
  }

  return sortedPublications(publications);
}

export function homeMetadata(configuredSiteUrl?: string) {
  const identity = publicSiteIdentity();
  return {
    title: identity.siteName,
    description: identity.siteDescription,
    alternates: { canonical: absoluteSiteUrl("/", configuredSiteUrl) },
  };
}

export function categoryMetadata(category: Category, configuredSiteUrl?: string) {
  const path = publicCategoryPath(category.slug);

  if (!path) {
    return null;
  }

  const identity = publicSiteIdentity();
  return {
    title: category.name,
    description: category.description ?? identity.siteDescription,
    alternates: { canonical: absoluteSiteUrl(path, configuredSiteUrl) },
  };
}

export function articleMetadata(publication: PublicArticle, configuredSiteUrl?: string) {
  return {
    title: publication.article.title,
    description: publication.description,
    alternates: {
      canonical: absoluteSiteUrl(publication.path, configuredSiteUrl),
    },
  };
}

export function articleJsonLd(publication: PublicArticle, configuredSiteUrl?: string) {
  const { article } = publication;
  const identity = publicSiteIdentity();

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    datePublished: (article.publishedAt ?? article.createdAt).toISOString(),
    dateModified: article.updatedAt.toISOString(),
    author: {
      "@type": "Person",
      name: article.authorName,
    },
    publisher: {
      "@type": "Organization",
      name: identity.publisherName,
    },
    mainEntityOfPage: absoluteSiteUrl(publication.path, configuredSiteUrl),
  };
}

export function faqJsonLd(publication: PublicArticle) {
  if (!publication.article.isFaq) {
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: publication.article.title,
        acceptedAnswer: {
          "@type": "Answer",
          text: publication.plainText || publication.description,
        },
      },
    ],
  };
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

export function llmsText(
  publications: readonly PublicArticle[],
  configuredSiteUrl?: string,
) {
  const identity = publicSiteIdentity();
  const sections = new Map<string, { category: Category; articles: PublicArticle[] }>();

  for (const publication of sortedPublications(publications)) {
    const section = sections.get(publication.category.id);

    if (section) {
      section.articles.push(publication);
    } else {
      sections.set(publication.category.id, {
        category: publication.category,
        articles: [publication],
      });
    }
  }

  const lines = [`# ${identity.siteName}`, "", `> ${identity.siteDescription}`];

  for (const { category, articles } of sections.values()) {
    lines.push("", `## ${markdownText(category.name)}`, "");

    for (const publication of articles) {
      lines.push(
        `- [${markdownText(publication.article.title)}](${absoluteSiteUrl(
          publication.markdownPath,
          configuredSiteUrl,
        )}): ${publication.description}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function llmsFullText(
  publications: readonly PublicArticle[],
  configuredSiteUrl?: string,
) {
  const documents = sortedPublications(publications).map((publication) => {
    const source = absoluteSiteUrl(publication.path, configuredSiteUrl);
    const heading = `# ${markdownText(publication.article.title)}`;
    const body = publication.bodyMarkdown;

    return body ? `${heading}\nSource: ${source}\n\n${body}` : `${heading}\nSource: ${source}`;
  });

  return documents.length > 0 ? `${documents.join("\n\n")}\n` : "";
}
