// ABOUTME: Builds and queries the in-process search index for published help articles.
// ABOUTME: Reuses an index only while the current article and category snapshot is unchanged.
import { create, insertMultiple, search } from "@orama/orama";

import { articleDescription, articlePlainText } from "@/content/publication";
import type { Article, Category, PublishedArticle } from "@/db/repository";
import { publicArticlePath } from "@/site";

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
        position: article.position,
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
    const href = category ? publicArticlePath(category.slug, article.slug) : null;

    if (
      !isPublished(article) ||
      !category ||
      category.workspaceId !== article.workspaceId ||
      !href
    ) {
      continue;
    }

    const body = articlePlainText(article.mdx, article.title);
    documents.push({
      id: article.id,
      articleId: article.id,
      title: article.title,
      categoryName: category.name,
      href,
      excerpt: articleDescription(article.mdx, article.title),
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
