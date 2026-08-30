// ABOUTME: Prepares one validated article revision for atomic evidence publication.
// ABOUTME: Keeps revision hashes, canonical source metadata, chunks, and pending jobs deterministic.
import { embeddingInputHash } from "@/ai/embeddings";
import { chunkPublishedArticle } from "@/content/evidence-chunks";
import type {
  ArticleEvidenceCommit,
  ArticleSubmission,
  EvidenceChunkSubmission,
} from "@/db/repository";
import { absoluteSiteUrl, publicArticlePath } from "@/site";

const utf8Encoder = new TextEncoder();

type ArticleEvidenceOptions = {
  availableAt?: Date;
  configuredSiteUrl?: string;
  createId?: () => string;
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encoder.encode(value));

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function publishedArticleContentHash(
  article: Pick<ArticleSubmission, "mdx" | "title">,
  canonicalPath: string,
) {
  return sha256(
    JSON.stringify([
      "opas-published-article-v1",
      article.title,
      article.mdx,
      canonicalPath,
    ]),
  );
}

export async function prepareArticleEvidence(
  article: ArticleSubmission,
  categorySlug: string,
  {
    availableAt = new Date(),
    configuredSiteUrl,
    createId = () => crypto.randomUUID(),
  }: ArticleEvidenceOptions = {},
): Promise<ArticleEvidenceCommit | null> {
  if (article.status === "draft") {
    return null;
  }

  const canonicalPath = publicArticlePath(categorySlug, article.slug);
  if (!canonicalPath) {
    throw new Error("Published evidence requires valid category and article slugs");
  }

  const canonicalUrl = absoluteSiteUrl(canonicalPath, configuredSiteUrl);
  const chunks = await chunkPublishedArticle({
    id: article.id,
    workspaceId: article.workspaceId,
    title: article.title,
    mdx: article.mdx,
    status: article.status,
    canonicalUrl,
  });
  const submissions: EvidenceChunkSubmission[] = await Promise.all(
    chunks.map(async (chunk) => ({
      id: chunk.id,
      contentHash: chunk.contentHash,
      embeddingInputHash: await embeddingInputHash(chunk.embeddingText),
      ordinal: chunk.ordinal,
      title: chunk.title,
      headingPath: chunk.headingPath,
      canonicalUrl: chunk.canonicalUrl,
      markdown: chunk.markdown,
      evidenceText: chunk.evidenceText,
      embeddingText: chunk.embeddingText,
      sourceLineRange: chunk.sourceLineRange,
    })),
  );

  return {
    workspaceId: article.workspaceId,
    articleId: article.id,
    categorySlug,
    articleContentHash: await publishedArticleContentHash(article, canonicalPath),
    chunks: submissions,
    job: {
      id: `embedding_job_${createId()}`,
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt,
    },
  };
}
