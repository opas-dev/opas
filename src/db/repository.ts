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
  position: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublishedArticle = Omit<Article, "status">;

export type ArticleSubmission = Omit<Article, "createdAt" | "updatedAt" | "position"> & {
  position?: number;
};

export type AssetMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type Asset = {
  workspaceId: string;
  hash: string;
  mediaType: AssetMediaType;
  byteSize: number;
  content: Uint8Array;
  createdAt: Date;
};

export type AssetUpload = {
  mediaType: string;
  content: Uint8Array;
};

export type AssetManifest = {
  id: string;
  workspaceId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type ArticleAssetSelection = {
  manifestId?: string;
  hashes: readonly string[];
};

export type Category = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
};

export type KnowledgeImportCategory = Omit<Category, "workspaceId">;

export type KnowledgeImportArticle = Omit<
  ArticleSubmission,
  "workspaceId" | "position"
> & {
  position: number;
  assetHashes: readonly string[];
};

export type KnowledgeImport = {
  workspaceId: string;
  manifestId: string;
  categories: readonly KnowledgeImportCategory[];
  articles: readonly KnowledgeImportArticle[];
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
  createdAt: Date;
};

export type ArticleView = {
  id: string;
  articleId: string;
  viewedAt: Date;
};

export type SearchMiss = {
  id: string;
  workspaceId: string;
  query: string;
  createdAt: Date;
};

export type ArticleAnalytics = {
  articleId: string;
  title: string;
  status: ArticleStatus;
  views: number;
  feedbackCount: number;
  helpfulCount: number;
};

export type SearchMissAnalytics = {
  query: string;
  count: number;
};

export type Analytics = {
  articles: ArticleAnalytics[];
  searchMisses: SearchMissAnalytics[];
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
  createArticle(article: ArticleSubmission, assets?: ArticleAssetSelection): Promise<void>;
  updateArticle(article: ArticleSubmission, assets?: ArticleAssetSelection): Promise<void>;
  deleteArticle(workspaceId: string, id: string): Promise<void>;
  createAssetManifest(workspaceId: string, expiresAt: Date): Promise<AssetManifest>;
  stageAsset(
    workspaceId: string,
    manifestId: string,
    upload: AssetUpload,
  ): Promise<Asset>;
  getAsset(workspaceId: string, hash: string): Promise<Asset | null>;
  getPublishedAsset(workspaceId: string, hash: string): Promise<Asset | null>;
  listArticleAssetHashes(workspaceId: string, articleId: string): Promise<string[]>;
  discardAssetManifest(workspaceId: string, manifestId: string): Promise<void>;
  cleanupExpiredAssets(workspaceId: string, expiredAt: Date): Promise<void>;
  activateKnowledgeImport(knowledgeImport: KnowledgeImport): Promise<void>;
  getTheme(workspaceId: string): Promise<Theme | null>;
  updateTheme(theme: ThemeUpdate): Promise<void>;
  getAnalytics(workspaceId: string): Promise<Analytics>;
  createFeedback(feedback: Feedback): Promise<void>;
  recordView(view: ArticleView): Promise<void>;
  recordSearchMiss(miss: SearchMiss): Promise<void>;
};
