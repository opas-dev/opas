// ABOUTME: Proves that OPAS can compile remote MDX content during a live request.
// ABOUTME: Reads a source file dynamically until the database replaces it in the next spike.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCompiler } from "@fumadocs/mdx-remote";
import Link from "next/link";
import { connection } from "next/server";

export const runtime = "nodejs";

const compiler = createCompiler({
  preset: "minimal",
  outputFormat: "function-body",
});

export default async function RuntimeMdxPage() {
  await connection();

  const source = await readFile(resolve(process.cwd(), "content/spike.mdx"), "utf8");
  const { body: MdxContent } = await compiler.compile({ source });

  return (
    <main className="article-shell">
      <nav className="article-nav" aria-label="Breadcrumb">
        <Link href="/">OPAS</Link>
        <span aria-hidden="true">/</span>
        <span>Runtime spike</span>
      </nav>
      <article className="article-content">
        <MdxContent />
      </article>
    </main>
  );
}
