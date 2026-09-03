// ABOUTME: Installs one complete revision-aware demo profile in a Postgres or Neon transaction.
// ABOUTME: Requires bootstrap, preserves existing work, and publishes through emergency semantics.
import { count, eq, sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
} from "@/db/authoring-controls";
import {
  DemoSeedBootstrapError,
  DemoSeedVerificationError,
  demoSeedProfile,
  initialDemoSeedReason,
  prepareDemoSeedPlan,
} from "@/db/demo-seed";
import type {
  DemoSeedOptions,
  DemoSeedPlan,
  DemoSeedResult,
} from "@/db/demo-seed";
import { getPostgresDatabase } from "@/db/postgres/client";
import { articleEvidenceCommitStatements } from "@/db/postgres/evidence-repository";
import {
  articleHeads,
  articleAssets,
  articleRevisions,
  articleRevisionAssets,
  articleReviewEvents,
  articleSlugClaims,
  articles,
  assets,
  categories,
  themes,
  workspaceAuthoringControls,
  workspaceMembers,
  workspaces,
} from "@/db/schema/postgres";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

type SeedState = Readonly<{
  administratorMemberId: string | null;
  articleCount: number;
  controlExists: boolean;
  revisionCount: number;
  workspaceExists: boolean;
  writesPaused: boolean;
}>;

function integerCount(value: unknown) {
  const result = Number(value);
  return Number.isInteger(result) && result >= 0 ? result : 0;
}

async function readSeedState(
  database: PostgresDatabase,
  workspaceId: string,
): Promise<SeedState> {
  const [workspaceRows, articleRows, revisionRows, administratorRows, controlRows] =
    await Promise.all([
      database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1),
      database
        .select({ value: count() })
        .from(articles)
        .where(eq(articles.workspaceId, workspaceId)),
      database
        .select({ value: count() })
        .from(articleRevisions)
        .where(eq(articleRevisions.workspaceId, workspaceId)),
      database
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          sql`${workspaceMembers.workspaceId} = ${workspaceId}
            and ${workspaceMembers.role} = 'administrator'
            and ${workspaceMembers.status} = 'active'
            and ${workspaceMembers.createdByMemberId} is null`,
        )
        .orderBy(workspaceMembers.createdAt, workspaceMembers.id)
        .limit(1),
      database
        .select({ writesPaused: workspaceAuthoringControls.writesPaused })
        .from(workspaceAuthoringControls)
        .where(eq(workspaceAuthoringControls.workspaceId, workspaceId))
        .limit(1),
    ]);

  return {
    administratorMemberId: administratorRows[0]?.id ?? null,
    articleCount: integerCount(articleRows[0]?.value),
    controlExists: controlRows.length === 1,
    revisionCount: integerCount(revisionRows[0]?.value),
    workspaceExists: workspaceRows.length === 1,
    writesPaused: controlRows[0]?.writesPaused ?? true,
  };
}

async function verifyExistingSeedState(
  database: PostgresDatabase,
  state: SeedState,
  workspaceId: string,
): Promise<DemoSeedResult> {
  const rows = await database
    .select({
      value: sql<number>`(
        select count(*)::integer
        from articles article
        left join article_heads head
          on head.workspace_id = article.workspace_id
          and head.article_id = article.id
        left join article_revisions working_revision
          on working_revision.workspace_id = head.workspace_id
          and working_revision.article_id = head.article_id
          and working_revision.id = head.working_revision_id
          and working_revision.revision_number = head.working_revision_number
        left join article_revisions published_revision
          on published_revision.workspace_id = head.workspace_id
          and published_revision.article_id = head.article_id
          and published_revision.id = head.published_revision_id
          and published_revision.revision_number = head.published_revision_number
        where article.workspace_id = ${workspaceId}
          and (
            head.article_id is null
            or working_revision.id is null
            or working_revision.slug is distinct from head.working_slug
            or (
              head.published_revision_id is not null
              and published_revision.id is null
            )
            or not exists (
              select 1 from article_slug_claims claim
              where claim.workspace_id = article.workspace_id
                and claim.article_id = article.id
                and claim.normalized_slug = article.slug
                and claim.article_row_claim = true
            )
            or not exists (
              select 1 from article_slug_claims claim
              where claim.workspace_id = article.workspace_id
                and claim.article_id = article.id
                and claim.normalized_slug = head.working_slug
                and claim.working_claim = true
            )
            or (
              article.status = 'published'
              and (
                published_revision.id is null
                or article.category_id is distinct from published_revision.category_id
                or article.slug is distinct from published_revision.slug
                or article.title is distinct from published_revision.title
                or article.mdx is distinct from published_revision.mdx
                or article.is_faq is distinct from published_revision.is_faq
                or article.author_name is distinct from published_revision.author_name
                or article.position is distinct from published_revision.position
                or article.content_hash is null
                or article.published_at is null
                or head.archived_at is not null
                or not exists (
                  select 1
                  from evidence_chunks chunk
                  where chunk.workspace_id = article.workspace_id
                    and chunk.article_id = article.id
                    and chunk.article_content_hash = article.content_hash
                    and chunk.publication_state = 'published'
                )
                or exists (
                  select asset.asset_id
                  from article_assets asset
                  where asset.workspace_id = article.workspace_id
                    and asset.article_id = article.id
                  except
                  select revision_asset.asset_id
                  from article_revision_assets revision_asset
                  where revision_asset.workspace_id = article.workspace_id
                    and revision_asset.article_id = article.id
                    and revision_asset.revision_id = published_revision.id
                    and revision_asset.revision_number = published_revision.revision_number
                )
                or exists (
                  select revision_asset.asset_id
                  from article_revision_assets revision_asset
                  where revision_asset.workspace_id = article.workspace_id
                    and revision_asset.article_id = article.id
                    and revision_asset.revision_id = published_revision.id
                    and revision_asset.revision_number = published_revision.revision_number
                  except
                  select asset.asset_id
                  from article_assets asset
                  where asset.workspace_id = article.workspace_id
                    and asset.article_id = article.id
                )
              )
            )
          )
      )`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (
    state.articleCount === 0 ||
    state.revisionCount === 0 ||
    rows.length !== 1 ||
    integerCount(rows[0]?.value) !== 0
  ) {
    throw new DemoSeedVerificationError();
  }
  return {
    articleCount: state.articleCount,
    revisionCount: state.revisionCount,
    statementCount: 0,
    status: "verified_existing",
  };
}

function seedPreconditionLock(plan: DemoSeedPlan) {
  return sql`
    select 1 / count(*)::integer
    from (
      select control.workspace_id
      from workspace_authoring_controls control
      inner join workspace_members member
        on member.workspace_id = control.workspace_id
      where control.workspace_id = ${plan.workspaceId}
        and control.writes_paused = false
        and member.id = ${plan.administratorMemberId}
        and member.role = 'administrator'
        and member.status = 'active'
        and member.created_by_member_id is null
      for update of control
      for share of member
    ) seed_ready
  `;
}

function seedEmptyAssertion(plan: DemoSeedPlan) {
  return sql`
    select 1 / count(*)::integer
    from workspace_authoring_controls control
    where control.workspace_id = ${plan.workspaceId}
      and not exists (
        select 1 from articles where workspace_id = ${plan.workspaceId}
      )
      and not exists (
        select 1 from article_revisions where workspace_id = ${plan.workspaceId}
      )
  `;
}

function initialSeedStatements(database: PostgresDatabase, plan: DemoSeedPlan) {
  const initialArticles = plan.articles.map(({ article }) => ({
    authorName: article.authorName,
    categoryId: article.categoryId,
    contentHash: null,
    createdAt: plan.seededAt,
    id: article.id,
    isFaq: article.isFaq,
    mdx: article.mdx,
    position: article.position,
    publishedAt: null,
    slug: article.slug,
    status: "draft" as const,
    title: article.title,
    updatedAt: plan.seededAt,
    workspaceId: article.workspaceId,
  }));
  const statements: SQL[] = [
    seedPreconditionLock(plan),
    seedEmptyAssertion(plan),
    authoringAssertion(plan.workspaceId, "postgres"),
    database
      .insert(categories)
      .values(
        plan.categories.map((category) => ({
          ...category,
          version: 1,
          createdAt: plan.seededAt,
          updatedAt: plan.seededAt,
        })),
      )
      .getSQL(),
    database
      .insert(themes)
      .values({
        ...plan.theme,
        version: 1,
        createdAt: plan.seededAt,
        updatedAt: plan.seededAt,
      })
      .getSQL(),
  ];
  if (plan.assets.length > 0) {
    statements.push(
      database
        .insert(assets)
        .values(
          plan.assets.map((asset) => ({
            ...asset,
            createdAt: plan.seededAt,
          })),
        )
        .getSQL(),
    );
  }
  statements.push(
    ...initialArticles.map((article) =>
      database.insert(articles).values(article).getSQL(),
    ),
    ...plan.articles.map(({ article, revisionHash, revisionId }) => {
      const category = plan.categories.find(({ id }) => id === article.categoryId);
      if (!category) throw new Error("Demo seed article category is missing.");
      return database
        .insert(articleRevisions)
        .values({
          articleId: article.id,
          authorName: article.authorName,
          categoryId: category.id,
          categoryName: category.name,
          categorySlug: category.slug,
          changeKind: "seed" as const,
          changeSummary: null,
          createdAt: plan.seededAt,
          createdByMemberId: plan.administratorMemberId,
          createdBySystemLabel: null,
          id: revisionId,
          isFaq: article.isFaq,
          mdx: article.mdx,
          position: article.position,
          restoredFromRevisionId: null,
          revisionHash,
          revisionNumber: 1,
          slug: article.slug,
          title: article.title,
          workspaceId: plan.workspaceId,
        })
        .getSQL();
    }),
  );
  const assetsByHash = new Map(plan.assets.map((asset) => [asset.hash, asset]));
  const revisionAssets = plan.articles.flatMap(({ article, revisionId }) =>
    article.assetHashes.map((hash) => {
      const asset = assetsByHash.get(hash);
      if (!asset) throw new Error("Demo seed revision asset is missing.");
      return {
        articleId: article.id,
        assetId: asset.id,
        revisionId,
        revisionNumber: 1,
        workspaceId: plan.workspaceId,
      };
    }),
  );
  if (revisionAssets.length > 0) {
    statements.push(database.insert(articleRevisionAssets).values(revisionAssets).getSQL());
  }
  statements.push(
    database
      .insert(articleSlugClaims)
      .values(
        plan.articles.map(({ article }) => ({
          articleId: article.id,
          articleRowClaim: true,
          normalizedSlug: article.slug,
          workingClaim: true,
          workspaceId: plan.workspaceId,
        })),
      )
      .getSQL(),
    ...plan.articles.map(({ article, revisionId }) =>
      database
        .insert(articleHeads)
        .values({
          archivedAt: null,
          archivedByMemberId: null,
          articleId: article.id,
          publishedRevisionId: null,
          publishedRevisionNumber: null,
          reviewState: "editing" as const,
          submittedByMemberId: null,
          workingRevisionId: revisionId,
          workingRevisionNumber: 1,
          workingSlug: article.slug,
          workspaceId: plan.workspaceId,
        })
        .getSQL(),
    ),
  );

  const publicAssets: Array<{
    articleId: string;
    assetId: string;
    createdAt: Date;
    workspaceId: string;
  }> = [];
  for (const seeded of plan.articles) {
    if (!seeded.evidence) continue;
    statements.push(
      database
        .update(articleHeads)
        .set({
          publishedRevisionId: seeded.publishedRevisionId,
          publishedRevisionNumber: seeded.publishedRevisionNumber,
          reviewState: "approved",
        })
        .where(
          sql`${articleHeads.workspaceId} = ${plan.workspaceId}
            and ${articleHeads.articleId} = ${seeded.article.id}
            and ${articleHeads.workingRevisionId} = ${seeded.revisionId}
            and ${articleHeads.workingRevisionNumber} = 1
            and ${articleHeads.reviewState} = 'editing'`,
        )
        .getSQL(),
      database
        .update(articles)
        .set({
          categoryId: seeded.article.categoryId,
          slug: seeded.article.slug,
          title: seeded.article.title,
          mdx: seeded.article.mdx,
          contentHash: null,
          isFaq: seeded.article.isFaq,
          authorName: seeded.article.authorName,
          position: seeded.article.position,
          publishedAt: plan.seededAt,
          status: "published",
          updatedAt: plan.seededAt,
        })
        .where(
          sql`${articles.workspaceId} = ${plan.workspaceId}
            and ${articles.id} = ${seeded.article.id}
            and ${articles.status} = 'draft'`,
        )
        .getSQL(),
    );
    for (const hash of seeded.article.assetHashes) {
      const asset = assetsByHash.get(hash);
      if (!asset) throw new Error("Demo seed public asset is missing.");
      publicAssets.push({
        articleId: seeded.article.id,
        assetId: asset.id,
        createdAt: plan.seededAt,
        workspaceId: plan.workspaceId,
      });
    }
  }
  if (publicAssets.length > 0) {
    statements.push(database.insert(articleAssets).values(publicAssets).getSQL());
  }

  statements.push(
    ...articleEvidenceCommitStatements(
      database,
      plan.articles.flatMap(({ evidence }) => (evidence ? [evidence] : [])),
      plan.seededAt,
    ),
  );

  for (const seeded of plan.articles) {
    if (!seeded.evidence) continue;
    statements.push(
      database
        .update(articleHeads)
        .set({ reviewState: seeded.finalReviewState })
        .where(
          sql`${articleHeads.workspaceId} = ${plan.workspaceId}
            and ${articleHeads.articleId} = ${seeded.article.id}
            and ${articleHeads.workingRevisionId} = ${seeded.revisionId}
            and ${articleHeads.workingRevisionNumber} = 1
            and ${articleHeads.publishedRevisionId} = ${seeded.publishedRevisionId}
            and ${articleHeads.publishedRevisionNumber} = ${seeded.publishedRevisionNumber}
            and ${articleHeads.reviewState} = 'approved'`,
        )
        .getSQL(),
    );
  }

  const events = plan.articles.flatMap((seeded) =>
    seeded.eventId
      ? [
          {
            action: "emergency_published" as const,
            articleId: seeded.article.id,
            createdAt: plan.seededAt,
            id: seeded.eventId,
            memberId: plan.administratorMemberId,
            note: initialDemoSeedReason,
            revisionId: seeded.revisionId,
            revisionNumber: 1,
            workspaceId: plan.workspaceId,
          },
        ]
      : [],
  );
  if (events.length > 0) {
    statements.push(database.insert(articleReviewEvents).values(events).getSQL());
  }
  return statements;
}

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

function injectedStatements(
  statements: readonly SQL[],
  failAfterStatement: number | undefined,
) {
  if (failAfterStatement === undefined) return [...statements];
  if (
    !Number.isInteger(failAfterStatement) ||
    failAfterStatement < 1 ||
    failAfterStatement > statements.length
  ) {
    throw new Error("Demo seed failure position is invalid.");
  }
  return [
    ...statements.slice(0, failAfterStatement),
    sql`select cast('DEMO_SEED_INJECTED_FAILURE' as integer)`,
    ...statements.slice(failAfterStatement),
  ];
}

async function executeAtomically(
  database: PostgresDatabase,
  statements: readonly SQL[],
) {
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    await database.batch(queries as [Query, ...Query[]]);
    return;
  }
  await database.transaction(async (transaction) => {
    for (const statement of statements) await transaction.execute(statement);
  });
}

export async function reconcilePostgresDemoSeed(
  database: PostgresDatabase = getPostgresDatabase(),
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  const profile = options.profile ?? "opas";
  const seedProfile = demoSeedProfile(profile);
  const before = await readSeedState(database, seedProfile.workspace.id);
  if (before.articleCount > 0 || before.revisionCount > 0) {
    return verifyExistingSeedState(database, before, seedProfile.workspace.id);
  }
  if (!before.workspaceExists || !before.administratorMemberId) {
    throw new DemoSeedBootstrapError();
  }
  if (!before.controlExists || before.writesPaused) throw new AuthoringPausedError();

  const plan = await prepareDemoSeedPlan({
    administratorMemberId: before.administratorMemberId,
    configuredSiteUrl: options.configuredSiteUrl,
    profile,
  });
  const statements = initialSeedStatements(database, plan);
  try {
    await executeAtomically(
      database,
      injectedStatements(statements, options.failAfterStatement),
    );
  } catch (error) {
    const normalized = normalizeAuthoringError(error);
    if (normalized instanceof AuthoringPausedError) throw normalized;
    const afterFailure = await readSeedState(database, plan.workspaceId);
    if (afterFailure.articleCount > 0 || afterFailure.revisionCount > 0) {
      return verifyExistingSeedState(database, afterFailure, plan.workspaceId);
    }
    if (!afterFailure.controlExists || afterFailure.writesPaused) {
      throw new AuthoringPausedError();
    }
    if (!afterFailure.workspaceExists || !afterFailure.administratorMemberId) {
      throw new DemoSeedBootstrapError();
    }
    throw normalized;
  }

  const after = await readSeedState(database, plan.workspaceId);
  if (
    after.articleCount !== plan.articles.length ||
    after.revisionCount !== plan.articles.length
  ) {
    throw new Error("Demo seed transaction did not commit a complete profile.");
  }
  return {
    articleCount: after.articleCount,
    revisionCount: after.revisionCount,
    statementCount: statements.length,
    status: "seeded",
  };
}

export async function seedPostgres(
  database: PostgresDatabase = getPostgresDatabase(),
  options: DemoSeedOptions = {},
): Promise<void> {
  await reconcilePostgresDemoSeed(database, options);
}
