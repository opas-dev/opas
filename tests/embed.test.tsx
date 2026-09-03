// ABOUTME: Verifies the embeddable assistant's framing, messaging, and published-page boundary.
// ABOUTME: Covers exact origins, bounded context, loader isolation, CSP, and accessible markup.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";

import nextConfig from "../next.config";
import { config as proxyConfig, proxy } from "@/proxy";
import { handleAnswerRequest } from "@/answers/answer-route";
import type { AnswerRuntime } from "@/answers/answer-runtime";
import { EmbedAssistant } from "@/app/embed/embed-assistant";
import { metadata as embedPageMetadata } from "@/app/embed/page";
import {
  embedParentOrigins,
  maximumEmbedParentOrigins,
} from "@/embed/config";
import {
  handleEmbedContextRequest,
  maximumEmbedContextRequestUtf8Bytes,
  type PublishedEmbedArticle,
} from "@/embed/context";
import { embedLoaderScript } from "@/embed/loader";
import {
  isEmbedControlMessageEvent,
  isParentContextMessageEvent,
  maximumEmbedPageUrlUtf8Bytes,
} from "@/embed/messages";
import {
  contentSecurityPolicy,
  createEmbedContentSecurityPolicy,
} from "@/security/headers";

const parentOrigin = "https://docs.customer.test";
const secondParentOrigin = "https://account.customer.test:8443";
const embedOrigin = "https://help.example.test";
const publishedArticles: readonly PublishedEmbedArticle[] = [
  {
    article: { id: "article_password", title: "Reset your password" },
    path: "/account/reset-password",
  },
];

function contextRequest(
  value: unknown,
  headers: HeadersInit = { "content-type": "application/json; charset=utf-8" },
) {
  return new Request(`${embedOrigin}/api/embed/context`, {
    body: typeof value === "string" ? value : JSON.stringify(value),
    headers,
    method: "POST",
  });
}

function configuredContextDependencies(origins = [parentOrigin]) {
  return {
    loadPublications: async () => publishedArticles,
    parentOrigins: origins,
  };
}

test("accepts only canonical exact HTTP(S) parent origins and fails closed", () => {
  assert.deepEqual(
    embedParentOrigins(`${parentOrigin}, ${secondParentOrigin},${parentOrigin}`),
    [parentOrigin, secondParentOrigin],
  );
  assert.deepEqual(embedParentOrigins(undefined), []);

  for (const invalid of [
    "https://*.customer.test",
    "https://customer.test/path",
    "https://customer.test?tenant=one",
    "https://user:secret@customer.test",
    "https://customer.test/",
    "data:text/html,customer",
    "null",
    ",https://customer.test",
  ]) {
    assert.throws(() => embedParentOrigins(invalid), /OPAS_EMBED_PARENT_ORIGINS/u);
  }

  assert.throws(
    () =>
      embedParentOrigins(
        Array.from(
          { length: maximumEmbedParentOrigins + 1 },
          (_, index) => `https://customer-${index}.test`,
        ).join(","),
      ),
    /OPAS_EMBED_PARENT_ORIGINS/u,
  );
});

test("gives the dedicated embed route one runtime frame-parent policy", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previous = environment.OPAS_EMBED_PARENT_ORIGINS;
  environment.OPAS_EMBED_PARENT_ORIGINS = `${parentOrigin},${secondParentOrigin}`;

  try {
    const createHeaders = nextConfig.headers;
    if (!createHeaders) assert.fail("Next.js must define route headers");
    const rules = await createHeaders();
    const globalRule = rules.find(
      ({ source }) => source === "/:path((?!preview$)(?!preview/).*)",
    );
    const globalCspRule = rules.find(
      ({ source }) =>
        source === "/:path((?!embed$)(?!preview$)(?!preview/).*)",
    );
    const embedRule = rules.find(({ source }) => source === "/embed");
    assert.ok(globalRule);
    assert.ok(globalCspRule);
    assert.equal(embedRule, undefined);

    const embedResponse = await proxy(
      new NextRequest("https://help.example.test/embed"),
    );
    const embedCsp = embedResponse.headers.get("content-security-policy");
    const composedEmbedPolicies = [embedCsp].filter(
      (value): value is string => value !== null,
    );

    assert.equal(
      globalCspRule.headers.find(
        ({ key }) => key === "Content-Security-Policy",
      )?.value,
      contentSecurityPolicy,
    );
    assert.equal(composedEmbedPolicies.length, 1);
    assert.deepEqual(proxyConfig, {
      matcher: ["/admin/:path*", "/embed", "/preview/:path*"],
    });
    assert.equal(
      embedCsp,
      createEmbedContentSecurityPolicy([parentOrigin, secondParentOrigin]),
    );
    assert.match(
      embedCsp ?? "",
      new RegExp(`frame-ancestors ${parentOrigin} ${secondParentOrigin}$`, "u"),
    );
    assert.equal(embedCsp?.match(/frame-ancestors/gu)?.length, 1);
    assert.doesNotMatch(embedCsp ?? "", /frame-ancestors 'none'/u);
    assert.doesNotMatch(embedCsp ?? "", /unsafe-eval/u);
    assert.match(embedCsp ?? "", /img-src 'none'/u);
    assert.deepEqual(embedPageMetadata.icons, { icon: [] });
  } finally {
    if (previous === undefined) delete environment.OPAS_EMBED_PARENT_ORIGINS;
    else environment.OPAS_EMBED_PARENT_ORIGINS = previous;
  }
});

test("validates parent-to-embed messages by origin, source, shape, URL, and size", () => {
  const parentWindow = {};
  const message = {
    data: {
      pageUrl: `${parentOrigin}/account/reset-password?from=product#security`,
      type: "opas:context",
      version: 1,
    },
    origin: parentOrigin,
    source: parentWindow,
  };

  assert.equal(
    isParentContextMessageEvent(message, parentOrigin, parentWindow),
    true,
  );
  assert.equal(
    isParentContextMessageEvent({ ...message, origin: "https://attacker.test" }, parentOrigin, parentWindow),
    false,
  );
  assert.equal(
    isParentContextMessageEvent({ ...message, source: {} }, parentOrigin, parentWindow),
    false,
  );
  assert.equal(
    isParentContextMessageEvent(
      { ...message, data: { ...message.data, pageText: "secret host DOM" } },
      parentOrigin,
      parentWindow,
    ),
    false,
  );
  assert.equal(
    isParentContextMessageEvent(
      {
        ...message,
        data: {
          ...message.data,
          pageUrl: `${parentOrigin}/${"x".repeat(maximumEmbedPageUrlUtf8Bytes)}`,
        },
      },
      parentOrigin,
      parentWindow,
    ),
    false,
  );
  assert.equal(
    isParentContextMessageEvent(
      { ...message, data: { ...message.data, pageUrl: "javascript:alert(1)" } },
      parentOrigin,
      parentWindow,
    ),
    false,
  );
  assert.equal(
    isParentContextMessageEvent(
      {
        ...message,
        data: { ...message.data, pageUrl: "https://other.customer.test/account/reset-password" },
      },
      parentOrigin,
      parentWindow,
    ),
    false,
  );
});

test("validates embed-to-parent control messages by origin, source, type, and size", () => {
  const embedWindow = {};
  assert.equal(
    isEmbedControlMessageEvent(
      { data: { type: "opas:ready", version: 1 }, origin: embedOrigin, source: embedWindow },
      embedOrigin,
      embedWindow,
    ),
    true,
  );
  assert.equal(
    isEmbedControlMessageEvent(
      {
        data: { height: 640, type: "opas:resize", version: 1 },
        origin: embedOrigin,
        source: embedWindow,
      },
      embedOrigin,
      embedWindow,
    ),
    true,
  );

  for (const event of [
    { data: { type: "opas:ready", version: 1 }, origin: "https://attacker.test", source: embedWindow },
    { data: { type: "opas:ready", version: 1 }, origin: embedOrigin, source: {} },
    { data: { height: 5_000, type: "opas:resize", version: 1 }, origin: embedOrigin, source: embedWindow },
    { data: { height: 640, token: "forged", type: "opas:resize", version: 1 }, origin: embedOrigin, source: embedWindow },
    { data: { type: "unknown", version: 1 }, origin: embedOrigin, source: embedWindow },
  ]) {
    assert.equal(
      isEmbedControlMessageEvent(event, embedOrigin, embedWindow),
      false,
    );
  }
});

test("resolves only allowed parent URLs to the server's published article identity", async () => {
  const response = await handleEmbedContextRequest(
    contextRequest({
      pageUrl: `${parentOrigin}/account/reset-password?from=product#security`,
      parentOrigin,
    }),
    configuredContextDependencies(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    context: {
      articleId: "article_password",
      path: "/account/reset-password",
      title: "Reset your password",
    },
  });

  const unknown = await handleEmbedContextRequest(
    contextRequest({ pageUrl: `${parentOrigin}/unpublished/draft`, parentOrigin }),
    configuredContextDependencies(),
  );
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { context: null });
});

test("native answers resolve current-page paths to server-owned published metadata", async () => {
  let received: Parameters<AnswerRuntime["service"]["stream"]>[0] | undefined;
  const runtime: AnswerRuntime = {
    metadata: {
      model: "fixture-answer-v1",
      provider: "openai-compatible",
      retentionDisclosure: "Fixture requests are not retained.",
    },
    service: {
      async *stream(request) {
        received = request;
        yield {
          message: "No published answer was available.",
          reason: "insufficient-evidence",
          type: "abstention",
        };
      },
      validate() {},
    },
  };
  const answerRequest = (body: unknown) =>
    new Request(`${embedOrigin}/api/answers`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json; charset=utf-8" },
      method: "POST",
    });

  const response = await handleAnswerRequest(
    answerRequest({
      currentPagePath: "/account/reset-password",
      question: "Summarize this page",
    }),
    {
      createRuntime: async () => runtime,
      loadPublications: async () => publishedArticles,
    },
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(received?.currentPage, {
    articleId: "article_password",
    path: "/account/reset-password",
    title: "Reset your password",
  });
  assert.deepEqual(received?.history, undefined);

  let runtimeCalls = 0;
  const forged = await handleAnswerRequest(
    answerRequest({
      currentPagePath: "/drafts/secret",
      question: "Summarize this page",
    }),
    {
      createRuntime: async () => {
        runtimeCalls += 1;
        return runtime;
      },
      loadPublications: async () => publishedArticles,
    },
  );
  assert.equal(forged.status, 400);
  assert.equal(runtimeCalls, 0);

  const clientOwnedMetadata = await handleAnswerRequest(
    answerRequest({
      currentPage: {
        articleId: "article_secret",
        path: "/drafts/secret",
        title: "Secret draft",
      },
      question: "Summarize this page",
    }),
    { createRuntime: async () => runtime },
  );
  assert.equal(clientOwnedMetadata.status, 400);
});

test("rejects denied origins, arbitrary page text, unsafe URLs, and oversized context", async (context) => {
  const fixtures: Array<{
    body: unknown;
    expectedStatus: number;
    name: string;
  }> = [
    {
      body: {
        pageUrl: "https://attacker.test/account/reset-password",
        parentOrigin: "https://attacker.test",
      },
      expectedStatus: 403,
      name: "denied parent",
    },
    {
      body: {
        pageText: "private text copied from the host document",
        pageUrl: `${parentOrigin}/account/reset-password`,
        parentOrigin,
      },
      expectedStatus: 400,
      name: "arbitrary page text",
    },
    {
      body: {
        pageUrl: "javascript:alert(1)",
        parentOrigin,
      },
      expectedStatus: 400,
      name: "unsafe protocol",
    },
    {
      body: {
        pageUrl: `${secondParentOrigin}/account/reset-password`,
        parentOrigin,
      },
      expectedStatus: 400,
      name: "URL origin mismatch",
    },
  ];

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const response = await handleEmbedContextRequest(
        contextRequest(fixture.body),
        configuredContextDependencies(),
      );
      assert.equal(response.status, fixture.expectedStatus);
      assert.deepEqual(await response.json(), { error: "invalid-request" });
    });
  }

  const oversized = await handleEmbedContextRequest(
    contextRequest("x".repeat(maximumEmbedContextRequestUtf8Bytes + 1)),
    configuredContextDependencies(),
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "invalid-request" });

  const wrongContentType = await handleEmbedContextRequest(
    contextRequest("{}", { "content-type": "text/plain" }),
    configuredContextDependencies(),
  );
  assert.equal(wrongContentType.status, 415);
});

test("loader sends only the bounded page URL and rejects forged child messages", () => {
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const windowListeners = new Map<string, (event: unknown) => void>();
  const iframeListeners = new Map<string, () => void>();
  const appended: unknown[] = [];
  const iframeWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  };
  const iframe = {
    addEventListener(type: string, listener: () => void) {
      iframeListeners.set(type, listener);
    },
    contentWindow: iframeWindow,
    dataset: {} as Record<string, string>,
    referrerPolicy: "",
    sandbox: { value: "", add(...tokens: string[]) { this.value = tokens.join(" "); } },
    src: "",
    style: {} as Record<string, string>,
    title: "",
  };
  const currentScript = { src: `${embedOrigin}/embed.js` };
  const document = {
    body: { append(value: unknown) { appended.push(value); } },
    createElement(tagName: string) {
      assert.equal(tagName, "iframe");
      return iframe;
    },
    currentScript,
  };
  const window = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      windowListeners.set(type, listener);
    },
    location: new URL(`${parentOrigin}/account/reset-password?from=product#security`),
  };

  vm.runInNewContext(embedLoaderScript, {
    document,
    JSON,
    Number,
    Object,
    TextEncoder,
    URL,
    window,
  });

  assert.deepEqual(appended, [iframe]);
  assert.equal(
    iframe.src,
    `${embedOrigin}/embed?parentOrigin=${encodeURIComponent(parentOrigin)}`,
  );
  assert.equal(iframe.referrerPolicy, "no-referrer");
  assert.equal(
    iframe.sandbox.value,
    "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
  );
  assert.equal(iframe.title, "OPAS help assistant");
  assert.equal(posted.length, 0);

  const receive = windowListeners.get("message");
  assert.ok(receive);
  receive({
    data: { type: "opas:ready", version: 1 },
    origin: "https://attacker.test",
    source: iframeWindow,
  });
  receive({
    data: { type: "opas:ready", version: 1 },
    origin: embedOrigin,
    source: {},
  });
  assert.equal(posted.length, 0);

  receive({
    data: { type: "opas:ready", version: 1 },
    origin: embedOrigin,
    source: iframeWindow,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
    {
      message: {
        pageUrl: `${parentOrigin}/account/reset-password?from=product#security`,
        type: "opas:context",
        version: 1,
      },
      targetOrigin: embedOrigin,
    },
  ]);

  receive({
    data: { height: 780, type: "opas:resize", version: 1 },
    origin: embedOrigin,
    source: iframeWindow,
  });
  assert.equal(iframe.style.height, "780px");
  receive({
    data: { height: 5_000, type: "opas:resize", version: 1 },
    origin: embedOrigin,
    source: iframeWindow,
  });
  assert.equal(iframe.style.height, "780px");

  assert.doesNotMatch(
    embedLoaderScript,
    /innerText|textContent|innerHTML|document\.head|createElement\(["']style|eval\(|new Function|postMessage\([^)]*,\s*["']\*["']/u,
  );
});

test("renders an accessible isolated assistant without runtime MDX or host-page styles", async () => {
  const markup = renderToStaticMarkup(<EmbedAssistant parentOrigin={parentOrigin} />);
  const [css, pageSource, assistantSource] = await Promise.all([
    readFile(new URL("../src/app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../src/app/embed/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/embed/embed-assistant.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(markup, /<main[^>]+class="embed-shell"/u);
  assert.match(markup, /<h1[^>]*>Ask the help center<\/h1>/u);
  assert.match(markup, /role="status"/u);
  assert.match(markup, /Published sources only/u);
  assert.match(css, /body:has\(\.embed-shell\)[\s\S]*min-width:\s*0/u);
  assert.match(css, /\.embed-shell[\s\S]*overflow-wrap:\s*anywhere/u);
  assert.match(assistantSource, /citationNavigation="new-tab"/u);
  assert.doesNotMatch(`${pageSource}\n${assistantSource}`, /RuntimeMdx|dangerouslySetInnerHTML/u);
  assert.doesNotMatch(embedLoaderScript, /appendChild\([^)]*style|insertRule/u);
});
