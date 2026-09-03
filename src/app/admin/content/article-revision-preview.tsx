// ABOUTME: Compiles one immutable historical revision for authenticated read-only viewing.
// ABOUTME: Rewrites retained asset paths through the protected admin asset endpoint.

import { BrowserMdx } from "@/content/browser-mdx";
import { validateArticleMdx } from "@/content/mdx-safety";
import { articleMdxCompiler } from "@/content/runtime-mdx-plugins";

export async function ArticleRevisionPreview({
  source,
  title,
}: Readonly<{ source: string; title: string }>) {
  let compiled: string;
  try {
    const validatedSource = await validateArticleMdx(source, title);
    const compiler = await articleMdxCompiler;
    compiled = String(await compiler.compileFile(validatedSource));
  } catch {
    return (
      <p className="m-0 text-sm leading-6 text-muted" role="status">
        This historical source does not meet the current rendering rules. Its escaped source is
        still available in the comparison below.
      </p>
    );
  }
  return <BrowserMdx authenticatedAssets compiled={compiled} />;
}
