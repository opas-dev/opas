// ABOUTME: Verifies bounded support handoffs, server-owned citations, and idempotent delivery.
// ABOUTME: Covers structured email, HTTPS webhook, SSRF, header injection, and safe route errors.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeHttps from "node:https";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  createCloudflareEmailDelivery,
  createCloudflareRestEmailDelivery,
  createCloudflareWebhookDelivery,
  createNodeWebhookDelivery,
  sendPinnedWebhookRequest,
  type CloudflareEmailBinding,
  type HandoffDelivery,
} from "@/handoff/delivery";
import { HandoffError } from "@/handoff/errors";
import {
  maximumHandoffRequestUtf8Bytes,
  normalizeHandoffSubmission,
  resolveHandoffPayload,
  type HandoffPayload,
} from "@/handoff/payload";
import { handleHandoffRequest } from "@/handoff/route";
import {
  createHandoffService,
  type HandoffService,
  type HandoffStorageRecord,
  type HandoffStore,
} from "@/handoff/service";

const workspaceId = "workspace_demo";
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const articleContentHash = "a".repeat(64);
const contentHash = "b".repeat(64);

const evidence = Object.freeze([
  Object.freeze({
    articleContentHash,
    articleId: "article_password",
    canonicalUrl: "https://help.example.com/account/reset-password",
    contentHash,
    headingPath: Object.freeze(["Account", "Password"]),
    id: "chunk_password",
    sourceLineRange: Object.freeze({ end: 12, start: 4 }),
    title: "Reset your password",
  }),
]);

function submission(overrides: Record<string, unknown> = {}) {
  return {
    citations: [
      {
        articleContentHash,
        articleId: "article_password",
        canonicalUrl: "https://help.example.com/account/reset-password",
        contentHash,
        headingPath: ["Account", "Password"],
        id: "C1",
        sourceId: "chunk_password",
        sourceLineRange: { end: 12, start: 4 },
        title: "Reset your password",
      },
    ],
    contact: {
      email: "reader@example.com",
      name: "Reader <img src=x onerror=alert(1)>",
    },
    outcome: "low-rated",
    pageUrl: "https://customer.example.com/settings?token=secret#password",
    question: "How do I reset my password?",
    transcript: [
      { content: "How do I reset my password?", role: "user" },
      {
        content: "Open </p><img src=x onerror=alert(1)> settings.",
        role: "assistant",
      },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<HandoffPayload> = {}) {
  return Object.freeze({
    ...resolveHandoffPayload(normalizeHandoffSubmission(submission()), evidence),
    ...overrides,
  });
}

function request(
  value: unknown,
  options: Readonly<{
    contentType?: string;
    idempotency?: string;
    method?: string;
  }> = {},
) {
  return new Request("https://help.example.com/api/handoff", {
    body:
      options.method === "GET"
        ? undefined
        : typeof value === "string"
          ? value
          : JSON.stringify(value),
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
      ...(options.idempotency === undefined
        ? { "idempotency-key": idempotencyKey }
        : options.idempotency
          ? { "idempotency-key": options.idempotency }
          : {}),
    },
    method: options.method ?? "POST",
  });
}

function handoffError(code: HandoffError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof HandoffError);
    assert.equal(error.code, code);
    return true;
  };
}

test("normalizes a bounded handoff while separating contact from published context", () => {
  const normalized = normalizeHandoffSubmission(
    submission({
      question: "  How\t do I reset my password?  ",
      transcript: [
        { content: " Question with CRLF\r\nnext line ", role: "user" },
      ],
    }),
  );
  const resolved = resolveHandoffPayload(normalized, evidence);

  assert.equal(normalized.question, "How do I reset my password?");
  assert.equal(normalized.transcript[0]?.content, "Question with CRLF\nnext line");
  assert.equal(
    resolved.pageUrl,
    "https://customer.example.com/settings",
  );
  assert.deepEqual(resolved.citations, [
    {
      articleContentHash,
      articleId: "article_password",
      canonicalUrl: "https://help.example.com/account/reset-password",
      contentHash,
      headingPath: ["Account", "Password"],
      sourceId: "chunk_password",
      sourceLineRange: { end: 12, start: 4 },
      title: "Reset your password",
    },
  ]);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.contact), true);
  assert.equal(Object.isFrozen(resolved.citations), true);
  assert.equal(Object.isFrozen(resolved.transcript), true);
});

test("rejects unknown routing fields, unsafe content, and every payload bound", () => {
  const invalid = [
    submission({ target: "attacker@example.com" }),
    submission({ to: "attacker@example.com" }),
    submission({ webhookUrl: "https://attacker.example/hook" }),
    submission({ contact: { email: "reader@example.com\r\nBcc: attacker@example.com" } }),
    submission({ contact: { email: "reader@localhost" } }),
    submission({ outcome: "urgent" }),
    submission({ pageUrl: "javascript:alert(1)" }),
    submission({ pageUrl: "https://user:secret@customer.example/account" }),
    submission({ question: `Question ${"x".repeat(1_000)}` }),
    submission({ transcript: Array.from({ length: 9 }, () => ({ content: "x", role: "user" })) }),
    submission({ transcript: [{ content: "\u202ehidden", role: "user" }] }),
    submission({ citations: Array.from({ length: 21 }, () => submission().citations[0]) }),
  ];

  for (const value of invalid) {
    assert.throws(() => normalizeHandoffSubmission(value), handoffError("invalid-input"));
  }
});

test("rebuilds citations from current server evidence and rejects forged or stale claims", () => {
  const normalized = normalizeHandoffSubmission(submission());

  for (const citations of [
    [{ ...submission().citations[0], canonicalUrl: "https://attacker.example/source" }],
    [{ ...submission().citations[0], contentHash: "c".repeat(64) }],
    [{ ...submission().citations[0], sourceId: "draft_chunk" }],
  ]) {
    assert.throws(
      () =>
        resolveHandoffPayload(
          normalizeHandoffSubmission(submission({ citations })),
          evidence,
        ),
      handoffError("invalid-input"),
    );
  }

  const unpublished = evidence.map((entry) => ({ ...entry, id: "other_chunk" }));
  assert.throws(
    () => resolveHandoffPayload(normalized, unpublished),
    handoffError("invalid-input"),
  );
});

test("Cloudflare binding sends one structured, header-safe, HTML-escaped email", async () => {
  const messages: unknown[] = [];
  const binding = {
    async send(message: unknown) {
      messages.push(message);
      return { messageId: "provider-message-id" };
    },
  } as unknown as CloudflareEmailBinding;
  const delivery = createCloudflareEmailDelivery({
    binding,
    from: "support@opas.dev",
    to: "helpdesk@example.com",
  });

  await delivery.send({ idempotencyKey, payload: payload() });

  assert.equal(messages.length, 1);
  const message = messages[0] as Record<string, unknown>;
  assert.equal(message.from, "support@opas.dev");
  assert.equal(message.to, "helpdesk@example.com");
  assert.equal(message.replyTo, "reader@example.com");
  assert.equal(message.subject, "OPAS support handoff · Low-rated answer");
  assert.deepEqual(message.headers, { "X-OPAS-Handoff-ID": idempotencyKey });
  assert.match(String(message.text), /How do I reset my password\?/u);
  assert.match(String(message.text), /Reset your password/u);
  assert.match(String(message.html), /Reader &lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(
    String(message.html),
    /Open &lt;\/p&gt;&lt;img src=x onerror=alert\(1\)&gt; settings\./u,
  );
  assert.doesNotMatch(String(message.html), /<img\b/u);
  assert.doesNotMatch(String(message.subject), /[\r\n]/u);
  assert.doesNotMatch(JSON.stringify(message.headers), /[\r\n]/u);
});

test("portable Cloudflare REST email uses the documented schema without exposing its token", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const delivery = createCloudflareRestEmailDelivery({
    accountId: "f8801c7e8853a113a25f8b52fd9ceec1",
    apiToken: "private-email-token",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return Response.json({ result: { delivered: ["helpdesk@example.com"] }, success: true });
    },
    from: "support@opas.dev",
    to: "helpdesk@example.com",
  });

  await delivery.send({ idempotencyKey, payload: payload() });

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "https://api.cloudflare.com/client/v4/accounts/f8801c7e8853a113a25f8b52fd9ceec1/email/sending/send",
  );
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer private-email-token");
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(calls[0]?.init?.redirect, "error");
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(calls[0]?.init?.cache, "no-store");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.from, "support@opas.dev");
  assert.equal(body.to, "helpdesk@example.com");
  assert.equal(body.reply_to, "reader@example.com");
  assert.equal(body.headers["X-OPAS-Handoff-ID"], idempotencyKey);
  assert.doesNotMatch(JSON.stringify(delivery), /private-email-token/u);
});

test("webhook sends a fixed envelope and never accepts a user-selected target", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const delivery = createCloudflareWebhookDelivery({
    endpoint: "https://hooks.example.com/opas/support",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    },
    token: "private-webhook-token",
  });

  await delivery.send({ idempotencyKey, payload: payload() });

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "https://hooks.example.com/opas/support");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer private-webhook-token");
  assert.equal(headers.get("idempotency-key"), idempotencyKey);
  assert.equal(calls[0]?.init?.redirect, "error");
  assert.equal(calls[0]?.init?.credentials, "omit");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.type, "opas.support-handoff");
  assert.equal(body.version, 1);
  assert.equal(body.idempotencyKey, idempotencyKey);
  assert.equal(body.handoff.contact.email, "reader@example.com");
  assert.equal("target" in body.handoff, false);
  assert.doesNotMatch(JSON.stringify(delivery), /private-webhook-token/u);
});

test("Node webhook pins one public address after validating every DNS result", async () => {
  const attempts: Array<{
    body: string;
    endpoint: string;
    pinnedAddress: string;
  }> = [];
  const delivery = createNodeWebhookDelivery({
    endpoint: "https://hooks.example.com/opas/support",
    request: async ({ body, endpoint, pinnedAddress }) => {
      attempts.push({ body, endpoint, pinnedAddress });
    },
    resolveHostname: async (hostname) => {
      assert.equal(hostname, "hooks.example.com");
      return ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
    },
  });

  await delivery.send({ idempotencyKey, payload: payload() });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.endpoint, "https://hooks.example.com/opas/support");
  assert.equal(attempts[0]?.pinnedAddress, "93.184.216.34");
  assert.equal(JSON.parse(attempts[0]?.body ?? "{}").type, "opas.support-handoff");
});

test("pinned Node HTTPS request honors all-address lookup callbacks", async () => {
  const originalRequest = nodeHttps.request;
  let lookupResult: unknown;
  nodeHttps.request = ((
    _endpoint: URL,
    options: {
      lookup?: (
        hostname: string,
        options: { all: boolean },
        callback: (error: Error | null, addresses: unknown) => void,
      ) => void;
    },
    respond: (response: { destroy(): void; statusCode: number }) => void,
  ) => {
    const outbound = new EventEmitter() as EventEmitter & { end(): void };
    outbound.end = () => {
      options.lookup?.(
        "hooks.example.com",
        { all: true },
        (error, addresses) => {
          assert.equal(error, null);
          lookupResult = addresses;
          respond({ destroy() {}, statusCode: 204 });
        },
      );
    };
    return outbound;
  }) as typeof nodeHttps.request;
  syncBuiltinESMExports();
  try {
    await sendPinnedWebhookRequest({
      body: "{}",
      endpoint: "https://hooks.example.com/opas",
      headers: { "Content-Type": "application/json" },
      pinnedAddress: "93.184.216.34",
    });
  } finally {
    nodeHttps.request = originalRequest;
    syncBuiltinESMExports();
  }

  assert.deepEqual(lookupResult, [
    { address: "93.184.216.34", family: 4 },
  ]);
});

test("Node webhook rejects private, local, reserved, and mixed DNS results", async () => {
  const addressSets = [
    ["127.0.0.1"],
    ["10.0.0.7"],
    ["169.254.169.254"],
    ["::1"],
    ["fc00::1"],
    ["fe80::1"],
    ["93.184.216.34", "192.168.1.4"],
    ["2606:2800:220:1:248:1893:25c8:1946", "fd00::1"],
  ];

  for (const addresses of addressSets) {
    let requests = 0;
    const delivery = createNodeWebhookDelivery({
      endpoint: "https://hooks.example.com/opas",
      request: async () => {
        requests += 1;
      },
      resolveHostname: async () => addresses,
    });
    await assert.rejects(
      delivery.send({ idempotencyKey, payload: payload() }),
      handoffError("delivery-failed"),
    );
    assert.equal(requests, 0);
  }
});

test("Node webhook resolves on every send and rejects a rebinding result", async () => {
  let resolutions = 0;
  let requests = 0;
  const delivery = createNodeWebhookDelivery({
    endpoint: "https://hooks.example.com/opas",
    request: async () => {
      requests += 1;
    },
    resolveHostname: async () => {
      resolutions += 1;
      return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    },
  });

  await delivery.send({ idempotencyKey, payload: payload() });
  await assert.rejects(
    delivery.send({
      idempotencyKey: "223e4567-e89b-42d3-a456-426614174000",
      payload: payload(),
    }),
    handoffError("delivery-failed"),
  );
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test("rejects unsafe webhook configuration before fetch can reach it", () => {
  const endpoints = [
    "http://hooks.example.com/opas",
    "javascript:alert(1)",
    "https://user:secret@hooks.example.com/opas",
    "https://hooks.example.com/opas?token=secret",
    "https://localhost/opas",
    "https://localhost./opas",
    "https://service.local/opas",
    "https://metadata.internal/opas",
    "https://127.0.0.1/opas",
    "https://2130706433/opas",
    "https://[::1]/opas",
    "https://[fc00::1]/opas",
    "https://single-label/opas",
  ];

  for (const endpoint of endpoints) {
    assert.throws(
      () => createCloudflareWebhookDelivery({ endpoint }),
      handoffError("configuration"),
    );
  }

  assert.throws(
    () =>
      createCloudflareWebhookDelivery({
        endpoint: "https://hooks.example.com/opas",
        token: "token\r\nX-Forged: yes",
      }),
    handoffError("configuration"),
  );
});

test("maps redirects, provider secrets, and aborts to fixed sanitized errors", async () => {
  const fixtures: Array<{
    code: HandoffError["code"];
    delivery: HandoffDelivery;
    secret: string;
  }> = [
    {
      code: "delivery-failed",
      delivery: createCloudflareWebhookDelivery({
        endpoint: "https://hooks.example.com/opas",
        fetch: async () => new Response(null, { status: 302 }),
      }),
      secret: "hooks.example.com",
    },
    {
      code: "delivery-failed",
      delivery: createCloudflareEmailDelivery({
        binding: {
          async send() {
            throw new Error("private provider response and recipient");
          },
        } as unknown as CloudflareEmailBinding,
        from: "support@opas.dev",
        to: "helpdesk@example.com",
      }),
      secret: "private provider response",
    },
  ];

  for (const fixture of fixtures) {
    await assert.rejects(
      fixture.delivery.send({ idempotencyKey, payload: payload() }),
      (error: unknown) => {
        assert.ok(error instanceof HandoffError);
        assert.equal(error.code, fixture.code);
        assert.doesNotMatch(String(error), new RegExp(fixture.secret, "u"));
        return true;
      },
    );
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createCloudflareWebhookDelivery({ endpoint: "https://hooks.example.com/opas" }).send({
      idempotencyKey,
      payload: payload(),
      signal: controller.signal,
    }),
    handoffError("cancelled"),
  );
});

class MemoryHandoffStore implements HandoffStore {
  readonly records = new Map<string, HandoffStorageRecord>();
  readonly completions: Array<{ id: string; status: "delivered" | "failed" }> = [];

  async cleanup() {
    return 0;
  }

  async reserve(record: HandoffStorageRecord) {
    const current = this.records.get(record.id);
    if (!current) {
      this.records.set(record.id, record);
      return { state: "reserved" as const };
    }
    return current.payloadHash === record.payloadHash
      ? { state: "duplicate" as const, status: current.status }
      : { state: "conflict" as const };
  }

  async finish(request: {
    finishedAt: Date;
    id: string;
    status: "delivered" | "failed";
    workspaceId: string;
  }) {
    const current = this.records.get(request.id);
    if (current) {
      this.records.set(request.id, Object.freeze({ ...current, status: request.status }));
    }
    this.completions.push({ id: request.id, status: request.status });
  }
}

function serviceFixture(
  options: Readonly<{
    delivery?: HandoffDelivery;
    deliveryTimeoutMilliseconds?: number;
    store?: MemoryHandoffStore;
    trustedPageOrigins?: readonly string[];
  }> = {},
) {
  const deliveries: HandoffPayload[] = [];
  const store = options.store ?? new MemoryHandoffStore();
  const delivery =
    options.delivery ??
    ({
      async send(request) {
        deliveries.push(request.payload);
      },
    } satisfies HandoffDelivery);
  return {
    deliveries,
    service: createHandoffService({
      delivery,
      deliveryTimeoutMilliseconds: options.deliveryTimeoutMilliseconds,
      loadEvidence: async () => evidence,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      store,
      trustedPageOrigins: options.trustedPageOrigins ?? ["https://customer.example.com"],
      workspaceId,
    }),
    store,
  };
}

test("atomically reserves an idempotency key before sending and deduplicates concurrency", async () => {
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let continueDelivery: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    continueDelivery = resolve;
  });
  let sends = 0;
  const fixture = serviceFixture({
    delivery: {
      async send() {
        sends += 1;
        release?.();
        await blocked;
      },
    },
  });

  const first = fixture.service.submit({ idempotencyKey, submission: submission() });
  await started;
  const second = await fixture.service.submit({
    idempotencyKey,
    submission: submission(),
  });
  continueDelivery?.();

  assert.equal((await first).status, "delivered");
  assert.equal(second.status, "pending");
  assert.equal(sends, 1);
  const record = fixture.store.records.get(idempotencyKey);
  assert.equal(record?.status, "delivered");
  assert.equal(record?.contact.email, "reader@example.com");
  assert.equal("contact" in (record?.context ?? {}), false);
});

test("keeps a stranded pending reservation unconfirmed without resending", async () => {
  let sends = 0;
  const service = createHandoffService({
    delivery: {
      async send() {
        sends += 1;
      },
    },
    loadEvidence: async () => evidence,
    store: {
      async cleanup() {
        return 0;
      },
      async finish() {},
      async reserve() {
        return { state: "duplicate", status: "pending" };
      },
    },
    trustedPageOrigins: ["https://customer.example.com"],
    workspaceId,
  });

  assert.deepEqual(
    await service.submit({ idempotencyKey, submission: submission() }),
    { status: "pending" },
  );
  assert.equal(sends, 0);
});

test("accepts only trusted page origins and canonicalizes configured embed parents", async () => {
  const fixture = serviceFixture({
    trustedPageOrigins: [
      "https://customer.example.com",
      "https://portal.example.org",
    ],
  });

  await fixture.service.submit({
    idempotencyKey,
    submission: submission({
      pageUrl: "https://portal.example.org/help?private=yes#section",
    }),
  });
  assert.equal(fixture.deliveries[0]?.pageUrl, "https://portal.example.org/help");
  await assert.rejects(
    fixture.service.submit({
      idempotencyKey: "223e4567-e89b-42d3-a456-426614174000",
      submission: submission({ pageUrl: "https://attacker.example/help" }),
    }),
    handoffError("invalid-input"),
  );
  assert.equal(fixture.store.records.size, 1);
});

test("validates evidence before reserving durable handoff capacity", async () => {
  const fixture = serviceFixture();
  const reservations: string[] = [];
  await assert.rejects(
    fixture.service.submit({
      idempotencyKey,
      reserveDelivery: async (id) => {
        reservations.push(id);
        return { accepted: true };
      },
      submission: submission({
        citations: [
          { ...submission().citations[0], sourceId: "stale-source" },
        ],
      }),
    }),
    handoffError("invalid-input"),
  );
  assert.equal(reservations.length, 0);

  await fixture.service.submit({
    idempotencyKey,
    reserveDelivery: async (id) => {
      reservations.push(id);
      return { accepted: true };
    },
    submission: submission(),
  });
  assert.deepEqual(reservations, [idempotencyKey]);
});

test("fails closed on durable admission before storing or delivering", async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.submit({
      idempotencyKey,
      reserveDelivery: async () => ({
        accepted: false,
        retryAfterSeconds: 90,
      }),
      submission: submission(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HandoffError);
      assert.equal(error.code, "rate-limited");
      assert.equal(error.retryAfterSeconds, 90);
      return true;
    },
  );
  assert.equal(fixture.store.records.size, 0);
  assert.equal(fixture.deliveries.length, 0);
});

test("aborts timed-out delivery and marks its reservation failed", async () => {
  let observedSignal: AbortSignal | undefined;
  const fixture = serviceFixture({
    delivery: {
      async send({ signal }) {
        observedSignal = signal;
        await new Promise<void>(() => undefined);
      },
    },
    deliveryTimeoutMilliseconds: 5,
  });

  await assert.rejects(
    fixture.service.submit({ idempotencyKey, submission: submission() }),
    handoffError("delivery-failed"),
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(fixture.store.records.get(idempotencyKey)?.status, "failed");
  assert.deepEqual(fixture.store.completions, [
    { id: idempotencyKey, status: "failed" },
  ]);
});

test("rejects an idempotency collision and never stores unverified citations", async () => {
  const fixture = serviceFixture();
  await fixture.service.submit({ idempotencyKey, submission: submission() });

  await assert.rejects(
    fixture.service.submit({
      idempotencyKey,
      submission: submission({ question: "A different question" }),
    }),
    handoffError("conflict"),
  );
  await assert.rejects(
    fixture.service.submit({
      idempotencyKey: "223e4567-e89b-42d3-a456-426614174000",
      submission: submission({
        citations: [
          { ...submission().citations[0], sourceId: "unpublished_chunk" },
        ],
      }),
    }),
    handoffError("invalid-input"),
  );
  assert.equal(fixture.deliveries.length, 1);
  assert.equal(fixture.store.records.size, 1);
});

test("marks terminal delivery failure without resending the same key", async () => {
  const fixture = serviceFixture({
    delivery: {
      async send() {
        throw new HandoffError("delivery-failed");
      },
    },
  });

  await assert.rejects(
    fixture.service.submit({ idempotencyKey, submission: submission() }),
    handoffError("delivery-failed"),
  );
  assert.equal(fixture.store.records.get(idempotencyKey)?.status, "failed");
  await assert.rejects(
    fixture.service.submit({
      idempotencyKey,
      submission: submission(),
    }),
    handoffError("delivery-failed"),
  );
  assert.deepEqual(fixture.store.completions, [
    { id: idempotencyKey, status: "failed" },
  ]);
});

function serviceStub(
  submit: HandoffService["submit"],
): HandoffService {
  return Object.freeze({ submit });
}

test("handoff route accepts only bounded JSON with an exact idempotency key", async () => {
  const received: unknown[] = [];
  const response = await handleHandoffRequest(request(submission()), {
    createService: async () =>
      serviceStub(async (input) => {
        received.push(input);
        return Object.freeze({ status: "delivered" });
      }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { status: "delivered" });
  assert.equal(received.length, 1);
  assert.equal(
    (received[0] as { idempotencyKey: string }).idempotencyKey,
    idempotencyKey,
  );
  assert.ok((received[0] as { signal: unknown }).signal instanceof AbortSignal);
  assert.deepEqual(
    (received[0] as { submission: unknown }).submission,
    submission(),
  );

  const duplicate = await handleHandoffRequest(request(submission()), {
    createService: async () =>
      serviceStub(async () => Object.freeze({ status: "duplicate" })),
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });

  let escalations = 0;
  const pending = await handleHandoffRequest(request(submission()), {
    createService: async () =>
      serviceStub(async () => Object.freeze({ status: "pending" })),
    recordEscalation: async () => {
      escalations += 1;
    },
  });
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { status: "pending" });
  assert.equal(escalations, 0);
});

test("handoff route surfaces durable admission retry timing without delivery", async () => {
  let delivered = false;
  const service = serviceStub(async (input) => {
    const allowance = await input.reserveDelivery?.(input.idempotencyKey);
    if (allowance && !allowance.accepted) {
      throw new HandoffError("rate-limited", allowance.retryAfterSeconds);
    }
    delivered = true;
    return { status: "delivered" };
  });
  const response = await handleHandoffRequest(request(submission()), {
    consumeDurableAllowance: async () => ({
      accepted: false,
      retryAfterSeconds: 75,
    }),
    createService: async () => service,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "75");
  assert.deepEqual(await response.json(), { error: "unavailable" });
  assert.equal(delivered, false);
});

test("handoff route contains malformed, oversized, conflicting, and secret failures", async () => {
  const fixtures: Array<{
    expectedBody: unknown;
    expectedStatus: number;
    request: Request;
    service?: HandoffService;
  }> = [
    {
      expectedBody: { error: "method-not-allowed" },
      expectedStatus: 405,
      request: request({}, { method: "GET" }),
    },
    {
      expectedBody: { error: "unsupported-media-type" },
      expectedStatus: 415,
      request: request("{}", { contentType: "text/plain" }),
    },
    {
      expectedBody: { error: "invalid-request" },
      expectedStatus: 400,
      request: request("{not-json"),
    },
    {
      expectedBody: { error: "invalid-request" },
      expectedStatus: 400,
      request: request(submission(), { idempotency: "short" }),
    },
    {
      expectedBody: { error: "payload-too-large" },
      expectedStatus: 413,
      request: request("x".repeat(maximumHandoffRequestUtf8Bytes + 1)),
    },
    {
      expectedBody: { error: "conflict" },
      expectedStatus: 409,
      request: request(submission()),
      service: serviceStub(async () => {
        throw new HandoffError("conflict");
      }),
    },
    {
      expectedBody: { error: "unavailable" },
      expectedStatus: 503,
      request: request(submission()),
      service: serviceStub(async () => {
        throw new Error("private webhook token and transcript");
      }),
    },
  ];

  for (const fixture of fixtures) {
    const response = await handleHandoffRequest(fixture.request, {
      createService: async () =>
        fixture.service ?? serviceStub(async () => ({ status: "delivered" })),
    });
    assert.equal(response.status, fixture.expectedStatus);
    const body = await response.json();
    assert.deepEqual(body, fixture.expectedBody);
    assert.doesNotMatch(JSON.stringify(body), /private webhook token|transcript/u);
  }
});
