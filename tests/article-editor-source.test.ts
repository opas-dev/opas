// ABOUTME: Verifies the lossless boundary between stored article MDX and Visual editor bodies.
// ABOUTME: Locks title ownership, supported syntax, and shared URL policy before UI integration.
import assert from "node:assert/strict";
import test from "node:test";

import {
  articleVisualBodyIssue,
  inspectArticleVisualSource,
  joinArticleSource,
  replaceArticleTitleHeading,
  serializeArticleTitle,
} from "../src/app/admin/content/article-source";
import {
  articleImageUrlIssue,
  articleLinkUrlIssue,
} from "../src/content/article-url-policy";

const supportedSource = `# Reset your password

## Before you begin

Read the [account guide](/account-guide) before continuing.

- Keep your recovery code
- Use a private device

| Step | Result |
| --- | --- |
| Open settings | Account controls appear |

\`\`\`text
plain-text recovery code
\`\`\`

![Settings screen](/api/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
`;

test("serializes title text as one safe level-one Markdown heading", () => {
  assert.equal(
    serializeArticleTitle("Reset *your* [password] # safely"),
    "# Reset \\*your\\* \\[password] # safely",
  );
});

test("splits only the title heading and rejoins a canonical full article", () => {
  const inspected = inspectArticleVisualSource(supportedSource, "Reset your password");

  assert.deepEqual(inspected, {
    status: "ready",
    body: supportedSource.slice(supportedSource.indexOf("## Before you begin")),
  });

  if (inspected.status === "ready") {
    assert.equal(joinArticleSource("Reset your password", inspected.body), supportedSource);
  }
});

test("renames the title-owned heading without changing the body", () => {
  assert.equal(
    replaceArticleTitleHeading(supportedSource, "Recover account access"),
    supportedSource.replace("# Reset your password", "# Recover account access"),
  );
});

test("uses offsets from the same BOM-free source while preserving CRLF body content", () => {
  const source =
    "\uFEFF# Reset your password\r\n\r\n## Before you begin\r\n\r\nUse `const value = { safe: true }`.\r\n\r\n```js\r\nconst options = { safe: true }\r\n```\r\n";
  const inspected = inspectArticleVisualSource(source, "Reset your password");

  assert.deepEqual(inspected, {
    status: "ready",
    body:
      "## Before you begin\r\n\r\nUse `const value = { safe: true }`.\r\n\r\n```js\r\nconst options = { safe: true }\r\n```\r\n",
  });
  assert.equal(
    replaceArticleTitleHeading(source, "Recover account access"),
    "# Recover account access\n\n## Before you begin\r\n\r\nUse `const value = { safe: true }`.\r\n\r\n```js\r\nconst options = { safe: true }\r\n```\r\n",
  );
});

test("supports the bounded Visual grammar without rewriting links, tables, code, or images", () => {
  const inspected = inspectArticleVisualSource(supportedSource, "Reset your password");

  assert.equal(inspected.status, "ready");
  if (inspected.status === "ready") {
    assert.equal(articleVisualBodyIssue(inspected.body), null);
  }
});

test("refuses later H1 headings with a precise Visual-mode message", () => {
  const inspected = inspectArticleVisualSource(
    "# Reset your password\n\n## Supported\n\n# Hidden replacement\n",
    "Reset your password",
  );

  assert.deepEqual(inspected, {
    status: "unsupported",
    message:
      "Visual mode is unavailable because the article must contain exactly one level-one heading.",
  });
});

test("refuses unsupported syntax instead of converting it", () => {
  const cases = [
    {
      body: "<details>\n<summary>Advanced</summary>\nSecret\n</details>\n",
      message: "Visual mode cannot represent raw HTML at line 1.",
    },
    {
      body: "A footnote.[^1]\n\n[^1]: More detail.\n",
      message: "Visual mode cannot represent footnotes at line 1.",
    },
    {
      body: "export const answer = 42\n",
      message: "Visual mode cannot represent MDX imports or exports at line 1.",
    },
    {
      body: "The value is {answer}.\n",
      message: "Visual mode cannot represent MDX expressions at line 1.",
    },
  ];

  for (const { body, message } of cases) {
    assert.equal(articleVisualBodyIssue(body), message);
  }
});

test("uses the same bounded URL policy for editor links and images", () => {
  for (const url of ["/guide", "../guide", "#details", "https://example.com", "mailto:help@example.com", "tel:+40123456789"]) {
    assert.equal(articleLinkUrlIssue(url), null);
  }
  for (const url of ["javascript:alert(1)", "data:text/html,boom", "java\nscript:alert(1)"]) {
    assert.match(articleLinkUrlIssue(url) ?? "", /http, https, mailto, tel, or a relative path/);
  }

  for (const url of [
    "/api/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "../images/reset.png",
    "https://cdn.example.com/reset.png",
  ]) {
    assert.equal(articleImageUrlIssue(url), null);
  }
  for (const url of ["http://example.com/reset.png", "//example.com/reset.png", "blob:unsafe", "data:image/png;base64,unsafe"]) {
    assert.match(articleImageUrlIssue(url) ?? "", /https or a relative path/);
  }
});
