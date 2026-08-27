// ABOUTME: Defines the database-neutral records and operations used by OPAS application code.
// ABOUTME: Keeps deployment driver details behind one small repository contract.
export type ArticleStatus = "draft" | "published";

export type Article = {
  id: string;
  workspaceId: string;
  categoryId: string;
  slug: string;
  title: string;
  mdx: string;
  status: ArticleStatus;
  isFaq: boolean;
  authorName: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublishedArticle = Omit<Article, "status">;

export type ArticleSubmission = Omit<Article, "createdAt" | "updatedAt">;

export type Category = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
};

export type Theme = {
  id: string;
  workspaceId: string;
  name: string;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ThemeUpdate = {
  workspaceId: string;
  name: string;
  config: unknown;
};

export type Feedback = {
  id: string;
  articleId: string;
  helpful: boolean;
  comment?: string | null;
};

export type ArticleView = {
  id: string;
  articleId: string;
};

export type SearchMiss = {
  id: string;
  workspaceId: string;
  query: string;
  createdAt: Date;
};

export type Repository = {
  checkHealth(): Promise<void>;
  findPublishedArticle(workspaceId: string, slug: string): Promise<PublishedArticle | null>;
  listPublishedArticles(workspaceId: string): Promise<PublishedArticle[]>;
  listCategories(workspaceId: string): Promise<Category[]>;
  createCategory(category: Category): Promise<void>;
  updateCategory(category: Category): Promise<void>;
  deleteCategory(workspaceId: string, id: string): Promise<boolean>;
  listArticles(workspaceId: string): Promise<Article[]>;
  getArticle(workspaceId: string, id: string): Promise<Article | null>;
  createArticle(article: ArticleSubmission): Promise<void>;
  updateArticle(article: ArticleSubmission): Promise<void>;
  deleteArticle(workspaceId: string, id: string): Promise<void>;
  getTheme(workspaceId: string): Promise<Theme | null>;
  updateTheme(theme: ThemeUpdate): Promise<void>;
  createFeedback(feedback: Feedback): Promise<void>;
  recordView(view: ArticleView): Promise<void>;
  recordSearchMiss(miss: SearchMiss): Promise<void>;
};
