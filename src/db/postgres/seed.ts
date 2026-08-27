// ABOUTME: Writes the deterministic OPAS demo content to a Postgres-compatible database.
// ABOUTME: Uses conflict-safe inserts so startup and deployment preparation can repeat safely.
import { getPostgresDatabase } from "@/db/postgres/client";
import { demoIds } from "@/db/demo";
import { articles, categories, workspaces } from "@/db/schema/postgres";

const runtimeMdx = `# Runtime MDX from Postgres

This article was read through **Drizzle ORM** and compiled when the request arrived.

> Update the row, refresh this page, and OPAS renders the new answer without rebuilding.

The same repository contract will serve Neon and D1.`;

export async function seedPostgres() {
  const database = getPostgresDatabase();

  await database
    .insert(workspaces)
    .values({
      id: demoIds.workspace,
      slug: "demo",
      name: "OPAS Demo",
    })
    .onConflictDoNothing();

  await database
    .insert(categories)
    .values({
      id: demoIds.category,
      workspaceId: demoIds.workspace,
      slug: "getting-started",
      name: "Getting started",
      description: "The essentials for running and shaping OPAS.",
      position: 0,
    })
    .onConflictDoNothing();

  await database
    .insert(articles)
    .values({
      id: demoIds.article,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.category,
      slug: "runtime-mdx",
      title: "Runtime MDX from Postgres",
      mdx: runtimeMdx,
      status: "published",
      publishedAt: new Date(),
    })
    .onConflictDoNothing();
}
