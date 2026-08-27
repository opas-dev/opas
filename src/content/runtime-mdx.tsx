// ABOUTME: Compiles trusted OPAS MDX through Fumadocs for the active deployment runtime.
// ABOUTME: Server-renders on Node and hands compiled code to the browser when workerd forbids eval.
import { createCompiler } from "@fumadocs/mdx-remote";

import { BrowserMdx } from "@/content/browser-mdx";
import { validateArticleMdx } from "@/content/mdx-safety";

const compiler = createCompiler({
  preset: "minimal",
  outputFormat: "function-body",
});

type RuntimeMdxProps = {
  source: string;
};

export async function RuntimeMdx({ source }: RuntimeMdxProps) {
  const validatedSource = await validateArticleMdx(source);

  if (process.env.OPAS_DATABASE_DRIVER === "d1") {
    const compiled = String(await compiler.compileFile(validatedSource));
    return <BrowserMdx compiled={compiled} />;
  }

  const { body: MdxContent } = await compiler.compile({ source: validatedSource });
  return <MdxContent />;
}
