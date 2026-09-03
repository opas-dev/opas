// ABOUTME: Verifies signed preview claims, bearer hygiene, scoped cookies, and exact revision reads.
// ABOUTME: Covers collision exhaustion, grant-clock matching, asset scope, and remote disclosures.

import assert from "node:assert/strict";
import test from "node:test";

import { decodeJwt, SignJWT } from "jose";

import {
  exchangeArticlePreview,
  issueArticlePreview,
  resolveArticlePreview,
  resolveArticlePreviewAsset,
  revokeArticlePreview,
  type ActiveArticlePreviewGrant,
  type ArticlePreviewAsset,
  type ArticlePreviewRepository,
  type ArticlePreviewRevision,
} from "@/auth/article-preview";
import {
  articlePreviewCookieName,
  articlePreviewCookieOptions,
  articlePreviewTokenContract,
  createArticlePreviewGrantId,
  createArticlePreviewToken,
  verifyArticlePreviewToken,
} from "@/auth/preview-claims";
import { parseArticlePreviewEnvironment } from "@/auth/preview-environment";
import { deriveAuthenticationKey } from "@/auth/security-encoding";
import {
  articlePreviewRemoteImageHosts,
  rewriteArticlePreviewAssetUrls,
} from "@/content/article-preview";

const now = new Date("2026-09-03T12:00:00.125Z");
const expiry = new Date(now.getTime() + articlePreviewTokenContract.lifetimeSeconds * 1_000);
const configuration = Object.freeze({
  deploymentId: "docs.example.test",
  signingSecret: "preview-signing-secret-with-at-least-32-bytes",
});
const actor = Object.freeze({
  memberId: "member_editor",
  sessionId: "session_editor",
  workspaceId: "workspace_demo",
});
const assetHash = "a".repeat(64);

function fixedBytes(offset = 0) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

function grant(overrides: Partial<ActiveArticlePreviewGrant> = {}): ActiveArticlePreviewGrant {
  return Object.freeze({
    articleId: "article_preview",
    createdAt: now,
    createdByMemberId: actor.memberId,
    expiresAt: expiry,
    grantId: createArticlePreviewGrantId(fixedBytes()),
    revisionId: "revision_preview_4",
    workspaceId: actor.workspaceId,
    ...overrides,
  });
}

function revision(
  record: ActiveArticlePreviewGrant,
  overrides: Partial<ArticlePreviewRevision> = {},
): ArticlePreviewRevision {
  return Object.freeze({
    ...record,
    assetHashes: [assetHash],
    authorName: "OPAS Editor",
    categoryName: "Guides",
    categorySlug: "guides",
    isFaq: false,
    mdx: `# Exact preview\n\n![Stored](/api/assets/${assetHash})\n\n![Remote](https://cdn.example.test/image.png)`,
    position: 4,
    revisionNumber: 4,
    revisionSavedAt: new Date("2026-09-03T11:58:00.000Z"),
    slug: "exact-preview",
    title: "Exact preview",
    ...overrides,
  });
}

function asset(record: ActiveArticlePreviewGrant): ArticlePreviewAsset {
  return Object.freeze({
    ...record,
    byteSize: 8,
    content: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    hash: assetHash,
    mediaType: "image/png",
  });
}

function memoryRepository() {
  let active: ActiveArticlePreviewGrant | null = null;
  let available = true;
  const rotations: unknown[] = [];
  const repository: ArticlePreviewRepository = {
    async findActiveGrant(request) {
      return available &&
        active?.grantId === request.grantId &&
        active.workspaceId === request.workspaceId &&
        active.revisionId === request.revisionId &&
        active.expiresAt.getTime() > request.checkedAt.getTime()
        ? active
        : null;
    },
    async findManagedGrant(request) {
      return available &&
        active?.workspaceId === request.actor.workspaceId &&
        active.revisionId === request.revisionId
        ? active
        : null;
    },
    async readActiveAsset(request) {
      const record = await repository.findActiveGrant(request);
      return record && request.hash === assetHash ? asset(record) : null;
    },
    async readActiveRevision(request) {
      const record = await repository.findActiveGrant(request);
      return record ? revision(record) : null;
    },
    async revokeGrant(request) {
      if (!active || active.grantId !== request.grantId) {
        return { outcome: "rejected", code: "GRANT_NOT_FOUND" };
      }
      active = null;
      return { outcome: "revoked" };
    },
    async rotateGrant(request) {
      rotations.push(request);
      active = grant({
        createdAt: request.createdAt,
        createdByMemberId: request.actor.memberId,
        expiresAt: request.expiresAt,
        grantId: request.grantId,
        revisionId: request.revisionId,
        workspaceId: request.actor.workspaceId,
      });
      return { outcome: "issued" };
    },
  };
  return {
    disable() {
      available = false;
    },
    repository,
    rotations,
  };
}

test("preview tokens carry only strict deployment and immutable revision claims", async () => {
  const grantId = createArticlePreviewGrantId(fixedBytes());
  const signed = await createArticlePreviewToken(
    {
      databaseExpiresAt: expiry,
      grantId,
      revisionId: "revision_preview_4",
      workspaceId: actor.workspaceId,
    },
    configuration.signingSecret,
    configuration.deploymentId,
    now,
  );

  assert.deepEqual(Object.keys(decodeJwt(signed.token)).sort(), [
    "aud",
    "did",
    "exp",
    "iat",
    "iss",
    "jti",
    "rid",
    "wid",
  ]);
  assert.deepEqual(
    await verifyArticlePreviewToken(
      signed.token,
      configuration.signingSecret,
      configuration.deploymentId,
      new Date(now.getTime() + 1_000),
    ),
    signed.claims,
  );
  assert.equal(
    await verifyArticlePreviewToken(
      signed.token,
      configuration.signingSecret,
      "other.example.test",
      now,
    ),
    null,
  );
  assert.equal(
    await verifyArticlePreviewToken(
      signed.token,
      "rotated-preview-secret-with-at-least-32-bytes",
      configuration.deploymentId,
      now,
    ),
    null,
  );
  assert.equal(
    await verifyArticlePreviewToken(
      `${signed.token.slice(0, -1)}${signed.token.endsWith("A") ? "B" : "A"}`,
      configuration.signingSecret,
      configuration.deploymentId,
      now,
    ),
    null,
  );
});

test("wrong algorithms and extra or mismatched claims fail closed", async () => {
  const grantId = createArticlePreviewGrantId(fixedBytes());
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = Math.floor(expiry.getTime() / 1_000);
  const key = await deriveAuthenticationKey(
    configuration.signingSecret,
    configuration.deploymentId,
    "article-preview-v1",
  );
  const extraClaim = await new SignJWT({
    did: configuration.deploymentId,
    extra: true,
    rid: "revision_preview_4",
    wid: actor.workspaceId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(articlePreviewTokenContract.issuer)
    .setAudience(articlePreviewTokenContract.audience)
    .setJti(grantId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  const wrongAudience = await new SignJWT({
    did: configuration.deploymentId,
    rid: "revision_preview_4",
    wid: actor.workspaceId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(articlePreviewTokenContract.issuer)
    .setAudience("other-preview")
    .setJti(grantId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  const wrongAlgorithmHeader = extraClaim.replace(
    /^[^.]+/u,
    Buffer.from('{"alg":"HS384","typ":"JWT"}').toString("base64url"),
  );
  const shortGrantId = await new SignJWT({
    did: configuration.deploymentId,
    rid: "revision_preview_4",
    wid: actor.workspaceId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(articlePreviewTokenContract.issuer)
    .setAudience(articlePreviewTokenContract.audience)
    .setJti("short-grant")
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);

  for (const token of [
    extraClaim,
    wrongAudience,
    wrongAlgorithmHeader,
    shortGrantId,
    `${extraClaim}=`,
  ]) {
    assert.equal(
      await verifyArticlePreviewToken(
        token,
        configuration.signingSecret,
        configuration.deploymentId,
        now,
      ),
      null,
    );
  }
});

test("preview configuration and cookie stay deployment-specific and host-only", () => {
  assert.deepEqual(
    parseArticlePreviewEnvironment({
      OPAS_PREVIEW_SIGNING_SECRET: configuration.signingSecret,
      OPAS_SITE_URL: "https://docs.example.test",
    }),
    configuration,
  );
  assert.throws(
    () =>
      parseArticlePreviewEnvironment({
        OPAS_PREVIEW_SIGNING_SECRET: "short",
        OPAS_SITE_URL: "https://docs.example.test",
      }),
    /at least 32 bytes/u,
  );
  assert.notEqual(
    articlePreviewCookieName("docs.example.test"),
    articlePreviewCookieName("cro.example.test"),
  );
  const options = articlePreviewCookieOptions(expiry, expiry, now);
  assert.deepEqual(options, {
    expires: new Date("2026-09-10T12:00:00.000Z"),
    httpOnly: true,
    maxAge: 604_800,
    path: "/preview",
    priority: "high",
    sameSite: "lax",
    secure: true,
  });
  assert.equal("domain" in options, false);
  const shorterDatabaseExpiry = new Date(now.getTime() + 5_125);
  assert.equal(
    articlePreviewCookieOptions(expiry, shorterDatabaseExpiry, now).maxAge,
    5,
  );
});

test("issuance stores no bearer and resolves only the exact durable revision", async () => {
  const harness = memoryRepository();
  const issued = await issueArticlePreview(
    actor,
    "revision_preview_4",
    configuration,
    { clock: () => now, randomBytes: fixedBytes(), repository: harness.repository },
  );
  assert.equal(issued.outcome, "issued");
  if (issued.outcome !== "issued") return;
  assert.equal(JSON.stringify(harness.rotations).includes(issued.token), false);

  const exchanged = await exchangeArticlePreview(issued.token, configuration, {
    clock: () => new Date(now.getTime() + 1_000),
    repository: harness.repository,
  });
  assert.ok(exchanged);
  assert.equal(exchanged.claims.revisionId, "revision_preview_4");

  const document = await resolveArticlePreview(issued.token, configuration, {
    clock: () => new Date(now.getTime() + 1_000),
    repository: harness.repository,
  });
  assert.ok(document);
  assert.equal(document.revisionNumber, 4);
  assert.match(document.mdx, new RegExp(`/preview/assets/${assetHash}`, "u"));
  assert.doesNotMatch(document.mdx, /\/api\/assets\//u);
  assert.deepEqual(document.remoteImageHosts, ["cdn.example.test"]);

  assert.equal(
    await resolveArticlePreviewAsset(
      issued.token,
      "b".repeat(64),
      configuration,
      { clock: () => new Date(now.getTime() + 1_000), repository: harness.repository },
    ),
    null,
  );
  assert.equal(
    (
      await resolveArticlePreviewAsset(
        issued.token,
        assetHash,
        configuration,
        { clock: () => new Date(now.getTime() + 1_000), repository: harness.repository },
      )
    )?.hash,
    assetHash,
  );

  harness.disable();
  assert.equal(
    await resolveArticlePreview(issued.token, configuration, {
      clock: () => new Date(now.getTime() + 2_000),
      repository: harness.repository,
    }),
    null,
  );
});

test("token and database grant clocks must match exactly", async () => {
  const record = grant();
  const signed = await createArticlePreviewToken(
    {
      databaseExpiresAt: record.expiresAt,
      grantId: record.grantId,
      revisionId: record.revisionId,
      workspaceId: record.workspaceId,
    },
    configuration.signingSecret,
    configuration.deploymentId,
    now,
  );
  const mismatchedRepository = memoryRepository();
  await mismatchedRepository.repository.rotateGrant({
    actor,
    createdAt: new Date(now.getTime() + 1_000),
    expiresAt: new Date(expiry.getTime() + 1_000),
    grantId: record.grantId,
    revisionId: record.revisionId,
  });
  assert.equal(
    await exchangeArticlePreview(signed.token, configuration, {
      clock: () => new Date(now.getTime() + 2_000),
      repository: mismatchedRepository.repository,
    }),
    null,
  );
});

test("grant ID collision exhaustion is bounded and never returns a bearer", async () => {
  let attempts = 0;
  const repository: ArticlePreviewRepository = {
    ...memoryRepository().repository,
    async rotateGrant() {
      attempts += 1;
      return { outcome: "rejected", code: "GRANT_ID_COLLISION" } as const;
    },
  };
  assert.deepEqual(
    await issueArticlePreview(actor, "revision_preview_4", configuration, {
      clock: () => now,
      randomBytes: fixedBytes(),
      repository,
    }),
    { outcome: "rejected", code: "GRANT_ID_COLLISION_EXHAUSTED" },
  );
  assert.equal(attempts, 3);
});

test("revocation removes the current token without depending on the authoring fence", async () => {
  const harness = memoryRepository();
  const issued = await issueArticlePreview(
    actor,
    "revision_preview_4",
    configuration,
    { clock: () => now, repository: harness.repository },
  );
  assert.equal(issued.outcome, "issued");
  if (issued.outcome !== "issued") return;
  assert.deepEqual(
    await revokeArticlePreview(actor, issued.grantId, {
      clock: () => new Date(now.getTime() + 1_000),
      repository: harness.repository,
    }),
    { outcome: "revoked" },
  );
  assert.equal(
    await exchangeArticlePreview(issued.token, configuration, {
      clock: () => new Date(now.getTime() + 2_000),
      repository: harness.repository,
    }),
    null,
  );
});

test("rewriting touches only parsed canonical asset destinations", () => {
  const source = `# Asset references

The text /api/assets/${assetHash} is not a link.

[/api/assets/${assetHash}](/api/assets/${assetHash})

![Stored][asset]

[asset]: /api/assets/${assetHash}

![Remote](https://img.example.test/a.png)
![Remote two][remote]
[remote]: https://img.example.test/b.png
`;
  const rewritten = rewriteArticlePreviewAssetUrls(source);
  assert.match(rewritten, new RegExp(`The text /api/assets/${assetHash}`, "u"));
  assert.match(
    rewritten,
    new RegExp(`\\[/api/assets/${assetHash}\\]\\(/preview/assets/${assetHash}\\)`, "u"),
  );
  assert.match(rewritten, new RegExp(`\\[asset\\]: /preview/assets/${assetHash}`, "u"));
  assert.deepEqual(articlePreviewRemoteImageHosts(source), ["img.example.test"]);
});
