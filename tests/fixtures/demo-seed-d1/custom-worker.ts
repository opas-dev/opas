// ABOUTME: Exercises the typed demo seed through a native Wrangler D1 binding.
// ABOUTME: Reports D1 batch counts, exact rows, and failure-injection outcomes.
import { drizzle } from "drizzle-orm/d1";

import { demoSeedProfile, type DemoSeedProfileId } from "../../../src/db/demo-seed";
import * as schema from "../../../src/db/schema/sqlite";
import { createSqliteArticleDraftRepository } from "../../../src/db/sqlite/article-draft-repository";
import { reconcileSqliteDemoSeed } from "../../../src/db/sqlite/seed";

type Environment = Readonly<{ DB: D1Database }>;

const administratorId = "member_demo_seed_administrator";
const verifier = "A".repeat(43);

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function profileFrom(url: URL): DemoSeedProfileId {
  return url.searchParams.get("profile") === "crofusion" ? "crofusion" : "opas";
}

function countedDatabase(source: D1Database) {
  let batches = 0;
  const client = new Proxy(source, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    batches: () => batches,
    database: drizzle(client, { schema }),
  };
}

async function bootstrap(environment: Environment, profileId: DemoSeedProfileId) {
  const profile = demoSeedProfile(profileId);
  const createdAt = Date.parse("2026-09-03T10:00:00.000Z");
  await environment.DB.batch([
    environment.DB.prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    ).bind(
      profile.workspace.id,
      profile.workspace.slug,
      profile.workspace.name,
      createdAt,
      createdAt,
    ),
    environment.DB.prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_by_member_id,
         created_at, updated_at, last_login_at
       ) values (?, ?, ?, ?, 'administrator', 'active', ?, ?, 600000, null, ?, ?, null)`,
    ).bind(
      administratorId,
      profile.workspace.id,
      "seed-admin@opas.dev",
      "Seed Administrator",
      verifier,
      verifier,
      createdAt,
      createdAt,
    ),
  ]);
}

const seedOwnedTables = [
  "categories",
  "themes",
  "articles",
  "article_revisions",
  "article_heads",
  "article_slug_claims",
  "article_review_events",
  "evidence_chunks",
  "embedding_jobs",
  "workspace_index_states",
  "assets",
  "article_assets",
  "article_revision_assets",
] as const;

async function snapshot(environment: Environment) {
  const [
    counts,
    articles,
    revisions,
    events,
    heads,
    assets,
    themes,
    materialization,
  ] = await Promise.all([
    environment.DB.batch(
      seedOwnedTables.map((table) =>
        environment.DB.prepare(`select count(*) as value from ${table}`),
      ),
    ),
    environment.DB.prepare(
      `select id, title, mdx, status, content_hash as contentHash
       from articles order by id`,
    ).all(),
    environment.DB.prepare(
      `select id, article_id as articleId, revision_number as revisionNumber,
         revision_hash as revisionHash, change_kind as changeKind,
         created_by_member_id as memberId
       from article_revisions order by article_id, revision_number`,
    ).all(),
    environment.DB.prepare(
      `select id, article_id as articleId, action, note, member_id as memberId
       from article_review_events order by id`,
    ).all(),
    environment.DB.prepare(
      `select article_id as articleId, working_revision_id as workingRevisionId,
         working_revision_number as workingRevisionNumber,
         published_revision_id as publishedRevisionId,
         published_revision_number as publishedRevisionNumber, review_state as reviewState
       from article_heads order by article_id`,
    ).all(),
    environment.DB.prepare(
      `select id, hash, media_type as mediaType, byte_size as byteSize,
         hex(content) as contentHex from assets order by id`,
    ).all(),
    environment.DB.prepare(
      "select id, name, version, config from themes order by id",
    ).all(),
    environment.DB.prepare(
      `select count(*) as value
       from articles
       inner join article_heads heads
         on heads.workspace_id = articles.workspace_id
         and heads.article_id = articles.id
       inner join article_revisions revisions
         on revisions.workspace_id = heads.workspace_id
         and revisions.article_id = heads.article_id
         and revisions.id = heads.published_revision_id
         and revisions.revision_number = heads.published_revision_number
       where articles.status = 'published'
         and (articles.category_id <> revisions.category_id
           or articles.slug <> revisions.slug
           or articles.title <> revisions.title
           or articles.mdx <> revisions.mdx
           or articles.is_faq <> revisions.is_faq
           or articles.author_name <> revisions.author_name
           or articles.position <> revisions.position
           or articles.content_hash is null
           or articles.published_at is null)`,
    ).first<{ value: number }>(),
  ]);
  return {
    counts: Object.fromEntries(
      seedOwnedTables.map((table, index) => [
        table,
        Number((counts[index]?.results[0] as { value?: number } | undefined)?.value ?? 0),
      ]),
    ),
    integrity: {
      publishedMaterializationFailures: Number(materialization?.value ?? 0),
    },
    rows: {
      articles: articles.results,
      assets: assets.results,
      events: events.results,
      heads: heads.results,
      revisions: revisions.results,
      themes: themes.results,
    },
  };
}

async function clearSeed(environment: Environment) {
  await environment.DB.batch([
    environment.DB.prepare("delete from themes"),
    environment.DB.prepare("delete from categories"),
    environment.DB.prepare("delete from assets"),
    environment.DB.prepare("delete from workspace_index_states"),
  ]);
}

async function editSeededArticle(environment: Environment) {
  const profile = demoSeedProfile("opas");
  const source = profile.articles.find(
    ({ id }) => id === "article_runtime_mdx",
  );
  if (!source) throw new Error("The published demo article is missing.");
  const changedAt = new Date("2026-09-03T10:30:00.000Z");
  const sessionId = "S".repeat(43);
  const title = `${source.title} — operator edit`;
  const body = source.mdx.slice(source.mdx.indexOf("\n"));
  await environment.DB.prepare(
    `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      profile.workspace.id,
      administratorId,
      changedAt.getTime() - 1_000,
      changedAt.getTime() + 8 * 60 * 60 * 1_000 - 1_000,
    )
    .run();
  const repository = createSqliteArticleDraftRepository(
    drizzle(environment.DB, { schema }),
    {
      clock: () => changedAt,
      createReviewEventId: () => "review_event_demo_operator_submit",
      createRevisionId: () => "revision_demo_operator_2",
    },
  );
  const saved = await repository.saveDraftArticle({
    actor: { memberId: administratorId, sessionId },
    article: {
      id: source.id,
      workspaceId: source.workspaceId,
      categoryId: source.categoryId,
      slug: source.slug,
      title,
      mdx: `# ${title}${body}\n\nThis saved operator revision remains private.`,
      isFaq: source.isFaq,
      authorName: source.authorName,
      position: source.position,
    },
    assets: { hashes: source.assetHashes },
    changeKind: "manual",
    changeSummary: "Operator revision retained across seed reconciliation",
    expectedWorkingRevisionNumber: 1,
  });
  if (saved.status !== "saved" || saved.revisionNumber !== 2) {
    throw new Error(`The operator revision failed: ${JSON.stringify(saved)}`);
  }
  const submitted = await repository.submitArticleForReview({
    actor: { memberId: administratorId, sessionId },
    articleId: source.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: saved.revisionNumber,
    note: "Review the operator-authored revision",
    revisionId: saved.revisionId,
    workspaceId: profile.workspace.id,
  });
  if (submitted.status !== "transitioned") {
    throw new Error(`The operator revision was not submitted: ${JSON.stringify(submitted)}`);
  }
}

const worker = {
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (url.pathname === "/bootstrap") {
      await bootstrap(environment, profileFrom(url));
      return json({ status: "bootstrapped" });
    }
    if (url.pathname === "/snapshot") return json(await snapshot(environment));
    if (url.pathname === "/clear") {
      await clearSeed(environment);
      return json({ status: "cleared" });
    }
    if (url.pathname === "/mutate") {
      await environment.DB.prepare(
        "update themes set name = 'Operator theme', version = version + 1",
      ).run();
      return json({ status: "mutated" });
    }
    if (url.pathname === "/edit") {
      await editSeededArticle(environment);
      return json({ status: "edited" });
    }
    if (url.pathname === "/corrupt") {
      await environment.DB.prepare(
        "update articles set title = 'Corrupted public title' where status = 'published'",
      ).run();
      return json({ status: "corrupted" });
    }
    if (url.pathname === "/pause") {
      await environment.DB.prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1,
           changed_by_member_id = ?, changed_at = ?`,
      )
        .bind(administratorId, Date.parse("2026-09-03T11:00:00.000Z"))
        .run();
      return json({ status: "paused" });
    }
    if (url.pathname === "/seed") {
      const counted = countedDatabase(environment.DB);
      const failAfter = url.searchParams.get("failAfter");
      try {
        const result = await reconcileSqliteDemoSeed(counted.database, {
          configuredSiteUrl: "https://demo.opas.dev",
          ...(failAfter === null ? {} : { failAfterStatement: Number(failAfter) }),
          profile: profileFrom(url),
        });
        return json({ ...result, batchCount: counted.batches() });
      } catch (error) {
        const detail = error as Error & { code?: string };
        return json(
          {
            batchCount: counted.batches(),
            code: detail.code ?? null,
            message: detail.message,
            name: detail.name,
          },
          409,
        );
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

export default worker;
