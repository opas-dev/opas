// ABOUTME: Exercises private import activation and races through a native D1 binding.
// ABOUTME: Counts every import-side D1 preparation for the fixed 100-article budget.
import { drizzle } from "drizzle-orm/d1";

import { createSqliteRepository } from "../../../src/db/sqlite/repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";
import * as schema from "../../../src/db/schema/sqlite";
import { teamAuthoringStandard } from "../../../src/evaluation/fixtures/team-authoring-standard";
import {
  executeKnowledgeImport,
  ImportExecutionConflictError,
} from "../../../src/import/execute";
import type { KnowledgeImportPlan } from "../../../src/import/planner";

type Environment = Readonly<{ DB: D1Database }>;

const timestamp = Date.parse("2026-09-03T14:00:00.000Z");

function actor(workspaceId: string) {
  return {
    memberId: `member_${workspaceId}`,
    sessionId: workspaceId.includes("budget")
      ? "B".repeat(43)
      : workspaceId.includes("race")
        ? "R".repeat(43)
        : "N".repeat(43),
    workspaceId,
  };
}

function plan(
  categorySlug: string,
  articleSlugs: readonly string[],
): KnowledgeImportPlan {
  return {
    ready: true,
    categories: [
      {
        name: `Category ${categorySlug}`,
        slug: categorySlug,
        position: 0,
      },
    ],
    articles: articleSlugs.map((slug, position) => ({
      sourcePath: `${slug}.md`,
      categorySlug,
      slug,
      title: `Article ${slug}`,
      mdx: `# Article ${slug}\n\nPrivate imported content ${position}.\n`,
      status: "published" as const,
      isFaq: false,
      authorName: "D1 import",
      position,
      assetHashes: [],
      canonicalUrl: `/${categorySlug}/${slug}`,
    })),
    assets: [],
    redirects: [],
    report: {
      dryRun: {
        sourceFiles: articleSlugs.length,
        contentRoot: "",
        summaryPath: null,
      },
      renames: [],
      conflicts: [],
      unknownFields: [],
      skippedContent: [],
      changes: articleSlugs.map((slug) => ({
        path: `${slug}.md`,
        kind: "normalized-status" as const,
        message: "Published source status will be imported as a private draft.",
      })),
      completion: {
        status: "ready",
        categories: 1,
        articles: articleSlugs.length,
        assets: 0,
        redirects: 0,
      },
    },
  };
}

function budgetPlan(): KnowledgeImportPlan {
  const categorySlugs = new Map(
    teamAuthoringStandard.categories.map(({ id, slug }) => [id, slug]),
  );
  return {
    ready: true,
    categories: teamAuthoringStandard.categories.map((category, position) => ({
      name: category.name,
      slug: category.slug,
      position,
    })),
    articles: teamAuthoringStandard.importedArticles.map((article, position) => {
      const categorySlug = categorySlugs.get(article.categoryId)!;
      return {
        sourcePath: `${article.slug}.md`,
        categorySlug,
        slug: article.slug,
        title: article.title,
        mdx: article.mdx,
        status: article.status,
        isFaq: false,
        authorName: "Frozen team-authoring fixture",
        position,
        assetHashes: [],
        canonicalUrl: `/${categorySlug}/${article.slug}`,
      };
    }),
    assets: [],
    redirects: [],
    report: {
      dryRun: {
        sourceFiles: teamAuthoringStandard.importedArticles.length,
        contentRoot: "",
        summaryPath: null,
      },
      renames: [],
      conflicts: [],
      unknownFields: [],
      skippedContent: [],
      changes: teamAuthoringStandard.importedArticles.flatMap((article) =>
        article.status === "published"
          ? [
              {
                path: `${article.slug}.md`,
                kind: "normalized-status" as const,
                message: "Published source status will be imported as a private draft.",
              },
            ]
          : [],
      ),
      completion: {
        status: "ready",
        categories: teamAuthoringStandard.categories.length,
        articles: teamAuthoringStandard.importedArticles.length,
        assets: 0,
        redirects: 0,
      },
    },
  };
}

async function setupWorkspace(environment: Environment, workspaceId: string) {
  const importActor = actor(workspaceId);
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, workspaceId, workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, ?, 'Import administrator', 'administrator', 'active',
           ?, ?, 600000, ?, ?)`,
      )
      .bind(
        importActor.memberId,
        workspaceId,
        `${workspaceId}@example.test`,
        "a".repeat(43),
        "b".repeat(43),
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (
           id, workspace_id, member_id, created_at, expires_at
         ) values (?, ?, ?, ?, ?)`,
      )
      .bind(
        importActor.sessionId,
        workspaceId,
        importActor.memberId,
        timestamp,
        timestamp + 7 * 60 * 60 * 1000,
      ),
  ]);
}

async function setup(environment: Environment) {
  for (const workspaceId of ["workspace_d1_budget", "workspace_d1_race", "workspace_d1_negative"]) {
    await setupWorkspace(environment, workspaceId);
  }
  await environment.DB.batch(
    sqliteTeamAuthoringGuardStatements.map((source) =>
      environment.DB.prepare(source),
    ),
  );
}

function countedDatabase(database: D1Database) {
  let statements = 0;
  const proxy = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          statements += 1;
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...arguments_: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as D1Database;
  return { database: proxy, statements: () => statements };
}

async function inventory(
  environment: Environment,
  workspaceId: string,
) {
  const [articles, categories, revisions, heads, publicAssets, evidence, jobs, index, assets, manifests, manifestItems, revisionAssets, slugClaims] =
    await Promise.all([
      environment.DB.prepare(
        "select count(*) as count, sum(case when status = 'published' then 1 else 0 end) as published, sum(case when content_hash is not null or published_at is not null then 1 else 0 end) as materialized from articles where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number; published: number | null; materialized: number | null }>(),
      environment.DB.prepare(
        "select count(*) as count from categories where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare(
        "select count(*) as count, sum(case when revision_number = 1 and change_kind = 'import' and created_by_member_id is not null then 1 else 0 end) as attributed from article_revisions where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number; attributed: number | null }>(),
      environment.DB.prepare(
        "select count(*) as count, sum(case when review_state = 'editing' and published_revision_id is null then 1 else 0 end) as private_heads from article_heads where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number; private_heads: number | null }>(),
      environment.DB.prepare(
        "select count(*) as count from article_assets where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare(
        "select count(*) as count from evidence_chunks where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare(
        "select count(*) as count from embedding_jobs where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare(
        "select count(*) as count from workspace_index_states where workspace_id = ?",
      ).bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare("select count(*) as count from assets where workspace_id = ?")
        .bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare("select count(*) as count from asset_manifests where workspace_id = ?")
        .bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare("select count(*) as count from asset_manifest_items where workspace_id = ?")
        .bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare("select count(*) as count from article_revision_assets where workspace_id = ?")
        .bind(workspaceId).first<{ count: number }>(),
      environment.DB.prepare("select count(*) as count from article_slug_claims where workspace_id = ?")
        .bind(workspaceId).first<{ count: number }>(),
    ]);
  return {
    articles,
    categories,
    revisions,
    heads,
    publicAssets,
    evidence,
    jobs,
    index,
    assets,
    manifests,
    manifestItems,
    revisionAssets,
    slugClaims,
  };
}

async function exercise(environment: Environment) {
  const measured = countedDatabase(environment.DB);
  const budgetRepository = createSqliteRepository(
    drizzle(measured.database, { schema }),
    () => new Date(timestamp),
  );
  const budgetActor = actor("workspace_d1_budget");
  const capability = await measured.database.prepare(
    `select wm.role as role from workspace_members wm
     join admin_sessions s on s.member_id = wm.id and s.workspace_id = wm.workspace_id
     where wm.id = ? and wm.workspace_id = ? and wm.status = 'active'
       and wm.role in ('administrator', 'editor') and s.id = ?
       and s.revoked_at is null and s.expires_at > ?`,
  ).bind(budgetActor.memberId, budgetActor.workspaceId, budgetActor.sessionId, timestamp)
    .first<{ role: string }>();
  if (!capability) throw new Error("The measured route-equivalent capability check failed.");
  const claims = await budgetRepository.listKnowledgeImportSlugClaims(budgetActor);
  const publicBefore = {
    articles: await budgetRepository.listPublishedArticles(budgetActor.workspaceId),
    categories: await budgetRepository.listCategories(budgetActor.workspaceId),
  };
  let identity = 0;
  await executeKnowledgeImport({
    repository: budgetRepository,
    actor: budgetActor,
    plan: budgetPlan(),
    clock: () => new Date(timestamp),
    createId: () => `budget-${++identity}`,
  });
  const statementCount = measured.statements();
  const publicAfter = {
    articles: await budgetRepository.listPublishedArticles(budgetActor.workspaceId),
    categories: await budgetRepository.listCategories(budgetActor.workspaceId),
  };

  const raceActor = actor("workspace_d1_race");
  const raceRepository = createSqliteRepository(
    drizzle(environment.DB, { schema }),
    () => new Date(timestamp),
  );
  let firstIdentity = 0;
  let secondIdentity = 0;
  const race = await Promise.allSettled([
    executeKnowledgeImport({
      repository: raceRepository,
      actor: raceActor,
      plan: plan("race-first", ["shared-race"]),
      clock: () => new Date(timestamp),
      createId: () => `first-${++firstIdentity}`,
    }),
    executeKnowledgeImport({
      repository: raceRepository,
      actor: raceActor,
      plan: plan("race-second", ["shared-race"]),
      clock: () => new Date(timestamp),
      createId: () => `second-${++secondIdentity}`,
    }),
  ]);

  return {
    initialClaims: claims,
    boundary: "capability + private claims + upload planner + activation",
    statementCount,
    sourcePublished: teamAuthoringStandard.importedArticles.filter(
      ({ status }) => status === "published",
    ).length,
    budget: await inventory(environment, budgetActor.workspaceId),
    publicUnchanged: JSON.stringify(publicBefore) === JSON.stringify(publicAfter),
    race: race.map((result) =>
      result.status === "fulfilled"
        ? { status: "activated" }
        : {
            status: "rejected",
            code:
              result.reason instanceof ImportExecutionConflictError
                ? result.reason.code
                : String(result.reason),
          },
    ),
    raceInventory: await inventory(environment, raceActor.workspaceId),
  };
}

const worker = {
  async fetch(request: Request, environment: Environment) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    try {
      if (path === "/setup" && request.method === "POST") {
        await setup(environment);
        return Response.json({ status: "ready" });
      }
      if (path === "/exercise" && request.method === "POST") {
        return Response.json(await exercise(environment));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        { status: 500 },
      );
    }
  },
};

export default worker;
