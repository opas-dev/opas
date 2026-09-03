// ABOUTME: Verifies fragment-exchanged member invitations and credential resets end to end.
// ABOUTME: Covers same-origin boundaries, scoped cookies, replay, expiry, and bearer hygiene.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  acceptMemberLink,
  exchangeMemberLink,
  parseMemberAcceptanceKind,
  resolveMemberAcceptance,
} from "@/auth/member-acceptance";
import {
  handleMemberAcceptanceCompletion,
  handleMemberAcceptanceSession,
  handleMemberLinkExchange,
} from "@/auth/member-acceptance-http";
import {
  createMemberLinkBearer,
  digestMemberLinkBearer,
  memberLinkAcceptanceCookieName,
  type MemberLinkKind,
} from "@/auth/member-link-claims";
import type {
  ActiveMemberInvitation,
  CredentialResetAcceptance,
  InvitationAcceptance,
  InvitationIdentityLookup,
  InvitationLookup,
  MemberRepository,
} from "@/auth/member-repository";

const origin = "https://docs.example.test";
const configuration = Object.freeze({
  deploymentId: "docs.example.test",
  sessionSecret: "member-acceptance-test-secret-at-least-32-bytes",
});
const startedAt = new Date("2026-09-03T12:00:00.000Z");
const bearer = createMemberLinkBearer((length) =>
  Uint8Array.from({ length }, (_, index) => index + 1),
);

type Harness = Readonly<{
  acceptedCredentialResets: CredentialResetAcceptance[];
  acceptedInvitations: InvitationAcceptance[];
  deactivate(): void;
  repository: MemberRepository;
}>;

function invitation(
  kind: MemberLinkKind = "invite",
): ActiveMemberInvitation {
  return Object.freeze({
    createdByMemberId: "member_admin",
    email: "editor@example.test",
    expiresAt: new Date(startedAt.getTime() + 60 * 60 * 1_000),
    id: kind === "invite" ? "invitation_editor" : "reset_editor",
    kind,
    memberId: kind === "invite" ? null : "member_editor",
    role: kind === "invite" ? "editor" : null,
    workspaceId: "workspace_demo",
  });
}

async function createHarness(
  record: ActiveMemberInvitation = invitation(),
): Promise<Harness> {
  const expectedDigest = await digestMemberLinkBearer(bearer);
  const acceptedCredentialResets: CredentialResetAcceptance[] = [];
  const acceptedInvitations: InvitationAcceptance[] = [];
  let active = true;

  const repository = {
    async acceptCredentialReset(request: CredentialResetAcceptance) {
      acceptedCredentialResets.push(request);
      if (!active || record.kind !== "credential_reset") return false;
      active = false;
      return true;
    },
    async acceptInvitation(request: InvitationAcceptance) {
      acceptedInvitations.push(request);
      if (!active || record.kind !== "invite") return false;
      active = false;
      return true;
    },
    async findActiveInvitation(request: InvitationLookup) {
      return active &&
        request.kind === record.kind &&
        request.tokenDigest === expectedDigest &&
        request.checkedAt.getTime() < record.expiresAt.getTime()
        ? record
        : null;
    },
    async findActiveInvitationByIdentity(request: InvitationIdentityLookup) {
      return active &&
        request.id === record.id &&
        request.kind === record.kind &&
        request.workspaceId === record.workspaceId &&
        request.checkedAt.getTime() < record.expiresAt.getTime()
        ? record
        : null;
    },
  } as MemberRepository;

  return {
    acceptedCredentialResets,
    acceptedInvitations,
    deactivate() {
      active = false;
    },
    repository,
  };
}

function browserRequest(
  pathname: string,
  options: Readonly<{
    body?: unknown;
    cookie?: string;
    hostHeader?: string;
    method?: "GET" | "POST";
    requestOrigin?: string;
    requestUrlOrigin?: string;
  }> = {},
) {
  const method = options.method ?? "GET";
  const headers = new Headers({
    accept: "application/json",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("origin", options.requestOrigin ?? origin);
  }
  if (options.hostHeader) headers.set("host", options.hostHeader);
  if (options.cookie) headers.set("cookie", options.cookie);

  return new NextRequest(`${options.requestUrlOrigin ?? origin}${pathname}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
  });
}

test("accepts the configured public Host when standalone rewrites the request URL", async () => {
  const harness = await createHarness();
  const response = await handleMemberLinkExchange(
    browserRequest("/admin/accept/invite/exchange", {
      body: { bearer },
      hostHeader: new URL(origin).host,
      method: "POST",
      requestUrlOrigin: "http://0.0.0.0:3000",
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(response.status, 200);

  const wrongHost = await handleMemberLinkExchange(
    browserRequest("/admin/accept/invite/exchange", {
      body: { bearer },
      hostHeader: "attacker.example",
      method: "POST",
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(wrongHost.status, 403);
});

function dependencies(repository: MemberRepository, clock = () => startedAt) {
  return { clock, configuration, repository, siteOrigin: origin };
}

test("acceptance paths map only the two public route names", () => {
  assert.equal(parseMemberAcceptanceKind("invite"), "invite");
  assert.equal(parseMemberAcceptanceKind("reset"), "credential_reset");
  for (const value of ["", "credential_reset", "Invite", "invites", "../invite"]) {
    assert.equal(parseMemberAcceptanceKind(value), null);
  }
});

test("an active bearer exchanges for only its exact durable invitation", async () => {
  const harness = await createHarness();
  const exchanged = await exchangeMemberLink(
    "invite",
    bearer,
    configuration,
    dependencies(harness.repository),
  );
  assert.ok(exchanged);
  assert.equal(exchanged.expiresAt.getTime(), startedAt.getTime() + 15 * 60 * 1_000);

  assert.equal(
    await exchangeMemberLink(
      "credential_reset",
      bearer,
      configuration,
      dependencies(harness.repository),
    ),
    null,
  );
  assert.equal(
    await exchangeMemberLink(
      "invite",
      `${bearer}=`,
      configuration,
      dependencies(harness.repository),
    ),
    null,
  );

  const resolved = await resolveMemberAcceptance(
    "invite",
    exchanged.acceptanceToken,
    configuration,
    dependencies(harness.repository),
  );
  assert.deepEqual(resolved?.view, {
    email: "editor@example.test",
    expiresAt: invitation().expiresAt.toISOString(),
    kind: "invite",
    role: "editor",
  });
  const serialized = JSON.stringify(resolved?.view);
  assert.doesNotMatch(serialized, /workspace_demo|invitation_editor|member_admin/u);

  harness.deactivate();
  assert.equal(
    await resolveMemberAcceptance(
      "invite",
      exchanged.acceptanceToken,
      configuration,
      dependencies(harness.repository),
    ),
    null,
  );
});

test("invalid fields and expiry after password derivation cannot consume a link", async () => {
  const displayNameHarness = await createHarness();
  const displayNameExchange = await exchangeMemberLink(
    "invite",
    bearer,
    configuration,
    dependencies(displayNameHarness.repository),
  );
  assert.ok(displayNameExchange);
  assert.deepEqual(
    await acceptMemberLink(
      displayNameExchange.acceptanceToken,
      { displayName: "\u0000", kind: "invite", password: "long enough password" },
      configuration,
      dependencies(displayNameHarness.repository),
    ),
    { field: "displayName", outcome: "invalid_input" },
  );
  assert.equal(displayNameHarness.acceptedInvitations.length, 0);

  assert.deepEqual(
    await acceptMemberLink(
      displayNameExchange.acceptanceToken,
      { displayName: "Editor", kind: "invite", password: "short" },
      configuration,
      dependencies(displayNameHarness.repository),
    ),
    { field: "password", outcome: "invalid_input" },
  );
  assert.equal(displayNameHarness.acceptedInvitations.length, 0);

  const expiryHarness = await createHarness();
  const expiryExchange = await exchangeMemberLink(
    "invite",
    bearer,
    configuration,
    dependencies(expiryHarness.repository),
  );
  assert.ok(expiryExchange);
  const clockValues = [
    new Date(startedAt.getTime() + 1_000),
    invitation().expiresAt,
  ];
  assert.deepEqual(
    await acceptMemberLink(
      expiryExchange.acceptanceToken,
      {
        displayName: "Editor",
        kind: "invite",
        password: "correct horse battery staple",
      },
      configuration,
      dependencies(expiryHarness.repository, () => clockValues.shift() ?? startedAt),
    ),
    { outcome: "invalid_link" },
  );
  assert.equal(expiryHarness.acceptedInvitations.length, 0);
});

test("same-origin exchange, session, and completion use a host-only scoped cookie", async () => {
  const harness = await createHarness();
  const exchangeRequest = browserRequest("/admin/accept/invite/exchange", {
    body: { bearer },
    method: "POST",
  });
  const exchanged = await handleMemberLinkExchange(
    exchangeRequest,
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(exchanged.status, 200);
  assert.deepEqual(await exchanged.clone().json(), { outcome: "exchanged" });
  assert.equal(exchanged.headers.get("cache-control"), "no-store");
  assert.match(exchanged.headers.get("content-security-policy") ?? "", /default-src 'none'/u);

  const name = memberLinkAcceptanceCookieName(configuration.deploymentId, "invite");
  const acceptanceToken = exchanged.cookies.get(name)?.value;
  assert.ok(acceptanceToken);
  const setCookie = exchanged.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /Secure/u);
  assert.match(setCookie, /SameSite=lax/iu);
  assert.match(setCookie, /Path=\/admin\/accept/u);
  assert.doesNotMatch(setCookie, /Domain=/iu);
  assert.doesNotMatch(setCookie, new RegExp(bearer, "u"));
  assert.doesNotMatch(exchangeRequest.url, new RegExp(bearer, "u"));

  const session = await handleMemberAcceptanceSession(
    browserRequest("/admin/accept/invite/session", {
      cookie: `${name}=${acceptanceToken}`,
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    acceptance: {
      email: "editor@example.test",
      expiresAt: invitation().expiresAt.toISOString(),
      kind: "invite",
      role: "editor",
    },
  });

  const completed = await handleMemberAcceptanceCompletion(
    browserRequest("/admin/accept/invite/complete", {
      body: {
        displayName: "Ed Editor",
        password: "correct horse battery staple",
      },
      cookie: `${name}=${acceptanceToken}`,
      method: "POST",
    }),
    "invite",
    {
      ...dependencies(harness.repository),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    },
  );
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { outcome: "accepted" });
  assert.match(completed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.equal(harness.acceptedInvitations.length, 1);
  assert.equal(harness.acceptedInvitations[0]?.displayName, "Ed Editor");
  assert.notEqual(harness.acceptedInvitations[0]?.password.digest, bearer);
  assert.doesNotMatch(JSON.stringify(harness.acceptedInvitations), new RegExp(bearer, "u"));

  const replayed = await handleMemberAcceptanceCompletion(
    browserRequest("/admin/accept/invite/complete", {
      body: {
        displayName: "Replay",
        password: "correct horse battery staple",
      },
      cookie: `${name}=${acceptanceToken}`,
      method: "POST",
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(replayed.status, 401);
  assert.match(replayed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("a credential-reset cookie updates the existing account once", async () => {
  const harness = await createHarness(invitation("credential_reset"));
  const exchanged = await handleMemberLinkExchange(
    browserRequest("/admin/accept/reset/exchange", {
      body: { bearer },
      method: "POST",
    }),
    "credential_reset",
    dependencies(harness.repository),
  );
  assert.equal(exchanged.status, 200);

  const name = memberLinkAcceptanceCookieName(
    configuration.deploymentId,
    "credential_reset",
  );
  const acceptanceToken = exchanged.cookies.get(name)?.value;
  assert.ok(acceptanceToken);
  const session = await handleMemberAcceptanceSession(
    browserRequest("/admin/accept/reset/session", {
      cookie: `${name}=${acceptanceToken}`,
    }),
    "credential_reset",
    dependencies(harness.repository),
  );
  assert.deepEqual(await session.json(), {
    acceptance: {
      email: "editor@example.test",
      expiresAt: invitation("credential_reset").expiresAt.toISOString(),
      kind: "credential_reset",
      role: null,
    },
  });

  const completed = await handleMemberAcceptanceCompletion(
    browserRequest("/admin/accept/reset/complete", {
      body: { password: "another correct horse password" },
      cookie: `${name}=${acceptanceToken}`,
      method: "POST",
    }),
    "credential_reset",
    {
      ...dependencies(harness.repository),
      randomBytes: (length) => new Uint8Array(length).fill(11),
    },
  );
  assert.equal(completed.status, 200);
  assert.equal(harness.acceptedCredentialResets.length, 1);
  assert.equal(harness.acceptedCredentialResets[0]?.invitationId, "reset_editor");
  assert.match(completed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("cross-origin and malformed exchanges fail without bearer disclosure", async () => {
  const harness = await createHarness();
  const crossOrigin = await handleMemberLinkExchange(
    browserRequest("/admin/accept/invite/exchange", {
      body: { bearer },
      method: "POST",
      requestOrigin: "https://attacker.example",
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("set-cookie"), null);
  assert.doesNotMatch(await crossOrigin.text(), new RegExp(bearer, "u"));

  const invalidBearer = await handleMemberLinkExchange(
    browserRequest("/admin/accept/invite/exchange", {
      body: { bearer: "invalid" },
      method: "POST",
    }),
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(invalidBearer.status, 400);
  assert.match(invalidBearer.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.doesNotMatch(await invalidBearer.text(), /invalid"/u);

  const oversized = browserRequest("/admin/accept/invite/exchange", {
    body: { bearer },
    method: "POST",
  });
  oversized.headers.set("content-length", "257");
  const rejectedSize = await handleMemberLinkExchange(
    oversized,
    "invite",
    dependencies(harness.repository),
  );
  assert.equal(rejectedSize.status, 413);
  assert.match(rejectedSize.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("acceptance cookies are bound to link kind and deployment", async () => {
  const harness = await createHarness();
  const exchanged = await exchangeMemberLink(
    "invite",
    bearer,
    configuration,
    dependencies(harness.repository),
  );
  assert.ok(exchanged);

  const resetName = memberLinkAcceptanceCookieName(
    configuration.deploymentId,
    "credential_reset",
  );
  const wrongKind = await handleMemberAcceptanceSession(
    browserRequest("/admin/accept/reset/session", {
      cookie: `${resetName}=${exchanged.acceptanceToken}`,
    }),
    "credential_reset",
    dependencies(harness.repository),
  );
  assert.equal(wrongKind.status, 401);

  const otherConfiguration = {
    ...configuration,
    deploymentId: "other.example.test",
  };
  const otherName = memberLinkAcceptanceCookieName(
    otherConfiguration.deploymentId,
    "invite",
  );
  const wrongDeployment = await handleMemberAcceptanceSession(
    browserRequest("/admin/accept/invite/session", {
      cookie: `${otherName}=${exchanged.acceptanceToken}`,
    }),
    "invite",
    {
      ...dependencies(harness.repository),
      configuration: otherConfiguration,
    },
  );
  assert.equal(wrongDeployment.status, 401);
  assert.match(wrongDeployment.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("the browser boundary clears fragments before exchange and has no persistence or logging path", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "src/app/admin/accept/[kind]/member-acceptance.tsx",
    ),
    "utf8",
  );
  assert.ok(source.indexOf("history.replaceState") < source.indexOf("fetch(`${pathname}/exchange`"));
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\./u);
  assert.match(source, /referrerPolicy: "no-referrer"/u);
  assert.doesNotMatch(source, /[?&](?:token|bearer)=/u);
});
