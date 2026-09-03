// ABOUTME: Runs immutable draft creation and save races against a native local D1 binding.
// ABOUTME: Exposes one deterministic acceptance endpoint for the D1 repository batch path.
import { drizzle } from "drizzle-orm/d1";

import { createSqliteArticleDraftRepository } from "../../../src/db/sqlite/article-draft-repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";
import * as schema from "../../../src/db/schema/sqlite";

type Environment = Readonly<{ DB: D1Database }>;

const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_d1_drafts";
const ownerMemberId = "member_d1_owner";
const memberId = "member_d1_editor";
const sessionId = "S".repeat(43);

function request(id: string, slug: string, title: string) {
  return {
    actor: { memberId, sessionId },
    article: {
      id,
      workspaceId,
      categoryId: "category_d1_guides",
      slug,
      title,
      mdx: `# ${title}\n\nPrivate D1 content.`,
      isFaq: false,
      authorName: "D1 Editor",
      position: 0,
    },
    assets: { hashes: [] },
    changeKind: "manual" as const,
  };
}

async function setup(environment: Environment) {
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'd1-drafts', 'D1 drafts', ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'owner@d1.test', 'Owner', 'administrator', 'active',
                   ?, ?, 600000, ?, ?)`,
      )
      .bind(
        ownerMemberId,
        workspaceId,
        "A".repeat(43),
        "B".repeat(43),
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@d1.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        ownerMemberId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, workspaceId, memberId, timestamp, timestamp + 3_600_000),
    environment.DB
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values ('category_d1_guides', ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
  ]);
  await environment.DB.batch(
    sqliteTeamAuthoringGuardStatements.map((source) => environment.DB.prepare(source)),
  );
}

async function exercise(environment: Environment) {
  const repository = createSqliteArticleDraftRepository(
    drizzle(environment.DB, { schema }),
    { clock: () => new Date(timestamp) },
  );
  const initial = await repository.createDraftArticle(
    request("article_d1_primary", "d1-primary", "D1 initial"),
  );
  const race = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repository.saveDraftArticle({
        ...request("article_d1_primary", "d1-primary", `D1 race ${index}`),
        expectedWorkingRevisionNumber: 1,
      }),
    ),
  );
  const secondRequest = {
    ...request("article_d1_primary", "d1-second", "D1 second"),
    expectedWorkingRevisionNumber: 2,
  };
  const second = await repository.saveDraftArticle(secondRequest);
  const unchanged = await repository.saveDraftArticle({
    ...secondRequest,
    expectedWorkingRevisionNumber: 3,
  });
  const invalidRevision = await repository.saveDraftArticle({
    ...secondRequest,
    expectedWorkingRevisionNumber: 0,
  });
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 1, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();
  let pausedCode: string | null = null;
  try {
    await repository.saveDraftArticle({
      ...request("article_d1_primary", "d1-paused", "D1 paused"),
      expectedWorkingRevisionNumber: 3,
    });
  } catch (error) {
    pausedCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : String(error);
  }
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 0, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();

  await repository.createDraftArticle(request("article_d1_a", "d1-a", "D1 A"));
  await repository.createDraftArticle(request("article_d1_b", "d1-b", "D1 B"));
  const slugRace = await Promise.all([
    repository.saveDraftArticle({
      ...request("article_d1_a", "d1-shared", "D1 A saved"),
      expectedWorkingRevisionNumber: 1,
    }),
    repository.saveDraftArticle({
      ...request("article_d1_b", "d1-shared", "D1 B saved"),
      expectedWorkingRevisionNumber: 1,
    }),
  ]);
  const revisionCount = await environment.DB
    .prepare(
      `select count(*) as count from article_revisions
       where workspace_id = ? and article_id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first<number>("count");
  const head = await environment.DB
    .prepare(
      `select working_revision_number, working_slug from article_heads
       where workspace_id = ? and article_id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first();
  return {
    initial,
    race,
    second,
    unchanged,
    invalidRevision,
    pausedCode,
    slugRace,
    revisionCount,
    head,
  };
}

export default {
  async fetch(request: Request, environment: Environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ready");
    try {
      if (pathname === "/setup") {
        await setup(environment);
        return Response.json({ setup: true });
      }
      if (pathname === "/exercise") return Response.json(await exercise(environment));
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Environment>;
