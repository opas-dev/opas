// ABOUTME: Verifies the shared article syntax and executable-code safety contract.
// ABOUTME: Guards GFM parity plus component, expression, module, heading, and URL policies.
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ArticleMdxValidationError,
  validateArticleMdx,
} from "@/content/mdx-safety";
import {
  articleMdxCompiler,
  parseArticleMarkdown,
} from "@/content/runtime-mdx-plugins";

async function rejectsArticleMdx(source: string, message: RegExp) {
  await assert.rejects(validateArticleMdx(source), (error: unknown) => {
    assert.ok(error instanceof ArticleMdxValidationError);
    assert.match(error.message, message);
    return true;
  });
}

test("ordinary Markdown is preserved without interpreting code samples", async () => {
  const source = `# Reset your password

Follow the **account recovery** steps in [the guide](/guides/recovery).

\`const example = globalThis.location\`

\`\`\`tsx
import Unsafe from "remote-package";
export const value = <Unsafe run={globalThis.alert(1)} />;
\`\`\`
`;

  assert.equal(await validateArticleMdx(source), source);
});

test("the shared syntax contract gives Node and browser compilation identical GFM tables", async () => {
  const source = `# Support matrix

| Channel | Available |
| :-- | --: |
| Email | Yes |
| Phone | No |
`;
  const tree = parseArticleMarkdown(source);
  const table = tree.children.find((node) => node.type === "table");

  assert.ok(table);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(await validateArticleMdx(source, "Support matrix"), source);

  const compiler = await articleMdxCompiler;
  const { body: NodeArticle } = await compiler.compile({ source });
  const nodeHtml = renderToStaticMarkup(await NodeArticle({}));
  const compiled = String(await compiler.compileFile(source));
  const { default: BrowserArticle } = await compiler.render(compiled);
  const browserHtml = renderToStaticMarkup(await BrowserArticle({}));

  assert.equal(browserHtml, nodeHtml);
  assert.match(nodeHtml, /<table>/u);
  assert.match(nodeHtml, /<th style="text-align:left">Channel<\/th>/u);
  assert.match(nodeHtml, /<td style="text-align:right">Yes<\/td>/u);
});

test("title validation rejects missing, displaced, mismatched, and secondary H1 headings", async () => {
  const bomSource = "\uFEFF# Support matrix\r\n\r\nAnswer.\r\n";
  assert.equal(await validateArticleMdx(bomSource, "Support matrix"), bomSource);

  const cases = [
    {
      source: "## Support matrix\n\nNo title heading.",
      message: /exactly one level-one heading/u,
    },
    {
      source: "## Before the title\n\n# Support matrix",
      message: /first content block/u,
    },
    {
      source: "Intro before the title.\n\n# Support matrix",
      message: /first content block/u,
    },
    {
      source: "# Another title\n\nAnswer.",
      message: /exactly match the article title/u,
    },
    {
      source: "# Support matrix\n\nAnswer.\n\n# Another title",
      message: /exactly one level-one heading/u,
    },
  ];

  for (const { source, message } of cases) {
    await assert.rejects(validateArticleMdx(source, "Support matrix"), message);
  }
});

test("module imports and exports are rejected", async () => {
  for (const source of [
    'import Widget from "remote-package"\n\n# Article',
    "export const metadata = { trusted: false }",
    "export default function Article() {}",
  ]) {
    await rejectsArticleMdx(source, /Imports and exports are not allowed/);
  }
});

test("inline and block JavaScript expressions are rejected", async () => {
  for (const source of [
    "Hello {globalThis.process}",
    "{globalThis.fetch('https://example.com')}\n",
    "{(() => 'computed')()}",
  ]) {
    await rejectsArticleMdx(source, /JavaScript expressions are not allowed/);
  }
});

test("JSX properties cannot smuggle JavaScript execution", async () => {
  for (const source of [
    "<Widget value={globalThis.process} />",
    "<Widget {...globalThis.process.env} />",
  ]) {
    await rejectsArticleMdx(source, /JavaScript component properties are not allowed/);
  }
});

test("the empty component allowlist rejects custom, intrinsic, and fragment JSX", async () => {
  for (const source of [
    '<Callout tone="info">Important</Callout>',
    '<div className="notice">Important</div>',
    "<>Important</>",
  ]) {
    await rejectsArticleMdx(source, /component is not allowed/);
  }
});

test("links and images accept policy-compatible URLs and reject unsafe protocols", async () => {
  const safeSource = `See [recovery](/guides/recovery), [support](mailto:help@example.com),
[local service](http://localhost:3000),
and ![the OPAS mark](https://cdn.example.com/opas.png).`;
  assert.equal(await validateArticleMdx(safeSource), safeSource);

  for (const source of [
    "[run this](javascript:alert(1))",
    "[run this](java&#x09;script:alert(1))",
    "[run this][payload]\n\n[payload]: javascript:alert(1)",
    "![embedded payload](data:image/svg+xml,<svg></svg>)",
    "![embedded payload][payload]\n\n[payload]: data:image/svg+xml,<svg></svg>",
    "![embedded payload][payload]\n\n[payload]: mailto:help@example.com",
    "![insecure image](http://cdn.example.com/opas.png)",
    "![insecure image][payload]\n\n[payload]: http://cdn.example.com/opas.png",
    "![origin-dependent image](//cdn.example.com/opas.png)",
  ]) {
    await rejectsArticleMdx(source, /protocol is not allowed/);
  }
});

test("frontmatter is rejected so every target uses database metadata", async () => {
  await rejectsArticleMdx(
    "---\ntitle: Conflicting title\n---\n\n# Article",
    /Frontmatter is not allowed/,
  );
});

test("invalid MDX is normalized to the typed validation error", async () => {
  await rejectsArticleMdx("<Unclosed>", /Article MDX could not be parsed/);
});
