// ABOUTME: Runs private immutable imports against real Postgres and SQLite transactions.
// ABOUTME: Proves attribution, draft isolation, exact assets, conflicts, and authorization.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type { MemberActor } from "@/auth/member-repository";
import { articleRevisionHash } from "@/content/article-revision";
import { AuthoringPausedError } from "@/db/authoring-controls";
import type { CategoryAuthoringRepository } from "@/db/category-authoring";
import {
  KnowledgeImportAuthorizationError,
  type KnowledgeImport,
} from "@/db/knowledge-import";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { createPostgresCategoryAuthoringRepository } from "@/db/postgres/category-authoring-repository";
import { createPostgresRepository } from "@/db/postgres/repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import type { Repository } from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { createSqliteCategoryAuthoringRepository } from "@/db/sqlite/category-authoring-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";
import {
  executeKnowledgeImport,
  ImportExecutionConflictError,
} from "@/import/execute";
import type { KnowledgeImportPlan } from "@/import/planner";

const checkedAt = new Date("2026-09-03T14:00:00.000Z");
const workspaceId = "workspace_import_contract";
const actor: MemberActor = {
  memberId: "member_import_contract",
  sessionId: "I".repeat(43),
  workspaceId,
};
const backupAdministratorId = "member_import_backup";
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);
const assetHash = createHash("sha256").update(png).digest("hex");
const publicPng = new Uint8Array([...png, 0x02]);
const publicAssetHash = createHash("sha256").update(publicPng).digest("hex");
const publicCategoryId = "category_import_public_baseline";
const publicArticleId = "article_import_public_baseline";

type Inventory = Readonly<{
  articleAssets: number;
  assets: string[];
  articles: Array<{
    content_hash: string | null;
    published_at: unknown;
    slug: string;
    status: string;
  }>;
  evidence: number;
  categories: string[];
  heads: Array<{
    article_id: string;
    archived_at: unknown;
    published_revision_id: string | null;
    review_state: string;
    working_revision_id: string;
  }>;
  jobs: number;
  manifestItems: number;
  manifests: number;
  indexStates: Array<{ generation: number }>;
  revisionAssets: string[];
  revisions: Array<{
    article_id: string;
    change_kind: string;
    created_by_member_id: string | null;
    revision_number: number;
  }>;
  slugClaims: Array<{
    article_id: string;
    article_row_claim: unknown;
    normalized_slug: string;
    working_claim: unknown;
  }>;
  snapshots: Array<{
    article_id: string;
    asset_hashes: string;
    author_name: string;
    category_id: string;
    category_name: string;
    category_slug: string;
    is_faq: unknown;
    mdx: string;
    position: number;
    revision_hash: string;
    revision_id: string;
    revision_number: number;
    slug: string;
    title: string;
  }>;
}>;

type Harness = Readonly<{
  close(): Promise<void>;
  categoryRepository: CategoryAuthoringRepository;
  execute(statement: string, parameters?: readonly unknown[]): Promise<void>;
  inventory(articleSlug?: string): Promise<Inventory>;
  name: string;
  repository: Repository;
}>;

function plan(categorySlug: string, articleSlug: string, status: "draft" | "published" = "published"): KnowledgeImportPlan {
  const hash = assetHash;
  return {
    ready: true,
    categories: [{ name: `Category ${categorySlug}`, slug: categorySlug, position: 0 }],
    articles: [
      {
        sourcePath: `${articleSlug}.md`,
        categorySlug,
        slug: articleSlug,
        title: `Article ${articleSlug}`,
        mdx: `# Article ${articleSlug}\n\n![Imported](/api/assets/${hash})\n`,
        status,
        isFaq: false,
        authorName: "Import source",
        position: 0,
        assetHashes: [hash],
        canonicalUrl: `/${categorySlug}/${articleSlug}`,
      },
    ],
    assets: [
      {
        sourcePaths: ["image.png"],
        hash,
        mediaType: "image/png",
        byteSize: png.byteLength,
        content: png,
        canonicalUrl: `/api/assets/${hash}`,
      },
    ],
    redirects: [],
    report: {
      dryRun: { sourceFiles: 2, contentRoot: "", summaryPath: null },
      renames: [],
      conflicts: [],
      unknownFields: [],
      skippedContent: [],
      changes: status === "published"
        ? [{
            path: `${articleSlug}.md`,
            kind: "normalized-status",
            message: "Published source status will be imported as a private draft.",
          }]
        : [],
      completion: {
        status: "ready",
        categories: 1,
        articles: 1,
        assets: 1,
        redirects: 0,
      },
    },
  };
}

async function activation(
  manifestId: string,
  categorySlug: string,
  articleSlug: string,
  suffix: string,
  assetHashes: readonly string[] = [],
): Promise<KnowledgeImport> {
  const category = {
    id: `category_${suffix}`,
    name: `Category ${categorySlug}`,
    slug: categorySlug,
    description: null,
    position: 0,
  };
  const article = {
    id: `article_${suffix}`,
    revisionId: `revision_${suffix}`,
    categoryId: category.id,
    categorySlug,
    categoryName: category.name,
    slug: articleSlug,
    title: `Article ${articleSlug}`,
    mdx: [
      `# Article ${articleSlug}`,
      ...assetHashes.map((hash) => `![Imported](/api/assets/${hash})`),
      "",
    ].join("\n\n"),
    isFaq: false,
    authorName: "Import source",
    position: 0,
    changeSummary: `${suffix} import`,
    assetHashes,
  };
  return {
    actor,
    manifestId,
    categories: [category],
    articles: [
      {
        ...article,
        revisionHash: await articleRevisionHash({ workspaceId, articleId: article.id, ...article }),
      },
    ],
  };
}

async function replaceActivationArticle(
  request: KnowledgeImport,
  values: Partial<KnowledgeImport["articles"][number]>,
): Promise<KnowledgeImport> {
  const article = { ...request.articles[0], ...values };
  return {
    ...request,
    articles: [
      {
        ...article,
        revisionHash: await articleRevisionHash({
          workspaceId: request.actor.workspaceId,
          articleId: article.id,
          categoryId: article.categoryId,
          categorySlug: article.categorySlug,
          categoryName: article.categoryName,
          slug: article.slug,
          title: article.title,
          mdx: article.mdx,
          isFaq: article.isFaq,
          authorName: article.authorName,
          position: article.position,
          assetHashes: article.assetHashes,
        }),
      },
    ],
  };
}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
  });
  for (const statement of postgresTeamAuthoringGuardStatements) {
    await pool.query(statement);
  }
  await pool.query(
    `insert into workspaces (id, slug, name, created_at, updated_at)
     values ($1, 'import-contract', 'Import contract', $2, $2)`,
    [workspaceId, checkedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_at, updated_at
     ) values ($1, $2, 'import@example.test', 'Import administrator', 'administrator', 'active',
       $3, $4, 600000, $5, $5)`,
    [actor.memberId, workspaceId, "a".repeat(43), "b".repeat(43), checkedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_by_member_id,
       created_at, updated_at
     ) values ($1, $2, 'backup@example.test', 'Backup administrator',
       'administrator', 'active', $3, $4, 600000, $5, $6, $6)`,
    [
      backupAdministratorId,
      workspaceId,
      "c".repeat(43),
      "d".repeat(43),
      actor.memberId,
      checkedAt,
    ],
  );
  await pool.query(
    `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      actor.sessionId,
      workspaceId,
      actor.memberId,
      checkedAt,
      new Date(checkedAt.getTime() + 7 * 60 * 60 * 1000),
    ],
  );

  let evidenceIdentity = 0;
  let reviewIdentity = 0;
  let revisionIdentity = 0;
  const repository: Repository = {
    ...createPostgresRepository(database, () => checkedAt),
    ...createPostgresArticleDraftRepository(database, {
      clock: () => checkedAt,
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `import_evidence_pg_${++evidenceIdentity}`,
      createReviewEventId: () => `import_review_pg_${++reviewIdentity}`,
      createRevisionId: () => `import_revision_pg_${++revisionIdentity}`,
    }),
  };

  return {
    name: "Postgres",
    repository,
    categoryRepository: createPostgresCategoryAuthoringRepository(database, {
      clock: () => checkedAt,
    }),
    async execute(statement, parameters = []) {
      await pool.query(statement, [...parameters]);
    },
    async inventory(articleSlug) {
      const condition = articleSlug ? " and slug = $2" : "";
      const parameters = articleSlug ? [workspaceId, articleSlug] : [workspaceId];
      const [
        articles,
        categories,
        heads,
        revisions,
        snapshots,
        revisionAssets,
        articleAssets,
        assets,
        slugClaims,
        evidence,
        jobs,
        manifests,
        manifestItems,
        indexStates,
      ] =
        await Promise.all([
          pool.query(`select status, slug, content_hash, published_at from articles where workspace_id = $1${condition} order by slug`, parameters),
          pool.query("select id from categories where workspace_id = $1 order by id", [workspaceId]),
          pool.query("select article_id, review_state, working_revision_id, published_revision_id, archived_at from article_heads where workspace_id = $1 order by article_id", [workspaceId]),
          pool.query("select article_id, revision_number, change_kind, created_by_member_id from article_revisions where workspace_id = $1 order by article_id, revision_number", [workspaceId]),
          pool.query(
            `select revision.article_id, revision.id as revision_id,
                    revision.revision_number, revision.category_id, revision.category_slug,
                    revision.category_name, revision.slug, revision.title, revision.mdx,
                    revision.is_faq, revision.author_name, revision.position,
                    revision.revision_hash,
                    coalesce((select json_agg(asset.hash order by asset.hash)::text
                      from article_revision_assets selected
                      inner join assets asset on asset.id = selected.asset_id
                        and asset.workspace_id = selected.workspace_id
                      where selected.workspace_id = revision.workspace_id
                        and selected.revision_id = revision.id), '[]') as asset_hashes
             from article_revisions revision
             where revision.workspace_id = $1
             order by revision.article_id, revision.revision_number`,
            [workspaceId],
          ),
          pool.query("select assets.hash from article_revision_assets join assets on assets.id = article_revision_assets.asset_id and assets.workspace_id = article_revision_assets.workspace_id where article_revision_assets.workspace_id = $1 order by assets.hash", [workspaceId]),
          pool.query("select count(*)::int as count from article_assets where workspace_id = $1", [workspaceId]),
          pool.query("select hash from assets where workspace_id = $1 order by hash", [workspaceId]),
          pool.query("select normalized_slug, article_id, working_claim, article_row_claim from article_slug_claims where workspace_id = $1 order by normalized_slug", [workspaceId]),
          pool.query("select count(*)::int as count from evidence_chunks where workspace_id = $1", [workspaceId]),
          pool.query("select count(*)::int as count from embedding_jobs where workspace_id = $1", [workspaceId]),
          pool.query("select count(*)::int as count from asset_manifests where workspace_id = $1", [workspaceId]),
          pool.query("select count(*)::int as count from asset_manifest_items where workspace_id = $1", [workspaceId]),
          pool.query("select generation from workspace_index_states where workspace_id = $1 order by workspace_id", [workspaceId]),
        ]);
      return {
        articles: articles.rows,
        categories: categories.rows.map(({ id }) => id),
        heads: heads.rows,
        revisions: revisions.rows,
        snapshots: snapshots.rows,
        revisionAssets: revisionAssets.rows.map(({ hash }) => hash),
        articleAssets: articleAssets.rows[0].count,
        assets: assets.rows.map(({ hash }) => hash),
        slugClaims: slugClaims.rows,
        evidence: evidence.rows[0].count,
        jobs: jobs.rows[0].count,
        manifests: manifests.rows[0].count,
        manifestItems: manifestItems.rows[0].count,
        indexStates: indexStates.rows,
      };
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
  });
  for (const statement of sqliteTeamAuthoringGuardStatements) client.exec(statement);
  client
    .prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values (?, 'import-contract', 'Import contract', ?, ?)`,
    )
    .run(workspaceId, checkedAt.getTime(), checkedAt.getTime());
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values (?, ?, 'import@example.test', 'Import administrator', 'administrator', 'active',
         ?, ?, 600000, ?, ?)`,
    )
    .run(
      actor.memberId,
      workspaceId,
      "a".repeat(43),
      "b".repeat(43),
      checkedAt.getTime(),
      checkedAt.getTime(),
    );
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_by_member_id,
         created_at, updated_at
       ) values (?, ?, 'backup@example.test', 'Backup administrator',
         'administrator', 'active', ?, ?, 600000, ?, ?, ?)`,
    )
    .run(
      backupAdministratorId,
      workspaceId,
      "c".repeat(43),
      "d".repeat(43),
      actor.memberId,
      checkedAt.getTime(),
      checkedAt.getTime(),
    );
  client
    .prepare(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      actor.sessionId,
      workspaceId,
      actor.memberId,
      checkedAt.getTime(),
      checkedAt.getTime() + 7 * 60 * 60 * 1000,
    );

  let evidenceIdentity = 0;
  let reviewIdentity = 0;
  let revisionIdentity = 0;
  const repository: Repository = {
    ...createSqliteRepository(database, () => checkedAt),
    ...createSqliteArticleDraftRepository(database, {
      clock: () => checkedAt,
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `import_evidence_sqlite_${++evidenceIdentity}`,
      createReviewEventId: () => `import_review_sqlite_${++reviewIdentity}`,
      createRevisionId: () => `import_revision_sqlite_${++revisionIdentity}`,
    }),
  };

  return {
    name: "SQLite",
    repository,
    categoryRepository: createSqliteCategoryAuthoringRepository(database, {
      clock: () => checkedAt,
    }),
    async execute(statement, parameters = []) {
      client.prepare(statement).run(...parameters);
    },
    async inventory(articleSlug) {
      const condition = articleSlug ? " and slug = ?" : "";
      const parameters = articleSlug ? [workspaceId, articleSlug] : [workspaceId];
      const scalar = (statement: string) =>
        (client.prepare(statement).get(workspaceId) as { count: number }).count;
      return {
        articles: client
          .prepare(`select status, slug, content_hash, published_at from articles where workspace_id = ?${condition} order by slug`)
          .all(...parameters) as Inventory["articles"],
        categories: (
          client
            .prepare("select id from categories where workspace_id = ? order by id")
            .all(workspaceId) as Array<{ id: string }>
        ).map(({ id }) => id),
        heads: client
          .prepare("select article_id, review_state, working_revision_id, published_revision_id, archived_at from article_heads where workspace_id = ? order by article_id")
          .all(workspaceId) as Inventory["heads"],
        revisions: client
          .prepare("select article_id, revision_number, change_kind, created_by_member_id from article_revisions where workspace_id = ? order by article_id, revision_number")
          .all(workspaceId) as Inventory["revisions"],
        snapshots: client
          .prepare(
            `select revision.article_id, revision.id as revision_id,
                    revision.revision_number, revision.category_id,
                    revision.category_slug, revision.category_name, revision.slug,
                    revision.title, revision.mdx, revision.is_faq,
                    revision.author_name, revision.position, revision.revision_hash,
                    coalesce((select json_group_array(hash) from (
                      select asset.hash as hash
                      from article_revision_assets selected
                      inner join assets asset on asset.id = selected.asset_id
                        and asset.workspace_id = selected.workspace_id
                      where selected.workspace_id = revision.workspace_id
                        and selected.revision_id = revision.id
                      order by asset.hash
                    )), '[]') as asset_hashes
             from article_revisions revision
             where revision.workspace_id = ?
             order by revision.article_id, revision.revision_number`,
          )
          .all(workspaceId) as Inventory["snapshots"],
        revisionAssets: (
          client
            .prepare("select assets.hash from article_revision_assets join assets on assets.id = article_revision_assets.asset_id and assets.workspace_id = article_revision_assets.workspace_id where article_revision_assets.workspace_id = ? order by assets.hash")
            .all(workspaceId) as Array<{ hash: string }>
        ).map(({ hash }) => hash),
        articleAssets: scalar("select count(*) as count from article_assets where workspace_id = ?"),
        assets: (
          client
            .prepare("select hash from assets where workspace_id = ? order by hash")
            .all(workspaceId) as Array<{ hash: string }>
        ).map(({ hash }) => hash),
        slugClaims: client
          .prepare("select normalized_slug, article_id, working_claim, article_row_claim from article_slug_claims where workspace_id = ? order by normalized_slug")
          .all(workspaceId) as Inventory["slugClaims"],
        evidence: scalar("select count(*) as count from evidence_chunks where workspace_id = ?"),
        jobs: scalar("select count(*) as count from embedding_jobs where workspace_id = ?"),
        manifests: scalar("select count(*) as count from asset_manifests where workspace_id = ?"),
        manifestItems: scalar("select count(*) as count from asset_manifest_items where workspace_id = ?"),
        indexStates: client
          .prepare("select generation from workspace_index_states where workspace_id = ? order by workspace_id")
          .all(workspaceId) as Inventory["indexStates"],
      };
    },
    async close() {
      client.close();
    },
  };
}

async function createPublishedBaseline(harness: Harness) {
  const category = await harness.categoryRepository.createCategory({
    actor,
    category: {
      id: publicCategoryId,
      workspaceId,
      slug: "public-baseline",
      name: "Public baseline",
      description: "Stable public import control",
      position: 0,
    },
    expectedCategoryVersion: 0,
  });
  assert.equal(category.status, "created");

  const request = { ...actor, checkedAt };
  const manifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const asset = await harness.repository.stageAuthorizedAsset(
    request,
    manifest.id,
    { mediaType: "image/png", content: publicPng },
  );
  assert.equal(asset.hash, publicAssetHash);
  const draft = await harness.repository.createDraftArticle({
    actor,
    article: {
      id: publicArticleId,
      workspaceId,
      categoryId: publicCategoryId,
      slug: "public-control",
      title: "Public control",
      mdx: `# Public control\n\nStable evidence.\n\n![Control](/api/assets/${publicAssetHash})\n`,
      isFaq: true,
      authorName: "OPAS",
      position: 0,
    },
    assets: { manifestId: manifest.id, hashes: [publicAssetHash] },
    changeKind: "manual",
    changeSummary: "Create public control",
  });
  assert.equal(draft.status, "saved");
  assert.equal(
    (
      await harness.repository.emergencyPublishArticle({
        actor,
        articleId: publicArticleId,
        expectedReviewState: "editing",
        expectedWorkingRevisionNumber: 1,
        revisionId: draft.status === "saved" ? draft.revisionId : "",
        workspaceId,
        reason: "Establish stable public import control",
      })
    ).status,
    "transitioned",
  );
}

async function publicSurface(repository: Repository) {
  return {
    article: await repository.findPublishedArticle(workspaceId, "public-control"),
    articles: await repository.listPublishedArticles(workspaceId),
    asset: await repository.getPublishedAsset(workspaceId, publicAssetHash),
    assetHashes: await repository.listArticleAssetHashes(workspaceId, publicArticleId),
    categories: await repository.listCategories(workspaceId),
    evidence: await repository.listEvidenceChunks(workspaceId),
    index: await repository.getIndexingState(workspaceId),
  };
}

async function exercise(harness: Harness) {
  let identity = 0;
  const createId = () => `${harness.name.toLocaleLowerCase("en-US")}-${++identity}`;
  await createPublishedBaseline(harness);
  const publicBaseline = await publicSurface(harness.repository);
  const storageBaseline = await harness.inventory();
  const importedPlan = plan("guides", "published-source", "published");
  await executeKnowledgeImport({
    repository: harness.repository,
    actor,
    plan: importedPlan,
    clock: () => checkedAt,
    createId,
  });

  const imported = await harness.inventory("published-source");
  assert.deepEqual(imported.articles, [
    {
      status: "draft",
      slug: "published-source",
      content_hash: null,
      published_at: null,
    },
  ], `${harness.name} materialized a source-marked published import`);
  const stored = imported.snapshots.find(({ slug }) => slug === "published-source");
  assert.ok(stored);
  const importedHead = imported.heads.find(
    ({ article_id }) => article_id === stored.article_id,
  );
  assert.equal(importedHead?.review_state, "editing");
  assert.equal(importedHead?.published_revision_id, null);
  assert.equal(importedHead?.archived_at, null);
  assert.deepEqual(
    imported.revisions.filter(({ article_id }) => article_id === stored.article_id),
    [{
      article_id: stored.article_id,
      revision_number: 1,
      change_kind: "import",
      created_by_member_id: actor.memberId,
    }],
  );
  const storedAssetHashes = JSON.parse(stored.asset_hashes) as string[];
  assert.deepEqual(storedAssetHashes, [assetHash]);
  const storedHash = await articleRevisionHash({
    workspaceId,
    articleId: stored.article_id,
    categoryId: stored.category_id,
    categorySlug: stored.category_slug,
    categoryName: stored.category_name,
    slug: stored.slug,
    title: stored.title,
    mdx: stored.mdx,
    isFaq: Boolean(stored.is_faq),
    authorName: stored.author_name,
    position: stored.position,
    assetHashes: storedAssetHashes,
  });
  assert.equal(stored.revision_hash, storedHash);
  assert.equal(stored.title, importedPlan.articles[0].title);
  assert.equal(stored.mdx, importedPlan.articles[0].mdx);
  assert.equal(imported.articleAssets, storageBaseline.articleAssets);
  assert.equal(imported.evidence, storageBaseline.evidence);
  assert.equal(imported.jobs, storageBaseline.jobs);
  assert.equal(imported.manifests, storageBaseline.manifests);
  assert.equal(imported.manifestItems, storageBaseline.manifestItems);
  assert.deepEqual(imported.indexStates, storageBaseline.indexStates);
  assert.deepEqual(
    imported.assets,
    [...storageBaseline.assets, assetHash].sort(),
  );
  assert.equal(imported.categories.length, storageBaseline.categories.length + 1);
  assert.equal(imported.heads.length, storageBaseline.heads.length + 1);
  assert.equal(imported.revisions.length, storageBaseline.revisions.length + 1);
  assert.equal(imported.snapshots.length, storageBaseline.snapshots.length + 1);
  assert.equal(imported.slugClaims.length, storageBaseline.slugClaims.length + 1);
  assert.deepEqual(await publicSurface(harness.repository), publicBaseline);

  const claims = await harness.repository.listKnowledgeImportSlugClaims(actor);
  assert.ok(claims.categorySlugs.includes("guides"));
  assert.ok(claims.articleSlugs.includes("published-source"));

  const actorChanges = [
    {
      deny: harness.name === "Postgres"
        ? "update workspace_members set role = 'reviewer' where id = $1"
        : "update workspace_members set role = 'reviewer' where id = ?",
      restore: harness.name === "Postgres"
        ? "update workspace_members set role = 'administrator' where id = $1"
        : "update workspace_members set role = 'administrator' where id = ?",
      id: actor.memberId,
    },
    {
      deny: harness.name === "Postgres"
        ? "update workspace_members set status = 'disabled' where id = $1"
        : "update workspace_members set status = 'disabled' where id = ?",
      restore: harness.name === "Postgres"
        ? "update workspace_members set status = 'active' where id = $1"
        : "update workspace_members set status = 'active' where id = ?",
      id: actor.memberId,
    },
    {
      deny: harness.name === "Postgres"
        ? "update admin_sessions set revoked_at = expires_at where id = $1"
        : "update admin_sessions set revoked_at = expires_at where id = ?",
      restore: harness.name === "Postgres"
        ? "update admin_sessions set revoked_at = null where id = $1"
        : "update admin_sessions set revoked_at = null where id = ?",
      id: actor.sessionId,
    },
  ];
  for (const change of actorChanges) {
    const [racingRead] = await Promise.allSettled([
      harness.repository.listKnowledgeImportSlugClaims(actor),
      harness.execute(change.deny, [change.id]),
    ]);
    if (racingRead.status === "fulfilled") {
      assert.deepEqual(racingRead.value, claims);
    } else {
      assert.ok(racingRead.reason instanceof KnowledgeImportAuthorizationError);
    }
    await assert.rejects(
      harness.repository.listKnowledgeImportSlugClaims(actor),
      (error: unknown) => error instanceof KnowledgeImportAuthorizationError,
    );
    await harness.execute(change.restore, [change.id]);
    assert.deepEqual(
      await harness.repository.listKnowledgeImportSlugClaims(actor),
      claims,
    );
  }

  const beforeConflict = await harness.inventory();
  await assert.rejects(
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("second-category", "published-source", "draft"),
      clock: () => checkedAt,
      createId,
    }),
    (error: unknown) =>
      error instanceof ImportExecutionConflictError &&
      error.code === "ARTICLE_CONFLICT",
  );
  assert.deepEqual(await harness.inventory(), beforeConflict);

  await assert.rejects(
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("guides", "category-conflict", "draft"),
      clock: () => checkedAt,
      createId,
    }),
    (error: unknown) =>
      error instanceof ImportExecutionConflictError &&
      error.code === "CATEGORY_CONFLICT",
  );
  assert.deepEqual(await harness.inventory(), beforeConflict);

  const request = { ...actor, checkedAt };
  const missingManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const missingAsset = await activation(
    missingManifest.id,
    "missing-assets",
    "missing-assets",
    `${harness.name.toLocaleLowerCase("en-US")}_missing`,
    ["f".repeat(64)],
  );
  assert.deepEqual(await harness.repository.activateKnowledgeImport(missingAsset), {
    status: "conflict",
    code: "ASSET_UNAVAILABLE",
  });
  const afterMissingAsset = await harness.inventory();
  assert.deepEqual(
    { ...afterMissingAsset, manifests: beforeConflict.manifests },
    beforeConflict,
  );
  assert.equal(afterMissingAsset.manifests, beforeConflict.manifests + 1);
  await harness.repository.discardAuthorizedAssetManifest(request, missingManifest.id);

  const expiredManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const expired = await activation(
    expiredManifest.id,
    "expired-manifest",
    "expired-manifest",
    `${harness.name.toLocaleLowerCase("en-US")}_expired_manifest`,
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update asset_manifests set expires_at = created_at where id = $1"
      : "update asset_manifests set expires_at = created_at where id = ?",
    [expiredManifest.id],
  );
  const forgedManifestTime = {
    ...expired,
    checkedAt: new Date(checkedAt.getTime() - 60_000),
  } as KnowledgeImport & { checkedAt: Date };
  assert.deepEqual(
    await harness.repository.activateKnowledgeImport(forgedManifestTime),
    { status: "conflict", code: "ASSET_UNAVAILABLE" },
  );
  assert.equal((await harness.inventory("expired-manifest")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(request, expiredManifest.id);

  const expiredSessionManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const expiredSession = await activation(
    expiredSessionManifest.id,
    "expired-session",
    "expired-session",
    `${harness.name.toLocaleLowerCase("en-US")}_expired_session`,
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update admin_sessions set created_at = created_at - interval '2 milliseconds', expires_at = created_at - interval '1 millisecond' where id = $1"
      : "update admin_sessions set created_at = created_at - 2, expires_at = created_at - 1 where id = ?",
    [actor.sessionId],
  );
  const forgedSessionTime = {
    ...expiredSession,
    checkedAt: new Date(checkedAt.getTime() - 60_000),
  } as KnowledgeImport & { checkedAt: Date };
  assert.deepEqual(
    await harness.repository.activateKnowledgeImport(forgedSessionTime),
    { status: "conflict", code: "ACTOR_FORBIDDEN" },
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update admin_sessions set expires_at = created_at + interval '7 hours' where id = $1"
      : "update admin_sessions set expires_at = created_at + 25200000 where id = ?",
    [actor.sessionId],
  );
  assert.equal((await harness.inventory("expired-session")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(
    request,
    expiredSessionManifest.id,
  );

  const unsafeManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const unsafe = await replaceActivationArticle(
    await activation(
      unsafeManifest.id,
      "unsafe",
      "unsafe",
      `${harness.name.toLocaleLowerCase("en-US")}_unsafe`,
    ),
    { mdx: "# Article unsafe\n\n{globalThis.process.exit()}\n" },
  );
  await assert.rejects(harness.repository.activateKnowledgeImport(unsafe));
  assert.equal((await harness.inventory("unsafe")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(request, unsafeManifest.id);

  const invalidManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const invalid = await replaceActivationArticle(
    await activation(
      invalidManifest.id,
      "invalid",
      "invalid",
      `${harness.name.toLocaleLowerCase("en-US")}_invalid`,
    ),
    { title: " Article invalid" },
  );
  await assert.rejects(
    harness.repository.activateKnowledgeImport(invalid),
    /KNOWLEDGE_IMPORT_INVALID/u,
  );
  assert.equal((await harness.inventory("invalid")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(request, invalidManifest.id);

  const boundedManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const bounded = await activation(
    boundedManifest.id,
    "bounded",
    "bounded",
    `${harness.name.toLocaleLowerCase("en-US")}_bounded`,
  );
  const invalidShapes: KnowledgeImport[] = [
    { ...bounded, categories: [] },
    { ...bounded, articles: [] },
    {
      ...bounded,
      categories: [
        ...bounded.categories,
        {
          id: `${bounded.categories[0].id}_unused`,
          name: "Unused category",
          slug: "unused-category",
          description: null,
          position: 1,
        },
      ],
    },
    { ...bounded, categories: Array.from({ length: 101 }, () => bounded.categories[0]) },
    { ...bounded, articles: Array.from({ length: 101 }, () => bounded.articles[0]) },
  ];
  for (const invalidShape of invalidShapes) {
    await assert.rejects(
      harness.repository.activateKnowledgeImport(invalidShape),
      /KNOWLEDGE_IMPORT_INVALID/u,
    );
  }
  assert.equal((await harness.inventory("bounded")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(request, boundedManifest.id);

  const importedWorking = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: stored.article_id,
    workspaceId,
  });
  assert.ok(importedWorking);
  const beforeSaveRace = await harness.inventory();
  const [saveRace, saveImportRace] = await Promise.allSettled([
    harness.repository.saveDraftArticle({
      actor,
      article: {
        ...importedWorking.article,
        slug: "save-race-target",
        title: "Save race target",
        mdx: "# Save race target\n\nSaved by the editor race.\n",
      },
      assets: { hashes: [] },
      changeKind: "manual",
      changeSummary: "Race import against save rename",
      expectedWorkingRevisionNumber: importedWorking.revisionNumber,
    }),
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("save-race-category", "save-race-target", "draft"),
      clock: () => checkedAt,
      createId,
    }),
  ]);
  assert.equal(saveRace.status, "fulfilled");
  assert.equal(saveRace.status === "fulfilled" ? saveRace.value.status : "", "saved");
  assert.equal(saveImportRace.status, "rejected");
  assert.ok(
    saveImportRace.status === "rejected" &&
      saveImportRace.reason instanceof ImportExecutionConflictError,
  );
  const afterSaveRace = await harness.inventory();
  assert.equal(afterSaveRace.categories.length, beforeSaveRace.categories.length);
  assert.equal(afterSaveRace.manifests, beforeSaveRace.manifests);
  assert.equal(afterSaveRace.manifestItems, beforeSaveRace.manifestItems);
  assert.deepEqual(afterSaveRace.assets, beforeSaveRace.assets);

  const renamedWorking = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: stored.article_id,
    workspaceId,
  });
  assert.ok(renamedWorking);
  const beforeRestoreRace = await harness.inventory();
  const [restoreRace, restoreImportRace] = await Promise.allSettled([
    harness.repository.restoreRevisionAsDraft({
      actor,
      articleId: stored.article_id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: renamedWorking.revisionNumber,
      sourceRevisionId: stored.revision_id,
      sourceRevisionNumber: stored.revision_number,
      workspaceId,
      changeSummary: "Race import against restore",
    }),
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("restore-race-category", "published-source", "draft"),
      clock: () => checkedAt,
      createId,
    }),
  ]);
  assert.equal(restoreRace.status, "fulfilled");
  assert.equal(
    restoreRace.status === "fulfilled" ? restoreRace.value.status : "",
    "transitioned",
  );
  assert.equal(restoreImportRace.status, "rejected");
  assert.ok(
    restoreImportRace.status === "rejected" &&
      restoreImportRace.reason instanceof ImportExecutionConflictError,
    restoreImportRace.status === "rejected"
      ? `${restoreImportRace.reason?.constructor?.name}: ${String(restoreImportRace.reason)}`
      : "import unexpectedly activated",
  );
  const afterRestoreRace = await harness.inventory();
  assert.equal(afterRestoreRace.categories.length, beforeRestoreRace.categories.length);
  assert.equal(afterRestoreRace.manifests, beforeRestoreRace.manifests);
  assert.equal(afterRestoreRace.manifestItems, beforeRestoreRace.manifestItems);
  assert.deepEqual(afterRestoreRace.assets, beforeRestoreRace.assets);

  const publicWorking = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: publicArticleId,
    workspaceId,
  });
  assert.ok(publicWorking);
  const privatePublicRevision = await harness.repository.saveDraftArticle({
    actor,
    article: {
      ...publicWorking.article,
      slug: "publish-race-target",
      title: "Publish race target",
      mdx: `# Publish race target\n\nStable evidence.\n\n![Control](/api/assets/${publicAssetHash})\n`,
    },
    assets: { hashes: [publicAssetHash] },
    changeKind: "manual",
    changeSummary: "Prepare publication race",
    expectedWorkingRevisionNumber: publicWorking.revisionNumber,
  });
  assert.equal(privatePublicRevision.status, "saved");
  const publishHead = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: publicArticleId,
    workspaceId,
  });
  assert.ok(publishHead);
  const beforePublishRace = await harness.inventory();
  const [publishRace, publishImportRace] = await Promise.allSettled([
    harness.repository.emergencyPublishArticle({
      actor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: publishHead.revisionNumber,
      revisionId: publishHead.revisionId,
      workspaceId,
      reason: "Exercise import versus publication",
    }),
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("publish-race-category", "publish-race-target", "draft"),
      clock: () => checkedAt,
      createId,
    }),
  ]);
  assert.equal(publishRace.status, "fulfilled");
  assert.equal(
    publishRace.status === "fulfilled" ? publishRace.value.status : "",
    "transitioned",
  );
  assert.equal(publishImportRace.status, "rejected");
  assert.ok(
    publishImportRace.status === "rejected" &&
      publishImportRace.reason instanceof ImportExecutionConflictError,
  );
  const afterPublishRace = await harness.inventory();
  assert.equal(afterPublishRace.categories.length, beforePublishRace.categories.length);
  assert.equal(afterPublishRace.manifests, beforePublishRace.manifests);
  assert.equal(afterPublishRace.manifestItems, beforePublishRace.manifestItems);

  const publishedHead = await harness.repository.getArticleWorkingHead({
    actor,
    articleId: publicArticleId,
    workspaceId,
  });
  assert.ok(publishedHead);
  const beforeArchiveRace = await harness.inventory();
  const [archiveRace, archiveImportRace] = await Promise.allSettled([
    harness.repository.archiveArticle({
      actor,
      articleId: publicArticleId,
      expectedPublicStatus: "published",
      expectedReviewState: "published",
      expectedWorkingRevisionNumber: publishedHead.revisionNumber,
      revisionId: publishedHead.revisionId,
      workspaceId,
      note: "Exercise import versus archive",
    }),
    executeKnowledgeImport({
      repository: harness.repository,
      actor,
      plan: plan("archive-race-category", "publish-race-target", "draft"),
      clock: () => checkedAt,
      createId,
    }),
  ]);
  assert.equal(archiveRace.status, "fulfilled");
  assert.equal(
    archiveRace.status === "fulfilled" ? archiveRace.value.status : "",
    "transitioned",
  );
  assert.equal(archiveImportRace.status, "rejected");
  assert.ok(
    archiveImportRace.status === "rejected" &&
      archiveImportRace.reason instanceof ImportExecutionConflictError,
  );
  const afterArchiveRace = await harness.inventory();
  assert.equal(afterArchiveRace.categories.length, beforeArchiveRace.categories.length);
  assert.equal(afterArchiveRace.manifests, beforeArchiveRace.manifests);
  assert.equal(afterArchiveRace.manifestItems, beforeArchiveRace.manifestItems);

  const actorManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const forbidden = await activation(
    actorManifest.id,
    "forbidden",
    "forbidden",
    `${harness.name.toLocaleLowerCase("en-US")}_forbidden`,
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update workspace_members set role = 'reviewer' where id = $1"
      : "update workspace_members set role = 'reviewer' where id = ?",
    [actor.memberId],
  );
  assert.deepEqual(await harness.repository.activateKnowledgeImport(forbidden), {
    status: "conflict",
    code: "ACTOR_FORBIDDEN",
  });
  await harness.execute(
    harness.name === "Postgres"
      ? "update workspace_members set role = 'administrator' where id = $1"
      : "update workspace_members set role = 'administrator' where id = ?",
    [actor.memberId],
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update admin_sessions set revoked_at = expires_at where id = $1"
      : "update admin_sessions set revoked_at = expires_at where id = ?",
    [actor.sessionId],
  );
  assert.deepEqual(await harness.repository.activateKnowledgeImport(forbidden), {
    status: "conflict",
    code: "ACTOR_FORBIDDEN",
  });
  await harness.execute(
    harness.name === "Postgres"
      ? "update admin_sessions set revoked_at = null where id = $1"
      : "update admin_sessions set revoked_at = null where id = ?",
    [actor.sessionId],
  );
  assert.equal((await harness.inventory("forbidden")).articles.length, 0);
  await harness.repository.discardAuthorizedAssetManifest(request, actorManifest.id);

  const pausedManifest = await harness.repository.createAuthorizedAssetManifest(
    request,
    new Date(checkedAt.getTime() + 60_000),
  );
  const paused = await activation(
    pausedManifest.id,
    "paused",
    "paused",
    `${harness.name.toLocaleLowerCase("en-US")}_paused`,
  );
  await harness.execute(
    harness.name === "Postgres"
      ? "update workspace_authoring_controls set writes_paused = true where workspace_id = $1"
      : "update workspace_authoring_controls set writes_paused = 1 where workspace_id = ?",
    [workspaceId],
  );
  await assert.rejects(
    harness.repository.activateKnowledgeImport(paused),
    (error: unknown) => error instanceof AuthoringPausedError,
  );
  assert.equal((await harness.inventory("paused")).articles.length, 0);
  await harness.execute(
    harness.name === "Postgres"
      ? "update workspace_authoring_controls set writes_paused = false where workspace_id = $1"
      : "update workspace_authoring_controls set writes_paused = 0 where workspace_id = ?",
    [workspaceId],
  );
  await harness.repository.discardAuthorizedAssetManifest(request, pausedManifest.id);
}

test(
  "private imports stay atomic and attributed on Postgres and SQLite",
  { timeout: 180_000 },
  async () => {
    for (const createHarness of [createPostgresHarness, createSqliteHarness]) {
      const harness = await createHarness();
      try {
        await exercise(harness);
      } finally {
        await harness.close();
      }
    }
  },
);
