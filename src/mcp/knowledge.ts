// ABOUTME: Projects the demo workspace's published articles into bounded MCP search and read results.
// ABOUTME: Reapplies the public publication boundary before returning canonical Markdown or metadata.
import type { Article, Category, PublishedArticle } from "@/db/repository";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { demoIds } from "@/db/demo";
import {
  maximumSearchQueryLength,
  minimumSearchQueryLength,
  normalizeSearchQuery,
  searchQueryLength,
} from "@/search/query";
import {
  absoluteSiteUrl,
  publicArticleMarkdownPath,
  publicArticlePath,
  publicCategoryPath,
  resolveSiteOrigin,
} from "@/site";

type KnowledgeArticle = Article | PublishedArticle;

type McpPublication = Readonly<{
  article: KnowledgeArticle;
  category: Category;
  description: string;
  markdown: string;
  markdownPath: string;
  path: string;
  plainText: string;
}>;

export type McpKnowledgeRecords = Readonly<{
  articles: readonly KnowledgeArticle[];
  categories: readonly Category[];
}>;

export type McpSearchInput = Readonly<{
  limit: number;
  query: string;
}>;

export type McpSearchResult = Readonly<{
  articleId: string;
  category: string;
  excerpt: string;
  markdownUrl: string;
  path: string;
  title: string;
  updatedAt: string;
  url: string;
}>;

export type McpSearchOutput = Readonly<{
  query: string;
  results: readonly McpSearchResult[];
}>;

export type McpReadOutput = Readonly<{
  articleId: string;
  author: string;
  category: string;
  markdown: string;
  markdownUrl: string;
  path: string;
  publishedAt: string;
  title: string;
  updatedAt: string;
  url: string;
}>;

export type McpKnowledgeSource = Readonly<{
  read(path: string): Promise<McpReadOutput | null>;
  search(input: McpSearchInput): Promise<McpSearchOutput>;
}>;

export type McpKnowledgeSourceOptions = Readonly<{
  loadRecords?: () => Promise<McpKnowledgeRecords>;
  siteOrigin?: string;
}>;

export const maximumMcpSearchResults = 10;
export const maximumMcpArticlePathLength = 242;
export const maximumMcpArticleMarkdownLength = 100_001;

const descriptionLength = 180;
const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

async function loadDemoKnowledgeRecords(): Promise<McpKnowledgeRecords> {
  const { getRepository } = await import("@/db");
  const repository = await getRepository();
  const [articles, categories] = await Promise.all([
    repository.listPublishedArticles(demoIds.workspace),
    repository.listCategories(demoIds.workspace),
  ]);

  return { articles, categories };
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueRecords<T extends { id: string }>(records: readonly T[]) {
  const unique = new Map<string, T>();
  const sorted = [...records].sort((left, right) =>
    compareText(left.id, right.id),
  );
  for (const record of sorted) {
    if (!unique.has(record.id)) unique.set(record.id, record);
  }
  return [...unique.values()];
}

export function scopeMcpPublications(records: McpKnowledgeRecords) {
  const categories = uniqueRecords(records.categories).filter(
    (category) =>
      category.workspaceId === demoIds.workspace &&
      publicCategoryPath(category.slug) !== null,
  );
  const categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  );
  const publications: McpPublication[] = [];

  for (const article of uniqueRecords(records.articles)) {
    const category = categoriesById.get(article.categoryId);
    const path = category ? publicArticlePath(category.slug, article.slug) : null;
    const markdownPath = category
      ? publicArticleMarkdownPath(category.slug, article.slug)
      : null;
    if (
      article.workspaceId !== demoIds.workspace ||
      ("status" in article && article.status !== "published") ||
      !category ||
      category.workspaceId !== article.workspaceId ||
      !path ||
      !markdownPath
    ) {
      continue;
    }

    const markdown = normalizeMarkdown(article.mdx);
    const plainText = articleText(markdown, article.title);
    publications.push({
      article,
      category,
      description: articleDescription(plainText, article.title),
      markdown,
      markdownPath,
      path,
      plainText,
    });
  }

  return publications.sort((left, right) => {
    const categoryPosition = left.category.position - right.category.position;
    if (categoryPosition !== 0) return categoryPosition;
    const categoryId = compareText(left.category.id, right.category.id);
    if (categoryId !== 0) return categoryId;
    const articlePosition = left.article.position - right.article.position;
    return articlePosition || compareText(left.article.id, right.article.id);
  });
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeMarkdown(source: string) {
  const markdown = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return markdown ? `${markdown}\n` : "";
}

function articleText(markdown: string, title: string) {
  const tree = markdownParser.parse(markdown);
  const normalizedTitle = collapseWhitespace(title);
  const firstNode = tree.children[0];
  const content =
    firstNode?.type === "heading" &&
    firstNode.depth === 1 &&
    collapseWhitespace(toString(firstNode)) === normalizedTitle
      ? tree.children.slice(1)
      : tree.children;
  return collapseWhitespace(content.map((node) => toString(node)).join(" "));
}

function articleDescription(plainText: string, title: string) {
  const text = plainText || collapseWhitespace(title);
  if (text.length <= descriptionLength) return text;
  const candidate = text.slice(0, descriptionLength - 1).trimEnd();
  const finalWordBoundary = candidate.lastIndexOf(" ");
  const description =
    finalWordBoundary >= 120 ? candidate.slice(0, finalWordBoundary) : candidate;
  return `${description}…`;
}

function publicationSearchResult(publication: McpPublication, siteOrigin: string) {
  return {
    articleId: publication.article.id,
    category: publication.category.name,
    excerpt: publication.description,
    markdownUrl: absoluteSiteUrl(publication.markdownPath, siteOrigin),
    path: publication.path,
    title: publication.article.title,
    updatedAt: publication.article.updatedAt.toISOString(),
    url: absoluteSiteUrl(publication.path, siteOrigin),
  } satisfies McpSearchResult;
}

function publicationReadResult(publication: McpPublication, siteOrigin: string) {
  return {
    ...publicationSearchResult(publication, siteOrigin),
    author: publication.article.authorName,
    markdown: publication.markdown,
    publishedAt: (
      publication.article.publishedAt ?? publication.article.createdAt
    ).toISOString(),
  } satisfies McpReadOutput;
}

function searchableText(value: string) {
  return normalizeSearchQuery(value).toLowerCase();
}

function publicationScore(publication: McpPublication, query: string) {
  const normalizedQuery = searchableText(query);
  const title = searchableText(publication.article.title);
  const category = searchableText(publication.category.name);
  const body = searchableText(publication.plainText);
  const terms = [...new Set(normalizedQuery.split(" "))];
  const combined = `${title} ${category} ${body}`;
  if (!terms.every((term) => combined.includes(term))) return null;

  let score = 0;
  if (title === normalizedQuery) score += 1_000;
  else if (title.includes(normalizedQuery)) score += 500;
  if (body.includes(normalizedQuery)) score += 100;
  if (category.includes(normalizedQuery)) score += 50;
  for (const term of terms) {
    if (title.includes(term)) score += 20;
    if (category.includes(term)) score += 5;
    if (body.includes(term)) score += 1;
  }
  return score;
}

function validateSearchInput(input: McpSearchInput) {
  const query = normalizeSearchQuery(input.query);
  const queryLength = searchQueryLength(query);
  if (
    queryLength < minimumSearchQueryLength ||
    queryLength > maximumSearchQueryLength ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maximumMcpSearchResults
  ) {
    throw new Error("Invalid MCP search request");
  }
  return query;
}

function validArticlePath(path: string) {
  return (
    path.length <= maximumMcpArticlePathLength &&
    /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(path)
  );
}

export function createMcpKnowledgeSource(
  options: McpKnowledgeSourceOptions = {},
): McpKnowledgeSource {
  const loadRecords = options.loadRecords ?? loadDemoKnowledgeRecords;
  const siteOrigin = resolveSiteOrigin(options.siteOrigin);

  async function publications() {
    return scopeMcpPublications(await loadRecords());
  }

  return {
    async search(input) {
      const query = validateSearchInput(input);
      const currentPublications = await publications();

      return {
        query,
        results: currentPublications
          .flatMap((publication, order) => {
            const score = publicationScore(publication, query);
            return score === null ? [] : [{ order, publication, score }];
          })
          .sort(
            (left, right) =>
              right.score - left.score || left.order - right.order,
          )
          .slice(0, input.limit)
          .map(({ publication }) =>
            publicationSearchResult(publication, siteOrigin),
          ),
      };
    },

    async read(path) {
      if (!validArticlePath(path)) return null;
      const publication = (await publications()).find(
        (candidate) => candidate.path === path,
      );
      return publication ? publicationReadResult(publication, siteOrigin) : null;
    },
  };
}
