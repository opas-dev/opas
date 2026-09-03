// ABOUTME: Exercises the frozen team-authoring fixture through real persistence and preview HTTP boundaries.
// ABOUTME: Returns a bounded secret-free report suitable for comparing disposable deployment targets.

import {
  issueArticlePreview,
  revokeArticlePreview,
  type ArticlePreviewRepository,
} from "@/auth/article-preview";
import type { ArticlePreviewConfiguration } from "@/auth/preview-environment";
import type { MemberActor, MemberRepository } from "@/auth/member-repository";
import type {
  ArticleDraftRepository,
  ArticleWorkingHead,
  DraftActor,
  DraftWriteResult,
} from "@/db/article-drafts";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";
import {
  captureTeamAuthoringPublicSurfaces,
  hashTeamAuthoringPublicSurface,
  requireTeamAuthoringArchiveAbsent,
  TeamAuthoringPublicSurfaceError,
  type TeamAuthoringRagProjection,
  type TeamAuthoringSurfaceArticle,
} from "@/evaluation/team-authoring-public-surfaces";

export type {
  TeamAuthoringEvidenceRow,
  TeamAuthoringIndexRow,
  TeamAuthoringRagProjection,
} from "@/evaluation/team-authoring-public-surfaces";

export const teamAuthoringAcceptanceReportVersion = 1 as const;
export const teamAuthoringAcceptanceManifestId =
  "manifest_team_authoring_acceptance_baseline";
export const teamAuthoringAcceptanceWorkspaceId = teamAuthoringStandard.workspaceId;

export const teamAuthoringAcceptanceCheckIds = [
  "target-readiness",
  "fixture-foundation",
  "draft-live-isolation",
  "public-surface-baseline",
  "concurrent-save-winner",
  "review-publish",
  "restore-as-draft",
  "historical-asset",
  "preview-lifecycle",
  "preview-header-isolation",
  "role-revocation",
  "archive-recovery",
] as const;

export type TeamAuthoringAcceptanceCheckId =
  (typeof teamAuthoringAcceptanceCheckIds)[number];

export type TeamAuthoringAcceptanceTarget = Readonly<{
  kind: "cloudflare-d1" | "docker-postgres" | "vercel-neon";
  origin: string;
  runId: string;
}>;

export type TeamAuthoringPublicProjection = Readonly<{
  article: Readonly<{
    contentHash: string;
    mdx: string;
    slug: string;
    status: "published";
    title: string;
  }>;
  assetHashes: readonly string[];
  evidenceCount: number;
  indexGeneration: number;
}>;

export type TeamAuthoringAcceptanceActors = Readonly<{
  administrator: MemberActor;
  editor: MemberActor;
  reviewer: MemberActor;
}>;

export type TeamAuthoringAcceptanceBoundary = Readonly<{
  actors: TeamAuthoringAcceptanceActors;
  drafts: ArticleDraftRepository;
  members: MemberRepository;
  previews: ArticlePreviewRepository;
  prepareFixture(): Promise<void>;
  readPublicProjection(articleId: string): Promise<TeamAuthoringPublicProjection | null>;
  readPublicRagProjection(articleId: string): Promise<TeamAuthoringRagProjection>;
  readRevisionAssetHashes(
    articleId: string,
    revisionId: string,
  ): Promise<readonly string[]>;
  revisionCount(articleId: string): Promise<number>;
}>;

export type TeamAuthoringAcceptanceCheck = Readonly<{
  code: string;
  durationMs: number;
  id: TeamAuthoringAcceptanceCheckId;
  status: "failed" | "passed";
}>;

export type TeamAuthoringAcceptanceReport = Readonly<{
  checks: readonly TeamAuthoringAcceptanceCheck[];
  coverage: Readonly<{
    authoring: "database-repository";
    preview: "live-http";
    publication: "database-repository";
    publicSurfaces: "live-http";
  }>;
  finishedAt: string;
  fixture: Readonly<{
    contentHash: string;
    id: string;
    version: number;
  }>;
  limitations: readonly [
    "BROWSER_ACCESSIBILITY_AND_MAINTENANCE_ROLLBACK_RUN_SEPARATELY",
  ];
  outcome: "failed" | "passed";
  publicSurfaceHashes: Readonly<{
    baseline: string | null;
    privateSaves: string | null;
    reviewed: string | null;
  }>;
  reportVersion: typeof teamAuthoringAcceptanceReportVersion;
  startedAt: string;
  target: TeamAuthoringAcceptanceTarget;
}>;

type AcceptanceRuntime = Readonly<{
  boundary: TeamAuthoringAcceptanceBoundary;
  clock?: () => Date;
  fetch?: typeof globalThis.fetch;
  previewConfiguration: ArticlePreviewConfiguration;
  target: TeamAuthoringAcceptanceTarget;
}>;

class AcceptanceCheckError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcceptanceCheckError";
    this.code = code;
  }
}

function requireAcceptance(value: unknown, code: string): asserts value {
  if (!value) throw new AcceptanceCheckError(code);
}

function acceptedDraft(result: DraftWriteResult) {
  if (result.status !== "saved") {
    const reason = "code" in result ? result.code : result.status;
    throw new AcceptanceCheckError(`DRAFT_SAVE_${reason.toUpperCase()}`);
  }
  return result;
}

function requireHead(head: ArticleWorkingHead | null) {
  requireAcceptance(head, "WORKING_HEAD_UNAVAILABLE");
  return head;
}

function articleValues(
  overrides: Readonly<Partial<{
    mdx: string;
    slug: string;
    title: string;
  }>> = {},
) {
  const article = teamAuthoringStandard.publishedArticle;
  return {
    id: article.articleId,
    workspaceId: teamAuthoringAcceptanceWorkspaceId,
    categoryId: article.categoryId,
    slug: overrides.slug ?? article.slug,
    title: overrides.title ?? article.title,
    mdx: overrides.mdx ?? article.mdx,
    isFaq: article.isFaq,
    authorName: article.authorName,
    position: article.position,
  };
}

function publicDigest(projection: TeamAuthoringPublicProjection | null) {
  return JSON.stringify(projection);
}

function workflowTarget(actor: DraftActor, head: ArticleWorkingHead) {
  return {
    actor,
    articleId: head.article.id,
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId: head.article.workspaceId,
  };
}

function privateResponseHeaders(response: Response) {
  return (
    response.headers.get("cache-control") === "private, no-store" &&
    response.headers.get("x-robots-tag") === "noindex, nofollow, noarchive" &&
    response.headers.get("referrer-policy") === "no-referrer" &&
    response.headers.get("x-frame-options") === "DENY" &&
    response.headers.get("x-content-type-options") === "nosniff" &&
    response.headers.get("cross-origin-resource-policy") === "same-origin" &&
    response.headers.get("permissions-policy") ===
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()" &&
    (response.headers.get("content-security-policy") ?? "").includes(
      "frame-ancestors 'none'",
    )
  );
}

async function boundedFetch(fetcher: typeof globalThis.fetch, input: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetcher(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function browserHeaders(origin: string, method: "GET" | "POST") {
  const headers = new Headers({
    accept: "application/json",
    referer: `${origin}/preview`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("origin", origin);
  }
  return headers;
}

function cookiePair(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const pair = cookie.split(";", 1)[0] ?? "";
  requireAcceptance(/^[^=;]+=[^;]+$/u.test(pair), "PREVIEW_COOKIE_MISSING");
  return { cookie, pair };
}

function checkErrorCode(error: unknown) {
  return error instanceof AcceptanceCheckError ||
    error instanceof TeamAuthoringPublicSurfaceError
    ? error.code
    : "UNEXPECTED_ERROR";
}

export async function runTeamAuthoringAcceptance(
  runtime: AcceptanceRuntime,
): Promise<TeamAuthoringAcceptanceReport> {
  const startedAt = (runtime.clock?.() ?? new Date()).toISOString();
  const checks: TeamAuthoringAcceptanceCheck[] = [];
  const fetcher = runtime.fetch ?? globalThis.fetch;
  const { boundary, target } = runtime;
  const articleId = teamAuthoringStandard.publishedArticle.articleId;
  const workspaceId = teamAuthoringAcceptanceWorkspaceId;
  const [firstAssetHash, secondAssetHash] = teamAuthoringStandard.assets.map(
    ({ hash }) => hash,
  );
  requireAcceptance(firstAssetHash && secondAssetHash, "FIXTURE_ASSETS_MISSING");
  const allAssetHashes = [firstAssetHash, secondAssetHash];
  const category = teamAuthoringStandard.categories.find(
    ({ id }) => id === teamAuthoringStandard.publishedArticle.categoryId,
  );
  requireAcceptance(category, "FIXTURE_PUBLIC_CATEGORY_MISSING");
  const categorySlug = category.slug;

  const runCheck = async (
    id: TeamAuthoringAcceptanceCheckId,
    operation: () => Promise<void>,
  ) => {
    const began = Date.now();
    try {
      await operation();
      checks.push({ code: "OK", durationMs: Date.now() - began, id, status: "passed" });
      return true;
    } catch (error) {
      checks.push({
        code: checkErrorCode(error),
        durationMs: Date.now() - began,
        id,
        status: "failed",
      });
      return false;
    }
  };

  let head: ArticleWorkingHead | null = null;
  let baselinePublic: TeamAuthoringPublicProjection | null = null;
  let restoredRevisionId = "";
  let previewToken = "";
  let previewGrantId = "";
  let previewCookie = "";
  let previewCookieAttributes = "";
  let previewResponsesPrivate = false;
  let baselinePublicSurfaceHash = "";
  let privateSavePublicSurfaceHash = "";
  let reviewedPublicSurfaceHash = "";
  let reviewedSurfaceArticle: TeamAuthoringSurfaceArticle | null = null;

  function surfaceArticle(projection: TeamAuthoringPublicProjection) {
    return Object.freeze({
      articleId,
      categorySlug,
      markdown: projection.article.mdx,
      publicAssetHashes: projection.assetHashes,
      slug: projection.article.slug,
      title: projection.article.title,
    }) satisfies TeamAuthoringSurfaceArticle;
  }

  async function captureCurrentPublicSurfaces() {
    const [projection, rag] = await Promise.all([
      boundary.readPublicProjection(articleId),
      boundary.readPublicRagProjection(articleId),
    ]);
    requireAcceptance(projection, "PUBLIC_SURFACE_RECORDS_MISSING");
    return captureTeamAuthoringPublicSurfaces({
      allAssetHashes,
      article: surfaceArticle(projection),
      fetch: fetcher,
      origin: target.origin,
      publicRecords: projection,
      ragRecords: rag,
    });
  }

  async function requireCurrentPublicSurfaceHash(expected: string, code: string) {
    const serialized = await captureCurrentPublicSurfaces();
    const hash = await hashTeamAuthoringPublicSurface(serialized);
    requireAcceptance(hash === expected, code);
    privateSavePublicSurfaceHash = hash;
  }

  async function requireArchiveAbsent(article: TeamAuthoringSurfaceArticle) {
    const [projection, rag] = await Promise.all([
      boundary.readPublicProjection(articleId),
      boundary.readPublicRagProjection(articleId),
    ]);
    requireAcceptance(projection === null, "ARCHIVED_ARTICLE_REMAINED_PUBLIC");
    await requireTeamAuthoringArchiveAbsent({
      allAssetHashes,
      article,
      fetch: fetcher,
      origin: target.origin,
      publicRecords: null,
      ragRecords: rag,
    });
  }

  if (
    !(await runCheck("target-readiness", async () => {
      const response = await boundedFetch(fetcher, `${target.origin}/api/health`);
      requireAcceptance(response.status === 200, "TARGET_HEALTH_FAILED");
      requireAcceptance(response.headers.get("location") === null, "TARGET_REDIRECTED");
      await response.arrayBuffer();
    }))
  ) {
    return report();
  }

  if (!(await runCheck("fixture-foundation", () => boundary.prepareFixture()))) {
    return report();
  }

  if (
    !(await runCheck("draft-live-isolation", async () => {
      const created = acceptedDraft(
        await boundary.drafts.createDraftArticle({
          actor: boundary.actors.editor,
          article: articleValues(),
          assets: {
            hashes: [firstAssetHash, secondAssetHash],
            manifestId: teamAuthoringAcceptanceManifestId,
          },
          changeKind: "manual",
          changeSummary: "Acceptance baseline",
        }),
      );
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.editor,
          articleId,
          workspaceId,
        }),
      );
      requireAcceptance(head.revisionId === created.revisionId, "BASELINE_HEAD_MISMATCH");
      const published = await boundary.drafts.emergencyPublishArticle({
        ...workflowTarget(boundary.actors.administrator, head),
        expectedReviewState: "editing",
        reason: "Disposable acceptance baseline",
      });
      requireAcceptance(published.status === "transitioned", "BASELINE_PUBLISH_FAILED");
      baselinePublic = await boundary.readPublicProjection(articleId);
      requireAcceptance(baselinePublic, "BASELINE_PUBLIC_MISSING");
      requireAcceptance(
        baselinePublic.article.mdx === teamAuthoringStandard.publishedArticle.mdx &&
          baselinePublic.article.title === teamAuthoringStandard.publishedArticle.title,
        "BASELINE_PUBLIC_CONTENT_MISMATCH",
      );
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.editor,
          articleId,
          workspaceId,
        }),
      );
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("public-surface-baseline", async () => {
      const first = await captureCurrentPublicSurfaces();
      const second = await captureCurrentPublicSurfaces();
      requireAcceptance(first === second, "PUBLIC_SURFACE_BASELINE_NONDETERMINISTIC");
      const [firstHash, secondHash] = await Promise.all([
        hashTeamAuthoringPublicSurface(first),
        hashTeamAuthoringPublicSurface(second),
      ]);
      requireAcceptance(firstHash === secondHash, "PUBLIC_SURFACE_HASH_NONDETERMINISTIC");
      baselinePublicSurfaceHash = firstHash;
      privateSavePublicSurfaceHash = firstHash;
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("concurrent-save-winner", async () => {
      head = requireHead(head);
      const expectedRevision = head.revisionNumber;
      const before = publicDigest(baselinePublic);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) => {
          const title = `Acceptance private draft ${index + 1}`;
          return boundary.drafts.saveDraftArticle({
            actor: boundary.actors.editor,
            article: articleValues({
              mdx: `# ${title}\n\nPrivate acceptance content ${index + 1}.`,
              title,
            }),
            assets: { hashes: [firstAssetHash] },
            changeKind: "manual",
            changeSummary: "Concurrent acceptance save",
            expectedWorkingRevisionNumber: expectedRevision,
          });
        }),
      );
      requireAcceptance(
        results.filter(({ status }) => status === "saved").length === 1,
        "CONCURRENT_WINNER_COUNT_INVALID",
      );
      requireAcceptance(
        results.filter(
          (result) => result.status === "conflict" && result.code === "STALE_REVISION",
        ).length === 11,
        "CONCURRENT_CONFLICT_COUNT_INVALID",
      );
      requireAcceptance(
        (await boundary.revisionCount(articleId)) === expectedRevision + 1,
        "CONCURRENT_REVISION_COUNT_INVALID",
      );
      requireAcceptance(
        publicDigest(await boundary.readPublicProjection(articleId)) === before,
        "CONCURRENT_SAVE_CHANGED_PUBLIC",
      );
      await requireCurrentPublicSurfaceHash(
        baselinePublicSurfaceHash,
        "CONCURRENT_SAVE_CHANGED_PUBLIC_SURFACE",
      );
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.editor,
          articleId,
          workspaceId,
        }),
      );
      for (let index = 2; index <= 10; index += 1) {
        const title = `Acceptance private revision ${index}`;
        acceptedDraft(
          await boundary.drafts.saveDraftArticle({
            actor: boundary.actors.editor,
            article: articleValues({
              mdx: `# ${title}\n\nPrivate acceptance revision ${index}.`,
              title,
            }),
            assets: { hashes: [firstAssetHash] },
            changeKind: "manual",
            changeSummary: `Acceptance revision ${index}`,
            expectedWorkingRevisionNumber: head.revisionNumber,
          }),
        );
        head = requireHead(
          await boundary.drafts.getArticleWorkingHead({
            actor: boundary.actors.editor,
            articleId,
            workspaceId,
          }),
        );
        requireAcceptance(
          publicDigest(await boundary.readPublicProjection(articleId)) === before,
          "PRIVATE_SAVE_CHANGED_PUBLIC",
        );
        await requireCurrentPublicSurfaceHash(
          baselinePublicSurfaceHash,
          "PRIVATE_SAVE_CHANGED_PUBLIC_SURFACE",
        );
      }
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("review-publish", async () => {
      head = requireHead(head);
      const submitted = await boundary.drafts.submitArticleForReview({
        ...workflowTarget(boundary.actors.editor, head),
        expectedReviewState: "editing",
        note: "Ready for disposable acceptance review",
      });
      requireAcceptance(submitted.status === "transitioned", "REVIEW_SUBMIT_FAILED");
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.reviewer,
          articleId,
          workspaceId,
        }),
      );
      const published = await boundary.drafts.approveAndPublishArticleRevision({
        ...workflowTarget(boundary.actors.reviewer, head),
        expectedReviewState: "in_review",
        note: "Approved by the acceptance reviewer",
      });
      requireAcceptance(
        published.status === "transitioned" && published.action === "published",
        "REVIEW_PUBLICATION_FAILED",
      );
      const currentPublic = await boundary.readPublicProjection(articleId);
      requireAcceptance(currentPublic, "REVIEWED_PUBLIC_MISSING");
      requireAcceptance(
        currentPublic.article.title === head.article.title &&
          publicDigest(currentPublic) !== publicDigest(baselinePublic),
        "REVIEWED_PUBLIC_MISMATCH",
      );
      requireAcceptance(
        currentPublic.assetHashes.join(",") === firstAssetHash,
        "PUBLIC_ASSET_PROJECTION_MISMATCH",
      );
      const reviewedSerialization = await captureCurrentPublicSurfaces();
      reviewedPublicSurfaceHash = await hashTeamAuthoringPublicSurface(
        reviewedSerialization,
      );
      requireAcceptance(
        reviewedPublicSurfaceHash !== baselinePublicSurfaceHash,
        "REVIEWED_PUBLIC_SURFACE_UNCHANGED",
      );
      reviewedSurfaceArticle = surfaceArticle(currentPublic);
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.editor,
          articleId,
          workspaceId,
        }),
      );
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("restore-as-draft", async () => {
      head = requireHead(head);
      const history = await boundary.drafts.listArticleRevisionHistory({
        actor: boundary.actors.editor,
        articleId,
        limit: 20,
        workspaceId,
      });
      const source = history?.items.find(({ revisionNumber }) => revisionNumber === 1);
      requireAcceptance(source, "BASELINE_REVISION_MISSING");
      const priorCount = await boundary.revisionCount(articleId);
      const restored = await boundary.drafts.restoreRevisionAsDraft({
        actor: boundary.actors.editor,
        articleId,
        changeSummary: "Restore the acceptance baseline",
        expectedReviewState: "published",
        expectedWorkingRevisionNumber: head.revisionNumber,
        sourceRevisionId: source.revisionId,
        sourceRevisionNumber: source.revisionNumber,
        workspaceId,
      });
      requireAcceptance(
        restored.status === "transitioned" && restored.action === "restored",
        "RESTORE_AS_DRAFT_FAILED",
      );
      requireAcceptance(
        (await boundary.revisionCount(articleId)) === priorCount + 1,
        "RESTORE_DID_NOT_APPEND",
      );
      head = requireHead(
        await boundary.drafts.getArticleWorkingHead({
          actor: boundary.actors.editor,
          articleId,
          workspaceId,
        }),
      );
      restoredRevisionId = head.revisionId;
      const restoredDetail = await boundary.drafts.getArticleRevisionDetail({
        actor: boundary.actors.editor,
        articleId,
        revisionId: head.revisionId,
        revisionNumber: head.revisionNumber,
        workspaceId,
      });
      requireAcceptance(
        head.changeKind === "rollback" &&
          restoredDetail?.restoredFromRevisionId === source.revisionId &&
          head.reviewState === "editing",
        "RESTORE_PROVENANCE_MISMATCH",
      );
      const currentPublic = await boundary.readPublicProjection(articleId);
      requireAcceptance(
        currentPublic?.article.title !== teamAuthoringStandard.publishedArticle.title,
        "RESTORE_CHANGED_PUBLIC_IMMEDIATELY",
      );
      const currentSurface = await captureCurrentPublicSurfaces();
      requireAcceptance(
        (await hashTeamAuthoringPublicSurface(currentSurface)) ===
          reviewedPublicSurfaceHash,
        "RESTORE_CHANGED_PUBLIC_SURFACE_IMMEDIATELY",
      );
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("historical-asset", async () => {
      const restoredAssets = await boundary.readRevisionAssetHashes(
        articleId,
        restoredRevisionId,
      );
      requireAcceptance(
        restoredAssets.join(",") === [firstAssetHash, secondAssetHash].sort().join(","),
        "HISTORICAL_ASSET_NOT_RETAINED",
      );
      const currentPublic = await boundary.readPublicProjection(articleId);
      requireAcceptance(
        currentPublic?.assetHashes.includes(secondAssetHash) === false,
        "HISTORICAL_ASSET_REMAINED_PUBLIC",
      );
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("preview-lifecycle", async () => {
      const issued = await issueArticlePreview(
        boundary.actors.editor,
        restoredRevisionId,
        runtime.previewConfiguration,
        { repository: boundary.previews },
      );
      requireAcceptance(issued.outcome === "issued", "PREVIEW_ISSUE_FAILED");
      previewToken = issued.token;
      previewGrantId = issued.grantId;
      const exchange = await boundedFetch(fetcher, `${target.origin}/preview/exchange`, {
        body: JSON.stringify({ bearer: issued.token }),
        headers: browserHeaders(target.origin, "POST"),
        method: "POST",
      });
      requireAcceptance(exchange.status === 200, "PREVIEW_EXCHANGE_FAILED");
      const exchangeBody = await exchange.text();
      requireAcceptance(!exchangeBody.includes(issued.token), "PREVIEW_BEARER_IN_EXCHANGE");
      const cookie = cookiePair(exchange);
      previewCookie = cookie.pair;
      previewCookieAttributes = cookie.cookie;

      const sessionHeaders = browserHeaders(target.origin, "GET");
      sessionHeaders.set("cookie", previewCookie);
      const session = await boundedFetch(fetcher, `${target.origin}/preview/session`, {
        headers: sessionHeaders,
      });
      requireAcceptance(session.status === 200, "PREVIEW_SESSION_FAILED");
      await session.arrayBuffer();

      const page = await boundedFetch(fetcher, `${target.origin}/preview`, {
        headers: { cookie: previewCookie },
      });
      const pageBody = await page.text();
      requireAcceptance(
        page.status === 200 &&
          pageBody.includes(teamAuthoringStandard.publishedArticle.title) &&
          pageBody.includes("Private preview") &&
          !pageBody.includes(issued.token),
        "PREVIEW_REVISION_RENDER_FAILED",
      );

      const asset = await boundedFetch(
        fetcher,
        `${target.origin}/preview/assets/${secondAssetHash}`,
        { headers: { cookie: previewCookie, referer: `${target.origin}/preview` } },
      );
      requireAcceptance(asset.status === 200, "PREVIEW_ASSET_FAILED");
      requireAcceptance((await asset.arrayBuffer()).byteLength > 0, "PREVIEW_ASSET_EMPTY");
      previewResponsesPrivate = [exchange, session, page, asset].every(
        privateResponseHeaders,
      );

      const revoked = await revokeArticlePreview(
        boundary.actors.editor,
        previewGrantId,
        { repository: boundary.previews },
      );
      requireAcceptance(revoked.outcome === "revoked", "PREVIEW_REVOKE_FAILED");
      const revokedSession = await boundedFetch(
        fetcher,
        `${target.origin}/preview/session`,
        { headers: sessionHeaders },
      );
      requireAcceptance(revokedSession.status === 401, "REVOKED_PREVIEW_ACCEPTED");
      await revokedSession.arrayBuffer();
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("preview-header-isolation", async () => {
      requireAcceptance(
        previewResponsesPrivate &&
          !previewCookieAttributes.toLowerCase().includes("domain=") &&
          previewCookieAttributes.includes("Path=/preview") &&
          previewCookieAttributes.includes("HttpOnly") &&
          previewCookieAttributes.includes("Secure") &&
          /SameSite=Lax/iu.test(previewCookieAttributes),
        "PREVIEW_COOKIE_SCOPE_INVALID",
      );
      requireAcceptance(
        !`${target.origin}/preview`.includes(previewToken) &&
          !`${target.origin}/preview/assets/${secondAssetHash}`.includes(previewToken),
        "PREVIEW_BEARER_IN_URL",
      );
      const headers = browserHeaders(target.origin, "GET");
      headers.set("cookie", previewCookie);
      const rejected = await boundedFetch(fetcher, `${target.origin}/preview/session`, {
        headers,
      });
      requireAcceptance(
        rejected.status === 401 && privateResponseHeaders(rejected),
        "PREVIEW_PRIVATE_HEADERS_INVALID",
      );
      const clearingCookie = rejected.headers.get("set-cookie") ?? "";
      requireAcceptance(
        clearingCookie.includes("Max-Age=0") &&
          !clearingCookie.toLowerCase().includes("domain=") &&
          !clearingCookie.includes(previewToken),
        "PREVIEW_COOKIE_CLEAR_INVALID",
      );
      await rejected.arrayBuffer();
    }))
  ) {
    return report();
  }

  if (
    !(await runCheck("role-revocation", async () => {
      const issued = await issueArticlePreview(
        boundary.actors.editor,
        restoredRevisionId,
        runtime.previewConfiguration,
        { repository: boundary.previews },
      );
      requireAcceptance(issued.outcome === "issued", "REVOCATION_PREVIEW_ISSUE_FAILED");
      const exchange = await boundedFetch(fetcher, `${target.origin}/preview/exchange`, {
        body: JSON.stringify({ bearer: issued.token }),
        headers: browserHeaders(target.origin, "POST"),
        method: "POST",
      });
      requireAcceptance(exchange.status === 200, "REVOCATION_PREVIEW_EXCHANGE_FAILED");
      const cookie = cookiePair(exchange).pair;
      await exchange.arrayBuffer();
      const changed = await boundary.members.changeMemberStatus({
        actor: boundary.actors.administrator,
        changedAt: runtime.clock?.() ?? new Date(),
        memberId: boundary.actors.editor.memberId,
        status: "disabled",
      });
      requireAcceptance(changed === "changed", "MEMBER_DISABLE_FAILED");
      const deniedHead = await boundary.drafts.getArticleWorkingHead({
        actor: boundary.actors.editor,
        articleId,
        workspaceId,
      });
      requireAcceptance(deniedHead === null, "DISABLED_MEMBER_READ_SUCCEEDED");
      head = requireHead(head);
      const deniedSave = await boundary.drafts.saveDraftArticle({
        actor: boundary.actors.editor,
        article: head.article,
        assets: { hashes: head.assetHashes },
        changeKind: "manual",
        expectedWorkingRevisionNumber: head.revisionNumber,
      });
      requireAcceptance(
        deniedSave.status === "rejected" && deniedSave.code === "ACTOR_FORBIDDEN",
        "DISABLED_MEMBER_WRITE_SUCCEEDED",
      );
      const sessionHeaders = browserHeaders(target.origin, "GET");
      sessionHeaders.set("cookie", cookie);
      const deniedPreview = await boundedFetch(
        fetcher,
        `${target.origin}/preview/session`,
        { headers: sessionHeaders },
      );
      requireAcceptance(deniedPreview.status === 401, "DISABLED_MEMBER_PREVIEW_SUCCEEDED");
      await deniedPreview.arrayBuffer();
    }))
  ) {
    return report();
  }

  await runCheck("archive-recovery", async () => {
    requireAcceptance(reviewedSurfaceArticle, "REVIEWED_PUBLIC_SURFACE_MISSING");
    const archivedSurfaceArticle = reviewedSurfaceArticle;
    head = requireHead(
      await boundary.drafts.getArticleWorkingHead({
        actor: boundary.actors.reviewer,
        articleId,
        workspaceId,
      }),
    );
    const archived = await boundary.drafts.archiveArticle({
      ...workflowTarget(boundary.actors.reviewer, head),
      expectedPublicStatus: head.publicStatus,
      expectedReviewState: head.reviewState,
      note: "Disposable acceptance archive",
    });
    requireAcceptance(
      archived.status === "transitioned" && archived.action === "archived",
      "ARCHIVE_FAILED",
    );
    await requireArchiveAbsent(archivedSurfaceArticle);
    head = requireHead(
      await boundary.drafts.getArticleWorkingHead({
        actor: boundary.actors.reviewer,
        articleId,
        workspaceId,
      }),
    );
    const recovered = await boundary.drafts.restoreArchivedArticle({
      ...workflowTarget(boundary.actors.administrator, head),
      expectedPublicStatus: head.publicStatus,
      expectedReviewState: head.reviewState,
      note: "Recover the disposable acceptance article",
    });
    requireAcceptance(
      recovered.status === "transitioned" && recovered.action === "restored",
      "ARCHIVE_RECOVERY_FAILED",
    );
    const recoveredHead = requireHead(
      await boundary.drafts.getArticleWorkingHead({
        actor: boundary.actors.reviewer,
        articleId,
        workspaceId,
      }),
    );
    requireAcceptance(
      recoveredHead.archivedAt === null &&
        recoveredHead.publicStatus === "draft" &&
        recoveredHead.reviewState === "editing" &&
        recoveredHead.assetHashes.includes(secondAssetHash),
      "RECOVERED_ARTICLE_STATE_INVALID",
    );
    await requireArchiveAbsent(archivedSurfaceArticle);
    const history = await boundary.drafts.listArticleRevisionHistory({
      actor: boundary.actors.reviewer,
      articleId,
      limit: 20,
      workspaceId,
    });
    requireAcceptance(
      history !== null && history.items.length === (await boundary.revisionCount(articleId)),
      "RECOVERED_HISTORY_INCOMPLETE",
    );
  });

  return report();

  function report(): TeamAuthoringAcceptanceReport {
    const finishedAt = (runtime.clock?.() ?? new Date()).toISOString();
    const result: TeamAuthoringAcceptanceReport = {
      checks,
      coverage: {
        authoring: "database-repository",
        preview: "live-http",
        publication: "database-repository",
        publicSurfaces: "live-http",
      },
      finishedAt,
      fixture: {
        contentHash: teamAuthoringStandard.contentHash,
        id: teamAuthoringStandard.id,
        version: teamAuthoringStandard.version,
      },
      limitations: [
        "BROWSER_ACCESSIBILITY_AND_MAINTENANCE_ROLLBACK_RUN_SEPARATELY",
      ],
      outcome: checks.every(({ status }) => status === "passed") &&
        checks.length === teamAuthoringAcceptanceCheckIds.length
        ? "passed"
        : "failed",
      publicSurfaceHashes: {
        baseline: baselinePublicSurfaceHash || null,
        privateSaves: privateSavePublicSurfaceHash || null,
        reviewed: reviewedPublicSurfaceHash || null,
      },
      reportVersion: teamAuthoringAcceptanceReportVersion,
      startedAt,
      target,
    };
    requireAcceptance(
      new TextEncoder().encode(JSON.stringify(result)).byteLength <= 32_768,
      "ACCEPTANCE_REPORT_TOO_LARGE",
    );
    return Object.freeze(result);
  }
}
