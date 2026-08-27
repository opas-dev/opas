// ABOUTME: Builds and queries the in-process search index for published help articles.
// ABOUTME: Reuses an index only while the current article and category snapshot is unchanged.
import { create, insertMultiple, search } from "@orama/orama";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import type { Article, Category, PublishedArticle } from "@/db/repository";

export type SearchResult = {
  articleId: string;
  title: string;
  categoryName: string;
  href: string;
  excerpt: string;
};

type SearchRequest = {
  articles: readonly (Article | PublishedArticle)[];
  categories: readonly Category[];
  query: string;
  limit?: number;
};

type SearchDocument = SearchResult & {
  id: string;
  body: string;
};

const articleSearchSchema = {
  id: "string",
  articleId: "string",
  title: "string",
  categoryName: "string",
  href: "string",
  excerpt: "string",
  body: "string",
} as const;

const publicSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const excerptLength = 180;

function createArticleSearchIndex() {
  return create({ schema: articleSearchSchema });
}

type ArticleSearchIndex = ReturnType<typeof createArticleSearchIndex>;

let cachedSnapshot:
  | {
      signature: string;
      index: ArticleSearchIndex;
    }
  | undefined;

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isPublished(article: Article | PublishedArticle) {
  return !("status" in article) || article.status === "published";
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function articleBody(article: Article | PublishedArticle) {
  const markdown = fromMarkdown(article.mdx);
  const plainText = collapseWhitespace(markdown.children.map((node) => toString(node)).join(" "));
  const title = collapseWhitespace(article.title);

  if (plainText === title) {
    return "";
  }

  if (plainText.startsWith(`${title} `)) {
    return plainText.slice(title.length + 1);
  }

  return plainText;
}

function articleExcerpt(body: string, title: string) {
  const text = body || title;

  if (text.length <= excerptLength) {
    return text;
  }

  const candidate = text.slice(0, excerptLength - 1).trimEnd();
  const finalWordBoundary = candidate.lastIndexOf(" ");
  const excerpt = finalWordBoundary >= 120 ? candidate.slice(0, finalWordBoundary) : candidate;

  return `${excerpt}…`;
}

function timestamp(value: Date | null) {
  return value?.toISOString() ?? null;
}

function snapshotSignature(
  articles: readonly (Article | PublishedArticle)[],
  categories: readonly Category[],
) {
  return JSON.stringify({
    articles: [...articles]
      .sort((left, right) => compareText(left.id, right.id))
      .map((article) => ({
        id: article.id,
        workspaceId: article.workspaceId,
        categoryId: article.categoryId,
        slug: article.slug,
        title: article.title,
        mdx: article.mdx,
        status: "status" in article ? article.status : "published",
        isFaq: article.isFaq,
        authorName: article.authorName,
        publishedAt: timestamp(article.publishedAt),
        createdAt: timestamp(article.createdAt),
        updatedAt: timestamp(article.updatedAt),
      })),
    categories: [...categories]
      .sort((left, right) => compareText(left.id, right.id))
      .map((category) => ({
        id: category.id,
        workspaceId: category.workspaceId,
        slug: category.slug,
        name: category.name,
        description: category.description,
        position: category.position,
      })),
  });
}

function searchDocuments(
  articles: readonly (Article | PublishedArticle)[],
  categories: readonly Category[],
) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const documents: SearchDocument[] = [];

  for (const article of articles) {
    const category = categoriesById.get(article.categoryId);

    if (
      !isPublished(article) ||
      !category ||
      category.workspaceId !== article.workspaceId ||
      !publicSlugPattern.test(category.slug) ||
      !publicSlugPattern.test(article.slug)
    ) {
      continue;
    }

    const body = articleBody(article);
    documents.push({
      id: article.id,
      articleId: article.id,
      title: article.title,
      categoryName: category.name,
      href: `/${category.slug}/${article.slug}`,
      excerpt: articleExcerpt(body, article.title),
      body,
    });
  }

  return documents.sort((left, right) => compareText(left.articleId, right.articleId));
}

async function indexForSnapshot(
  articles: readonly (Article | PublishedArticle)[],
  categories: readonly Category[],
) {
  const signature = snapshotSignature(articles, categories);

  if (cachedSnapshot?.signature === signature) {
    return cachedSnapshot.index;
  }

  const index = createArticleSearchIndex();
  const documents = searchDocuments(articles, categories);

  if (documents.length > 0) {
    await insertMultiple(index, documents);
  }

  cachedSnapshot = { signature, index };
  return index;
}

export async function searchPublishedArticles({
  articles,
  categories,
  query,
  limit = 10,
}: SearchRequest): Promise<SearchResult[]> {
  const term = query.trim();
  const resultLimit = Math.max(0, Math.trunc(limit));

  if (!term || resultLimit === 0) {
    return [];
  }

  const index = await indexForSnapshot(articles, categories);
  const results = await search(index, {
    term,
    properties: ["title", "body", "categoryName"],
    tolerance: 1,
    limit: resultLimit,
  });

  return results.hits.map(({ document }) => ({
    articleId: document.articleId,
    title: document.title,
    categoryName: document.categoryName,
    href: document.href,
    excerpt: document.excerpt,
  }));
}
