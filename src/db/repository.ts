// ABOUTME: Defines the database-neutral records and operations used by OPAS application code.
// ABOUTME: Keeps deployment driver details behind one small repository contract.
export type PublishedArticle = {
  id: string;
  workspaceId: string;
  categoryId: string;
  slug: string;
  title: string;
  mdx: string;
  isFaq: boolean;
  authorName: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

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
};

export type Repository = {
  checkHealth(): Promise<void>;
  findPublishedArticle(workspaceId: string, slug: string): Promise<PublishedArticle | null>;
  listCategories(workspaceId: string): Promise<Category[]>;
  getTheme(workspaceId: string): Promise<Theme | null>;
  createFeedback(feedback: Feedback): Promise<void>;
  recordView(view: ArticleView): Promise<void>;
  recordSearchMiss(miss: SearchMiss): Promise<void>;
};
