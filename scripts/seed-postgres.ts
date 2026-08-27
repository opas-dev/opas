// ABOUTME: Seeds the Postgres target with the deterministic OPAS demo workspace and article.
// ABOUTME: Uses conflict-safe inserts so first boot and repeat deployments share one command.
import { postgresDb, postgresPool } from "../src/db/postgres/client";
import { demoIds } from "../src/db/demo";
import { articles, categories, workspaces } from "../src/db/schema/postgres";

const runtimeMdx = `# Runtime MDX from Postgres

This article was read through **Drizzle ORM** and compiled when the request arrived.

> Update the row, refresh this page, and OPAS renders the new answer without rebuilding.

The same repository contract will serve Neon and D1.`;

async function seed() {
  await postgresDb
    .insert(workspaces)
    .values({
      id: demoIds.workspace,
      slug: "demo",
      name: "OPAS Demo",
    })
    .onConflictDoNothing();

  await postgresDb
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

  await postgresDb
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

async function main() {
  try {
    await seed();
    console.info("Seeded the OPAS Postgres demo content.");
  } finally {
    await postgresPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
