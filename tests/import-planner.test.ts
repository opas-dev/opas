// ABOUTME: Verifies deterministic, write-free planning for Markdown and GitBook imports.
// ABOUTME: Covers structure mapping, metadata, link rewrites, reports, and hostile inputs.
import assert from "node:assert/strict";
import test from "node:test";

import type { ArchiveFile } from "@/import/archive";
import { rewriteMarkdownLinks } from "@/import/links";
import { planKnowledgeImport } from "@/import/planner";

const encoder = new TextEncoder();

function textFile(path: string, content: string): ArchiveFile {
  return { path, content: encoder.encode(content) };
}

function binaryFile(path: string, content: readonly number[]): ArchiveFile {
  return { path, content: new Uint8Array(content) };
}

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("plans a representative GitBook export with deterministic navigation and rewrites", async () => {
  const plan = await planKnowledgeImport([
    textFile(
      ".gitbook.yaml",
      [
        "root: ./docs/",
        "structure:",
        "  readme: README.md",
        "  summary: SUMMARY.md",
        "redirects:",
        "  old-install: guides/setup/install.md",
        "",
      ].join("\n"),
    ),
    textFile("docs/README.md", "# Welcome\n\nStart here.\n"),
    textFile(
      "docs/SUMMARY.md",
      [
        "# Summary",
        "",
        "## Guides",
        "* [Welcome](README.md)",
        "* [Setup](guides/setup.md)",
        "    * [Install](guides/setup/install.md)",
        "",
        "## Reference",
        "* [API](reference/api.md)",
        "",
      ].join("\n"),
    ),
    textFile("docs/guides/setup.md", "# Setup\n\nSee [Install](setup/install.md).\n"),
    textFile(
      "docs/guides/setup/install.md",
      [
        "---",
        "title: Install OPAS",
        "slug: install-opas",
        "status: published",
        "isFaq: true",
        "authorName: Docs Team",
        "description: This field has no OPAS article equivalent.",
        "---",
        "# Install",
        "",
        "Read the [API reference](../../reference/api.md#authentication).",
        "",
        "![Dashboard](../../images/dashboard.png \"Dashboard\")",
        "",
        "# Details",
        "",
      ].join("\n"),
    ),
    textFile("docs/reference/api.md", "# API\n\nAuthenticate first.\n"),
    binaryFile("docs/images/dashboard.png", png),
    textFile("notes.md", "# Repository notes\n"),
  ]);

  assert.equal(plan.ready, true);
  assert.deepEqual(
    plan.categories.map(({ name, slug, position }) => ({ name, slug, position })),
    [
      { name: "Guides", slug: "guides", position: 0 },
      { name: "Reference", slug: "reference", position: 1 },
    ],
  );
  assert.deepEqual(
    plan.articles.map(({ sourcePath, categorySlug, slug, position }) => ({
      sourcePath,
      categorySlug,
      slug,
      position,
    })),
    [
      { sourcePath: "docs/README.md", categorySlug: "guides", slug: "readme", position: 0 },
      {
        sourcePath: "docs/guides/setup.md",
        categorySlug: "guides",
        slug: "guides-setup",
        position: 1,
      },
      {
        sourcePath: "docs/guides/setup/install.md",
        categorySlug: "guides",
        slug: "install-opas",
        position: 2,
      },
      {
        sourcePath: "docs/reference/api.md",
        categorySlug: "reference",
        slug: "reference-api",
        position: 3,
      },
    ],
  );

  const setup = plan.articles[1];
  const install = plan.articles[2];
  assert.equal(setup.mdx, "# Setup\n\nSee [Install](/guides/install-opas).\n");
  assert.equal(install.title, "Install OPAS");
  assert.equal(install.status, "draft");
  assert.equal(install.isFaq, true);
  assert.equal(install.authorName, "Docs Team");
  assert.match(install.mdx, /^# Install OPAS\n\n## Install/m);
  assert.match(install.mdx, /\[API reference\]\(\/reference\/reference-api#authentication\)/);
  assert.match(
    install.mdx,
    /!\[Dashboard\]\(\/api\/assets\/[a-f0-9]{64} "Dashboard"\)/,
  );
  assert.match(install.mdx, /\n## Details\n/);
  assert.equal((install.mdx.match(/^# /gmu) ?? []).length, 1);
  assert.equal(install.mdx.includes("description:"), false);

  assert.equal(plan.assets.length, 1);
  assert.equal(plan.assets[0].mediaType, "image/png");
  assert.equal(plan.assets[0].canonicalUrl, `/api/assets/${plan.assets[0].hash}`);
  assert.deepEqual(plan.assets[0].sourcePaths, ["docs/images/dashboard.png"]);
  assert.deepEqual(plan.redirects.find(({ source }) => source === "/old-install"), {
    source: "/old-install",
    destination: "/guides/install-opas",
    reason: "configured",
  });
  assert.ok(
    plan.report.unknownFields.some(
      ({ path, field }) => path === "docs/guides/setup/install.md" && field === "description",
    ),
  );
  assert.ok(
    plan.report.conflicts.some(
      ({ field, severity }) => field === "title" && severity === "warning",
    ),
  );
  assert.ok(
    plan.report.changes.some(
      ({ path, kind }) => path === "docs/guides/setup/install.md" && kind === "demoted-heading",
    ),
  );
  assert.ok(
    plan.report.changes.some(
      ({ path, kind }) =>
        path === "docs/guides/setup/install.md" && kind === "normalized-status",
    ),
  );
  assert.ok(
    plan.report.skippedContent.some(
      ({ path, reason }) => path === "notes.md" && reason === "outside-content-root",
    ),
  );
  assert.equal(plan.report.dryRun.sourceFiles, 8);
  assert.deepEqual(plan.report.completion, {
    status: "ready",
    categories: 2,
    articles: 4,
    assets: 1,
    redirects: plan.redirects.length,
  });
});

test("infers categories and stable full-path slugs without SUMMARY.md", async () => {
  const forward = await planKnowledgeImport([
    textFile("reference/errors/not-found.md", "# Not found\n"),
    textFile("quickstart.md", "# Quickstart\n"),
    textFile("guides/install.md", "# Install\n"),
  ]);
  const reversed = await planKnowledgeImport([
    textFile("guides/install.md", "# Install\n"),
    textFile("quickstart.md", "# Quickstart\n"),
    textFile("reference/errors/not-found.md", "# Not found\n"),
  ]);

  assert.equal(forward.ready, true);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.categories.map(({ name, slug }) => ({ name, slug })),
    [
      { name: "Guides", slug: "guides" },
      { name: "Documentation", slug: "documentation" },
      { name: "Reference", slug: "reference" },
    ],
  );
  assert.deepEqual(
    forward.articles.map(({ sourcePath, slug }) => ({ sourcePath, slug })),
    [
      { sourcePath: "guides/install.md", slug: "guides-install" },
      { sourcePath: "quickstart.md", slug: "quickstart" },
      { sourcePath: "reference/errors/not-found.md", slug: "reference-errors-not-found" },
    ],
  );
});

test("blocks duplicate normalized input paths and returns no planned writes", async () => {
  const plan = await planKnowledgeImport([
    textFile("Guides/Cafe\u0301.md", "# One\n"),
    textFile("guides/caf\u00e9.md", "# Two\n"),
  ]);

  assert.equal(plan.ready, false);
  assert.deepEqual(plan.categories, []);
  assert.deepEqual(plan.articles, []);
  assert.deepEqual(plan.assets, []);
  assert.equal(plan.report.completion.status, "blocked");
  assert.ok(plan.report.conflicts.some(({ code }) => code === "duplicate-path"));
});

test("blocks a SUMMARY.md with missing or repeated page targets", async () => {
  const cases = [
    "* [Missing](missing.md)\n",
    "* [Page](page.md)\n* [Again](page.md)\n",
  ];

  for (const summary of cases) {
    const plan = await planKnowledgeImport([
      textFile("SUMMARY.md", `# Summary\n\n${summary}`),
      textFile("page.md", "# Page\n"),
    ]);

    assert.equal(plan.ready, false);
    assert.deepEqual(plan.articles, []);
    assert.ok(
      plan.report.conflicts.some(({ code }) =>
        ["missing-summary-target", "duplicate-summary-target"].includes(code),
      ),
    );
  }
});

test("blocks malformed SUMMARY.md list entries instead of silently dropping them", async () => {
  const plan = await planKnowledgeImport([
    textFile("SUMMARY.md", "# Summary\n\n* Plain page without a target\n"),
    textFile("page.md", "# Page\n"),
  ]);

  assert.equal(plan.ready, false);
  assert.ok(
    plan.report.conflicts.some(
      ({ code, message }) =>
        code === "invalid-configuration" && message.includes("malformed list content"),
    ),
  );
});

test("rewrites parsed nested-label targets without touching escaped link literals", () => {
  const source = [
    "[outer [inner] label](guide_(one).md \"Guide\")",
    "",
    "![alt [nested]](image.png)",
    "",
    "\\[literal](not-a-link.md)",
    "",
    "![Reference image][screen]",
    "",
    "[screen]: image.png \"Screen\"",
  ].join("\n");
  const assetUrl = `/api/assets/${"a".repeat(64)}`;

  const rewritten = rewriteMarkdownLinks(source, (target) => {
    if (target === "guide_(one).md") {
      return { status: "resolved", canonicalUrl: "/guides/one" };
    }
    if (target === "image.png") {
      return { status: "resolved", canonicalUrl: assetUrl };
    }
    return { status: "missing", message: `${target} is missing.` };
  });

  assert.deepEqual(rewritten.issues, []);
  assert.ok(rewritten.markdown.includes('[outer [inner] label](/guides/one "Guide")'));
  assert.ok(rewritten.markdown.includes(`![alt [nested]](${assetUrl})`));
  assert.ok(rewritten.markdown.includes("\\[literal](not-a-link.md)"));
  assert.ok(rewritten.markdown.includes(`[screen]: ${assetUrl} "Screen"`));
});

test("retains an imported image asset linked as a download after later article saves", async () => {
  const plan = await planKnowledgeImport([
    textFile("page.md", "# Page\n\n[Download screenshot](screen.png)\n"),
    binaryFile("screen.png", png),
  ]);

  assert.equal(plan.ready, true);
  assert.equal(plan.assets.length, 1);
  assert.deepEqual(plan.articles[0].assetHashes, [plan.assets[0].hash]);
  assert.match(
    plan.articles[0].mdx,
    new RegExp(`\\[Download screenshot\\]\\(\/api\/assets\/${plan.assets[0].hash}\\)`, "u"),
  );
});

test("blocks unsupported custom HTML and MDX outside code fences", async () => {
  const sources = [
    "# Page\n\n<Callout>Unsafe</Callout>\n",
    "# Page\n\n{% hint style=\"info\" %}\nUnsafe\n{% endhint %}\n",
    "# Page\n\n{runtimeExpression}\n",
    "# Page\n\n{1 + 1}\n",
    "# Page\n\n{alert(1)}\n",
    "# Page\n\n{\"literal\"}\n",
    "# Page\n\nexport const value = 1\n",
  ];

  for (const source of sources) {
    const plan = await planKnowledgeImport([textFile("page.md", source)]);

    assert.equal(plan.ready, false);
    assert.ok(plan.report.conflicts.some(({ code }) => code === "unsupported-markup"));
  }

  const codeExample = await planKnowledgeImport([
    textFile(
      "page.md",
      "# Page\n\n```mdx\n<Callout>{runtimeExpression}</Callout>\n```\n",
    ),
  ]);
  assert.equal(codeExample.ready, true);

  const escapedExample = await planKnowledgeImport([
    textFile("page.md", "# Page\n\nUse \\{literal braces\\} in prose.\n"),
  ]);
  assert.equal(escapedExample.ready, true);
});

test("escapes title punctuation before synthesizing the article-owned H1", async () => {
  const title = "Docs [link](target) *literal* #hash";
  const plan = await planKnowledgeImport(
    [textFile("page.md", "Body without a title.\n")],
    { articleMetadata: { "page.md": { title } } },
  );

  assert.equal(plan.ready, true);
  assert.equal(plan.articles[0].title, title);
  assert.equal(
    plan.articles[0].mdx,
    "# Docs &#91;link&#93;&#40;target&#41; &#42;literal&#42; &#35;hash\n\nBody without a title.\n",
  );
});

test("blocks MIME spoofing and broken or escaping local references", async () => {
  const cases: ArchiveFile[][] = [
    [textFile("page.md", "# Page\n"), binaryFile("image.png", [0xff, 0xd8, 0xff])],
    [textFile("page.md", "# Page\n\n![Missing](missing.png)\n")],
    [
      textFile("docs/page.md", "# Page\n\n[Secret](../../secret.md)\n"),
      textFile(".gitbook.yaml", "root: docs\n"),
      textFile("secret.md", "# Secret\n"),
    ],
  ];

  for (const files of cases) {
    const plan = await planKnowledgeImport(files);

    assert.equal(plan.ready, false);
    assert.deepEqual(plan.articles, []);
    assert.ok(
      plan.report.conflicts.some(({ code }) =>
        ["mime-spoofing", "missing-link-target", "unsafe-link-target"].includes(code),
      ),
    );
  }
});

test("blocks planned and existing workspace slug conflicts deterministically", async () => {
  const duplicate = await planKnowledgeImport([
    textFile("one.md", "---\nslug: shared\n---\n# One\n"),
    textFile("two.md", "---\nslug: shared\n---\n# Two\n"),
  ]);
  const existing = await planKnowledgeImport(
    [textFile("page.md", "---\nslug: occupied\n---\n# Page\n")],
    { existingArticleSlugs: ["occupied"] },
  );

  for (const plan of [duplicate, existing]) {
    assert.equal(plan.ready, false);
    assert.deepEqual(plan.articles, []);
    assert.ok(plan.report.conflicts.some(({ code }) => code === "slug-conflict"));
  }
});

test("applies explicit metadata precedence and reports every disagreement", async () => {
  const plan = await planKnowledgeImport(
    [
      textFile("SUMMARY.md", "# Summary\n\n* [Summary title](page.md)\n"),
      textFile(
        "page.md",
        "---\ntitle: Frontmatter title\nstatus: published\nunknown: retained nowhere\n---\n# Heading title\n\nBody.\n",
      ),
    ],
    {
      articleMetadata: {
        "page.md": { title: "Operator title", status: "draft", authorName: "Migration" },
      },
    },
  );

  assert.equal(plan.ready, true);
  assert.equal(plan.articles[0].title, "Operator title");
  assert.equal(plan.articles[0].status, "draft");
  assert.equal(plan.articles[0].authorName, "Migration");
  assert.match(plan.articles[0].mdx, /^# Operator title\n/);
  assert.deepEqual(
    plan.report.unknownFields.map(({ field }) => field),
    ["unknown"],
  );
  assert.ok(plan.report.conflicts.filter(({ field }) => field === "title").length >= 3);
  assert.ok(plan.report.conflicts.some(({ field }) => field === "status"));
});
