// ABOUTME: Verifies database-backed named-member authorization and exact protected-entry capabilities.
// ABOUTME: Covers forged, stale, disabled, wrong-workspace, and role-changed direct requests.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  AuthorizationError,
  capabilities,
  hasCapability,
  teamRoles,
  type Capability,
  type TeamRole,
} from "@/auth/capabilities";
import {
  createDatabaseSessionToken,
  databaseSessionCookieName,
} from "@/auth/database-session";
import {
  authorizeMemberRequest,
  authorizeMemberSession,
  MemberSessionError,
} from "@/auth/member-authorization";
import type {
  ActiveMemberSession,
  MemberRepository,
  MemberSessionLookup,
} from "@/auth/member-repository";
import { parseAdminSessionEnvironment } from "@/auth/session-environment";

const sessionSecret = "named-member-session-secret-with-32-bytes";
const otherSessionSecret = "other-named-member-secret-with-32-bytes";
const deploymentId = "docs.example.com";
const workspaceId = "workspace_demo";
const memberId = "member_1";
const sessionId = "S".repeat(43);
const issuedAt = new Date("2026-09-03T10:00:00.000Z");
const checkedAt = new Date(issuedAt.getTime() + 1_000);

function activeMember(role: TeamRole): ActiveMemberSession {
  return Object.freeze({
    displayName: "Named Member",
    email: "member@example.com",
    expiresAt: new Date(issuedAt.getTime() + 8 * 60 * 60 * 1_000),
    memberId,
    role,
    sessionId,
    workspaceId,
  });
}

function repositoryWithSession(
  findActiveSession: (
    request: MemberSessionLookup,
  ) => Promise<ActiveMemberSession | null>,
): MemberRepository {
  return { findActiveSession } as MemberRepository;
}

async function signedToken(
  options: Readonly<{
    deploymentId?: string;
    issuedAt?: Date;
    sessionSecret?: string;
    workspaceId?: string;
  }> = {},
) {
  const tokenIssuedAt = options.issuedAt ?? issuedAt;
  return (
    await createDatabaseSessionToken(
      {
        databaseExpiresAt: new Date(
          tokenIssuedAt.getTime() + 8 * 60 * 60 * 1_000,
        ),
        memberId,
        sessionId,
        workspaceId: options.workspaceId ?? workspaceId,
      },
      options.sessionSecret ?? sessionSecret,
      options.deploymentId ?? deploymentId,
      tokenIssuedAt,
    )
  ).token;
}

function authorizationRequest(token: string | undefined, capability: Capability) {
  return {
    capability,
    checkedAt,
    deploymentId,
    sessionSecret,
    token,
    workspaceId,
  } as const;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
  });
}

test("every role is authorized from current database state for exactly its capabilities", async () => {
  const token = await signedToken();

  for (const role of teamRoles) {
    const member = activeMember(role);
    const repository = repositoryWithSession(async () => member);

    for (const capability of capabilities) {
      const authorization = authorizeMemberSession(
        authorizationRequest(token, capability),
        repository,
      );

      if (hasCapability(role, capability)) {
        assert.deepEqual(await authorization, member, `${role}: ${capability}`);
      } else {
        await assert.rejects(
          authorization,
          (error: unknown) =>
            error instanceof AuthorizationError &&
            error.code === "CAPABILITY_REQUIRED",
          `${role}: ${capability}`,
        );
      }
    }
  }
});

test("strict claims fail before the authoritative session lookup", async () => {
  let lookupCount = 0;
  const repository = repositoryWithSession(async () => {
    lookupCount += 1;
    return activeMember("administrator");
  });
  const validToken = await signedToken();
  const segments = validToken.split(".");
  const changedSignature = `${segments[2]?.startsWith("a") ? "b" : "a"}${segments[2]?.slice(1)}`;
  const forgedToken = [segments[0], segments[1], changedSignature].join(".");
  const staleIssuedAt = new Date(issuedAt.getTime() - 9 * 60 * 60 * 1_000);
  const staleToken = await signedToken({ issuedAt: staleIssuedAt });
  const wrongSecretToken = await signedToken({ sessionSecret: otherSessionSecret });
  const wrongWorkspaceToken = await signedToken({ workspaceId: "workspace_other" });

  for (const token of [
    undefined,
    "not-a-token",
    forgedToken,
    staleToken,
    wrongSecretToken,
    wrongWorkspaceToken,
  ]) {
    await assert.rejects(
      authorizeMemberSession(
        authorizationRequest(token, "content:read"),
        repository,
      ),
      MemberSessionError,
    );
  }

  assert.equal(lookupCount, 0);
});

test("disabled, revoked, and database-expired sessions stop direct requests", async () => {
  const token = await signedToken();

  for (const rejectedState of ["disabled member", "revoked session", "expired session"]) {
    let protectedReadStarted = false;
    const repository = repositoryWithSession(async (request) => {
      assert.deepEqual(request, {
        checkedAt,
        memberId,
        sessionId,
        workspaceId,
      });
      return null;
    });

    await assert.rejects(
      (async () => {
        await authorizeMemberSession(
          authorizationRequest(token, "content:read"),
          repository,
        );
        protectedReadStarted = true;
      })(),
      MemberSessionError,
      rejectedState,
    );
    assert.equal(protectedReadStarted, false, rejectedState);
  }
});

test("the same signed token immediately observes a database role change", async () => {
  const token = await signedToken();
  let currentRole: TeamRole = "administrator";
  const repository = repositoryWithSession(async () => activeMember(currentRole));

  assert.equal(
    (
      await authorizeMemberSession(
        authorizationRequest(token, "workspace:configure"),
        repository,
      )
    ).role,
    "administrator",
  );

  currentRole = "reviewer";
  await assert.rejects(
    authorizeMemberSession(
      authorizationRequest(token, "workspace:configure"),
      repository,
    ),
    (error: unknown) =>
      error instanceof AuthorizationError && error.code === "CAPABILITY_REQUIRED",
  );
  assert.equal(
    (
      await authorizeMemberSession(
        authorizationRequest(token, "content:read"),
        repository,
      )
    ).role,
    "reviewer",
  );
});

test("route authorization reads its supplied request outside ambient Next request scope", async () => {
  const token = await signedToken();
  const request = new NextRequest("https://docs.example.com/admin/content/preview", {
    headers: {
      cookie: `${databaseSessionCookieName(deploymentId)}=${token}`,
    },
    method: "POST",
  });
  const member = activeMember("editor");
  const repository = repositoryWithSession(async () => member);

  const authorized = await Promise.all(
    Array.from({ length: 4 }, async () => {
      await Promise.resolve();
      return authorizeMemberRequest(
        request,
        {
          capability: "content:read",
          checkedAt,
          deploymentId,
          sessionSecret,
          workspaceId,
        },
        repository,
      );
    }),
  );

  assert.deepEqual(authorized, [member, member, member, member]);
});

test("live preview binds authorization to the route request object", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/app/admin/content/preview/route.ts"),
    "utf8",
  );

  assert.match(source, /POST\(request: NextRequest\)/u);
  assert.match(
    source,
    /requireMemberRequestCapability\(\s*request,\s*"content:read",\s*demoIds\.workspace,?\s*\)/u,
  );
  assert.doesNotMatch(source, /requireMemberCapability\(/u);
});

test("the administrator runtime maps capability denial to a concealed not-found response", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/auth/admin.ts"),
    "utf8",
  );

  assert.match(
    source,
    /error instanceof AuthorizationError[\s\S]*?notFound\(\)/u,
  );
});

test("session configuration derives one canonical deployment hostname and fails closed", () => {
  assert.deepEqual(
    parseAdminSessionEnvironment({
      ADMIN_SESSION_SECRET: sessionSecret,
      OPAS_SITE_URL: "https://Docs.Example.com:8443",
    }),
    { deploymentId, sessionSecret },
  );

  for (const OPAS_SITE_URL of [
    "https://bad_host.example.com",
    `https://${"a".repeat(64)}.test`,
  ]) {
    assert.throws(
      () =>
        parseAdminSessionEnvironment({
          ADMIN_SESSION_SECRET: sessionSecret,
          OPAS_SITE_URL,
        }),
      /INVALID_DEPLOYMENT_ID/u,
    );
  }
});

test("every protected entry point requests its exact capability", () => {
  const expectedCapabilities = {
    "src/app/admin/actions.ts": ["content:read"],
    "src/app/admin/analytics/page.tsx": ["content:read"],
    "src/app/admin/content/actions.ts": [
      "category:manage",
      "category:manage",
      "draft:edit",
      "review:decide",
    ],
    "src/app/admin/content/articles/[id]/history/[revisionNumber]/[revisionId]/page.tsx": [
      "content:read",
    ],
    "src/app/admin/content/articles/[id]/history/[revisionNumber]/page.tsx": [
      "content:read",
    ],
    "src/app/admin/content/articles/[id]/history/page.tsx": ["content:read"],
    "src/app/admin/content/articles/[id]/page.tsx": ["content:read"],
    "src/app/admin/content/articles/new/page.tsx": ["draft:edit"],
    "src/app/admin/content/assets/[hash]/route.ts": ["content:read"],
    "src/app/admin/content/assets/route.ts": ["draft:edit", "draft:edit"],
    "src/app/admin/content/import/page.tsx": ["import:run"],
    "src/app/admin/content/import/run/route.ts": ["import:run"],
    "src/app/admin/content/page.tsx": ["content:read"],
    "src/app/admin/content/preview/route.ts": ["content:read"],
    "src/app/admin/page.tsx": ["content:read"],
    "src/app/admin/quality/export/route.ts": ["content:read"],
    "src/app/admin/quality/import/route.ts": ["quality:manage"],
    "src/app/admin/quality/page.tsx": ["content:read"],
    "src/app/admin/quality/playground/route.ts": ["quality:manage"],
    "src/app/admin/quality/replay/route.ts": ["quality:manage"],
    "src/app/admin/quality/review/route.ts": ["quality:manage"],
    "src/app/admin/quality/run/route.ts": ["quality:manage"],
    "src/app/admin/team/actions.ts": ["member:manage", "member:manage"],
    "src/app/admin/team/page.tsx": ["member:manage"],
    "src/app/admin/theme/actions.ts": ["workspace:configure"],
    "src/app/admin/theme/page.tsx": ["workspace:configure"],
  } satisfies Record<string, readonly Capability[]>;

  const actualEntryFiles = filesUnder(
    path.join(process.cwd(), "src/app/admin"),
  )
    .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
    .filter(
      (file) =>
        !file.includes("/admin/login/") &&
        !file.includes("/admin/accept/") &&
        (file.endsWith("/actions.ts") ||
          file.endsWith("/page.tsx") ||
          file.endsWith("/route.ts")),
    )
    .sort();
  assert.deepEqual(actualEntryFiles, Object.keys(expectedCapabilities).sort());

  for (const [file, expected] of Object.entries(expectedCapabilities)) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    const actual = [...source.matchAll(
      /requireMember(?:Request)?Capability\(\s*(?:request\s*,\s*)?"([^"]+)"\s*,\s*demoIds\.workspace,?\s*\)/gu,
    )].map((match) => match[1]);
    assert.deepEqual(actual, expected, file);
    assert.doesNotMatch(source, /requireAdmin/u, file);
  }

  const contentActions = readFileSync(
    path.join(process.cwd(), "src/app/admin/content/actions.ts"),
    "utf8",
  );
  for (const [action, capability, intent] of [
    ["submitArticleForReviewAction", "review:submit", "submit"],
    ["withdrawArticleReviewAction", "review:submit", "withdraw"],
    ["requestArticleChangesAction", "review:decide", "requestChanges"],
    ["approveArticleRevisionAction", "review:decide", "approve"],
    [
      "approveAndPublishArticleRevisionAction",
      "publication:publish",
      "approveAndPublish",
    ],
    ["publishArticleRevisionAction", "publication:publish", "publish"],
    [
      "emergencyPublishArticleAction",
      "publication:emergency-publish",
      "emergencyPublish",
    ],
    ["unpublishArticleAction", "article:retire", "unpublish"],
  ] as const) {
    assert.match(
      contentActions,
      new RegExp(
        `export async function ${action}\\b[\\s\\S]*?articleWorkflowAction\\(\\s*"${capability}",\\s*"${intent}"`,
        "u",
      ),
      action,
    );
  }
});
