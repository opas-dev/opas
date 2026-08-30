// ABOUTME: Verifies that article attachment selection comes only from real canonical asset nodes.
// ABOUTME: Locks linked and embedded asset lifecycle plus reserved image URL validation.
import assert from "node:assert/strict";
import test from "node:test";

import { authenticatedAssetUrl } from "../src/assets/identity";
import { referencedArticleAssetHashes } from "../src/content/article-assets";
import {
  articleAssetHash,
  articleImageUrlIssue,
} from "../src/content/article-url-policy";

const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);

test("derives sorted unique hashes only from canonical Markdown asset nodes", () => {
  const source = `# Asset references

![Second](/api/assets/${secondHash})

[A normal link](/api/assets/${firstHash})

\`/api/assets/${firstHash}\`

![First][SCREENSHOT]
![First again][screenshot]

[screenshot]: /api/assets/${firstHash}
[unused]: /api/assets/${"c".repeat(64)}
`;

  assert.deepEqual(referencedArticleAssetHashes(source), [firstHash, secondHash]);
});

test("keeps direct and reference-style linked assets attached", () => {
  assert.deepEqual(
    referencedArticleAssetHashes(`# Downloads

[Direct download](/api/assets/${secondHash})
[Reference download][download]

[download]: /api/assets/${firstHash}
`),
    [firstHash, secondHash],
  );
});

test("does not turn external and ordinary relative images into stored attachments", () => {
  assert.deepEqual(
    referencedArticleAssetHashes(`
# Other images

![Remote](https://cdn.example.com/image.png)
![Relative](../images/image.png)
![Malformed](/api/assets/not-a-hash)
`),
    [],
  );
});

test("uses the first duplicate image definition like the Markdown renderer", () => {
  assert.deepEqual(
    referencedArticleAssetHashes(`# Duplicate definitions

![Screenshot][screen]

[screen]: /api/assets/${firstHash}
[screen]: /api/assets/${secondHash}
`),
    [firstHash],
  );
});

test("recognizes only exact lowercase content-addressed asset URLs", () => {
  assert.equal(articleAssetHash(`/api/assets/${firstHash}`), firstHash);
  assert.equal(articleAssetHash(`/api/assets/${firstHash}?download=1`), null);
  assert.equal(articleAssetHash(`/api/assets/${firstHash.toUpperCase()}`), null);
  assert.equal(articleAssetHash(`/api/assets/${firstHash}/extra`), null);
});

test("uses an authenticated rendering URL without changing canonical Markdown", () => {
  assert.equal(
    authenticatedAssetUrl(`/api/assets/${firstHash}`),
    `/admin/content/assets/${firstHash}`,
  );
  assert.equal(
    authenticatedAssetUrl("https://cdn.example.com/image.png"),
    "https://cdn.example.com/image.png",
  );
});

test("rejects malformed reserved asset URLs and ephemeral browser image sources", () => {
  for (const value of [
    `/api/assets/${firstHash}?download=1`,
    `/api/assets/${firstHash.toUpperCase()}`,
    "/api/assets/not-a-hash",
  ]) {
    assert.match(articleImageUrlIssue(value) ?? "", /exact content-addressed URL/);
  }

  for (const value of ["blob:https://opas.dev/temporary", "data:image/png;base64,AAAA"]) {
    assert.match(articleImageUrlIssue(value) ?? "", /https or a relative path/);
  }
});
