// ABOUTME: Builds one validated, deterministic authoring transaction for a clean demo workspace.
// ABOUTME: Gives every seeded article an attributed revision and published articles exact evidence.
import { prepareArticleEvidence } from "@/content/article-evidence";
import {
  articleRevisionHash,
  type ArticleRevisionSnapshot,
} from "@/content/article-revision";
import { validateArticleMdx } from "@/content/mdx-safety";
import { emergencyPublishRevision } from "@/content/article-workflow";
import { prepareAsset } from "@/db/assets";
import {
  crofusionDemoContent,
  crofusionDemoSeededAt,
} from "@/db/demo-crofusion";
import { demoContent, demoSeededAt } from "@/db/demo";
import type {
  ArticleEvidenceCommit,
  AssetMediaType,
} from "@/db/repository";

export const initialDemoSeedReason = "initial demo seed" as const;
export const demoSeedProfiles = ["opas", "crofusion"] as const;

export type DemoSeedProfileId = (typeof demoSeedProfiles)[number];

export type DemoSeedResult = Readonly<{
  articleCount: number;
  revisionCount: number;
  statementCount: number;
  status: "seeded" | "verified_existing";
}>;

export type DemoSeedOptions = Readonly<{
  configuredSiteUrl?: string;
  failAfterStatement?: number;
  profile?: DemoSeedProfileId;
}>;

export class DemoSeedBootstrapError extends Error {
  readonly code = "DEMO_SEED_REQUIRES_BOOTSTRAP" as const;

  constructor() {
    super("DEMO_SEED_REQUIRES_BOOTSTRAP");
    this.name = "DemoSeedBootstrapError";
  }
}

export class DemoSeedVerificationError extends Error {
  readonly code = "DEMO_SEED_VERIFICATION_FAILED" as const;

  constructor() {
    super("DEMO_SEED_VERIFICATION_FAILED");
    this.name = "DemoSeedVerificationError";
  }
}

type DemoSeedCategory = Readonly<{
  description: string | null;
  id: string;
  name: string;
  position: number;
  slug: string;
  workspaceId: string;
}>;

type DemoSeedArticle = Readonly<{
  assetHashes: readonly string[];
  authorName: string;
  categoryId: string;
  id: string;
  isFaq: boolean;
  mdx: string;
  position: number;
  publishedAt: Date | null;
  slug: string;
  status: "draft" | "published";
  title: string;
  workspaceId: string;
}>;

type DemoSeedAsset = Readonly<{
  byteSize: number;
  content: Uint8Array;
  hash: string;
  id: string;
  mediaType: AssetMediaType;
  workspaceId: string;
}>;

export type DemoSeedProfile = Readonly<{
  articles: readonly DemoSeedArticle[];
  assets: readonly DemoSeedAsset[];
  categories: readonly DemoSeedCategory[];
  id: DemoSeedProfileId;
  seededAt: Date;
  theme: Readonly<{
    config: typeof demoContent.theme.config;
    id: string;
    name: string;
    workspaceId: string;
  }>;
  workspace: Readonly<{ id: string; name: string; slug: string }>;
}>;

export type PreparedDemoSeedArticle = Readonly<{
  article: DemoSeedArticle;
  evidence: ArticleEvidenceCommit | null;
  eventId: string | null;
  finalReviewState: "editing" | "published";
  publishedRevisionId: string | null;
  publishedRevisionNumber: number | null;
  revisionHash: string;
  revisionId: string;
}>;

export type DemoSeedPlan = Readonly<{
  administratorMemberId: string;
  articles: readonly PreparedDemoSeedArticle[];
  assets: readonly DemoSeedAsset[];
  categories: readonly DemoSeedCategory[];
  profileId: DemoSeedProfileId;
  seededAt: Date;
  theme: DemoSeedProfile["theme"];
  workspaceId: string;
}>;

function normalizeProfile(
  id: DemoSeedProfileId,
  content: typeof demoContent | typeof crofusionDemoContent,
  seededAt: string,
): DemoSeedProfile {
  return Object.freeze({
    id,
    seededAt: new Date(seededAt),
    workspace: content.workspace,
    assets:
      "assets" in content
        ? content.assets.map((asset) => ({
            ...asset,
            content: asset.content.slice(),
          }))
        : [],
    categories: content.categories.map((category) => ({
      ...category,
      description: category.description ?? null,
    })),
    articles: content.articles.map((article) => ({
      ...article,
      assetHashes: "assetHashes" in article ? article.assetHashes : [],
      position: "position" in article ? article.position : 0,
      publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
    })),
    theme: content.theme,
  });
}

const profiles = Object.freeze({
  opas: normalizeProfile("opas", demoContent, demoSeededAt),
  crofusion: normalizeProfile(
    "crofusion",
    crofusionDemoContent,
    crofusionDemoSeededAt,
  ),
});

export function demoSeedProfile(id: DemoSeedProfileId = "opas") {
  return profiles[id];
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function deterministicId(
  kind: "revision" | "review_event" | "embedding_job",
  profileId: DemoSeedProfileId,
  articleId: string,
) {
  const digest = await sha256(
    JSON.stringify(["opas.demo-seed-id.v1", kind, profileId, articleId]),
  );
  return `${kind}_${digest}`;
}

async function assertProfile(profile: DemoSeedProfile) {
  if (!Number.isFinite(profile.seededAt.getTime())) {
    throw new Error("Demo seed time is invalid.");
  }
  const categoryIds = new Set(profile.categories.map(({ id }) => id));
  const categorySlugs = new Set(profile.categories.map(({ slug }) => slug));
  const articleIds = new Set(profile.articles.map(({ id }) => id));
  const articleSlugs = new Set(profile.articles.map(({ slug }) => slug));
  const assetIds = new Set(profile.assets.map(({ id }) => id));
  const assetHashes = new Set(profile.assets.map(({ hash }) => hash));
  if (
    categoryIds.size !== profile.categories.length ||
    categorySlugs.size !== profile.categories.length ||
    articleIds.size !== profile.articles.length ||
    articleSlugs.size !== profile.articles.length ||
    assetIds.size !== profile.assets.length ||
    assetHashes.size !== profile.assets.length
  ) {
    throw new Error("Demo seed identities and slugs must be unique.");
  }
  if (
    profile.categories.some(
      (category) => category.workspaceId !== profile.workspace.id,
    ) ||
    profile.articles.some(
      (article) =>
        article.workspaceId !== profile.workspace.id ||
        !categoryIds.has(article.categoryId) ||
        article.assetHashes.some((hash) => !assetHashes.has(hash)),
    ) ||
    profile.assets.some((asset) => asset.workspaceId !== profile.workspace.id) ||
    profile.theme.workspaceId !== profile.workspace.id
  ) {
    throw new Error("Demo seed records must belong to one workspace.");
  }
  for (const asset of profile.assets) {
    const prepared = await prepareAsset({
      content: asset.content,
      mediaType: asset.mediaType,
    });
    if (prepared.hash !== asset.hash || prepared.byteSize !== asset.byteSize) {
      throw new Error("Demo seed assets must match their exact content hash.");
    }
  }
}

export async function prepareDemoSeedPlan(options: Readonly<{
  administratorMemberId: string;
  configuredSiteUrl?: string;
  profile?: DemoSeedProfileId;
}>): Promise<DemoSeedPlan> {
  const administratorMemberId = options.administratorMemberId.trim();
  if (!administratorMemberId) {
    throw new Error("Demo seed requires an administrator member.");
  }
  const profile = demoSeedProfile(options.profile);
  await assertProfile(profile);

  const articles = await Promise.all(
    profile.articles.map(async (article): Promise<PreparedDemoSeedArticle> => {
      await validateArticleMdx(article.mdx, article.title);
      const category = profile.categories.find(({ id }) => id === article.categoryId);
      if (!category) throw new Error("Demo seed article category is missing.");
      const snapshot: ArticleRevisionSnapshot = {
        articleId: article.id,
        assetHashes: article.assetHashes,
        authorName: article.authorName,
        categoryId: category.id,
        categoryName: category.name,
        categorySlug: category.slug,
        isFaq: article.isFaq,
        mdx: article.mdx,
        position: article.position,
        slug: article.slug,
        title: article.title,
        workspaceId: article.workspaceId,
      };
      const revisionId = await deterministicId("revision", profile.id, article.id);
      const revisionHash = await articleRevisionHash(snapshot);
      if (article.status === "draft") {
        return {
          article,
          evidence: null,
          eventId: null,
          finalReviewState: "editing",
          publishedRevisionId: null,
          publishedRevisionNumber: null,
          revisionHash,
          revisionId,
        };
      }

      const finalHead = emergencyPublishRevision(
        {
          archived: false,
          publicStatus: "draft",
          publishedRevisionId: null,
          publishedRevisionNumber: null,
          reviewState: "editing",
          workingRevisionId: revisionId,
          workingRevisionNumber: 1,
        },
        { expectedWorkingRevisionNumber: 1, revisionId },
      );
      const evidenceId = await deterministicId(
        "embedding_job",
        profile.id,
        article.id,
      );
      const evidence = await prepareArticleEvidence(
        { ...article, status: "published", publishedAt: profile.seededAt },
        category.slug,
        {
          availableAt: profile.seededAt,
          configuredSiteUrl: options.configuredSiteUrl,
          createId: () => evidenceId.slice("embedding_job_".length),
        },
      );
      if (!evidence) throw new Error("Published demo articles require evidence.");

      return {
        article,
        evidence,
        eventId: await deterministicId("review_event", profile.id, article.id),
        finalReviewState: finalHead.reviewState,
        publishedRevisionId: finalHead.publishedRevisionId,
        publishedRevisionNumber: finalHead.publishedRevisionNumber,
        revisionHash,
        revisionId,
      };
    }),
  );

  return Object.freeze({
    administratorMemberId,
    articles,
    assets: profile.assets,
    categories: profile.categories,
    profileId: profile.id,
    seededAt: profile.seededAt,
    theme: profile.theme,
    workspaceId: profile.workspace.id,
  });
}
