// ABOUTME: Delivers validated support handoffs through fixed email or webhook destinations.
// ABOUTME: Uses structured messages, strict HTTPS targets, redirect rejection, and safe errors.
import type { EmailMessageBuilder, SendEmail } from "@cloudflare/workers-types";

import { HandoffError } from "@/handoff/errors";
import {
  normalizeHandoffEmailAddress,
  normalizeHandoffIdempotencyKey,
  normalizeHandoffPayload,
  type HandoffOutcome,
  type HandoffPayload,
} from "@/handoff/payload";

export type CloudflareEmailBinding = Pick<SendEmail, "send">;

export type HandoffDeliveryRequest = Readonly<{
  idempotencyKey: string;
  payload: HandoffPayload;
  signal?: AbortSignal;
}>;

export interface HandoffDelivery {
  send(request: HandoffDeliveryRequest): Promise<void>;
}

export type HandoffHostnameResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export type HandoffNodeHttpsRequest = (request: Readonly<{
  body: string;
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  pinnedAddress: string;
  signal?: AbortSignal;
}>) => Promise<void>;

type FetchDeliveryOptions = Readonly<{
  fetch?: typeof fetch;
}>;

type NodeDeliveryOptions = Readonly<{
  request?: HandoffNodeHttpsRequest;
  resolveHostname?: HandoffHostnameResolver;
}>;

type EmailDestination = Readonly<{
  from: string;
  to: string;
}>;

type EmailDocument = Readonly<{
  html: string;
  subject: string;
  text: string;
}>;

const outcomeLabels: Readonly<Record<HandoffOutcome, string>> = Object.freeze({
  abstained: "Abstained answer",
  "low-rated": "Low-rated answer",
  "user-requested": "Reader request",
});

function configuration(): never {
  throw new HandoffError("configuration");
}

function configuredEmail(value: unknown) {
  const normalized = normalizeHandoffEmailAddress(value);
  if (!normalized || normalized !== value) return configuration();
  return normalized;
}

function configuredSecret(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 16_384 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    return configuration();
  }
  return value;
}

function emailDestination(value: EmailDestination) {
  return Object.freeze({
    from: configuredEmail(value.from),
    to: configuredEmail(value.to),
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlText(value: string) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function emailDocument(payload: HandoffPayload): EmailDocument {
  const outcome = outcomeLabels[payload.outcome];
  const contactName = payload.contact.name
    ? `<p><strong>Reader:</strong> ${escapeHtml(payload.contact.name)}</p>`
    : "";
  const transcript = payload.transcript
    .map(
      (message) =>
        `<li><strong>${message.role === "user" ? "Reader" : "Assistant"}:</strong> ${htmlText(message.content)}</li>`,
    )
    .join("");
  const citations =
    payload.citations.length === 0
      ? "<p>No published citation accompanied this handoff.</p>"
      : `<ol>${payload.citations
          .map((citation) => {
            const heading =
              citation.headingPath.length > 0
                ? ` · ${escapeHtml(citation.headingPath.join(" › "))}`
                : "";
            return `<li><a href="${escapeHtml(citation.canonicalUrl)}">${escapeHtml(citation.title)}</a>${heading}</li>`;
          })
          .join("")}</ol>`;
  const textCitations =
    payload.citations.length === 0
      ? "- No published citation accompanied this handoff."
      : payload.citations
          .map(
            (citation, index) =>
              `${index + 1}. ${citation.title}${
                citation.headingPath.length > 0
                  ? ` · ${citation.headingPath.join(" › ")}`
                  : ""
              }\n   ${citation.canonicalUrl}`,
          )
          .join("\n");
  const textTranscript = payload.transcript
    .map(
      (message) =>
        `${message.role === "user" ? "Reader" : "Assistant"}: ${message.content}`,
    )
    .join("\n\n");

  return Object.freeze({
    html: [
      "<h1>OPAS support handoff</h1>",
      `<p><strong>Outcome:</strong> ${outcome}</p>`,
      contactName,
      `<p><strong>Reply email:</strong> ${escapeHtml(payload.contact.email)}</p>`,
      `<p><strong>Page:</strong> <a href="${escapeHtml(payload.pageUrl)}">${escapeHtml(payload.pageUrl)}</a></p>`,
      `<h2>Question</h2><p>${htmlText(payload.question)}</p>`,
      `<h2>Transcript</h2><ol>${transcript}</ol>`,
      `<h2>Published citations</h2>${citations}`,
    ].join(""),
    subject: `OPAS support handoff · ${outcome}`,
    text: [
      "OPAS support handoff",
      `Outcome: ${outcome}`,
      ...(payload.contact.name ? [`Reader: ${payload.contact.name}`] : []),
      `Reply email: ${payload.contact.email}`,
      `Page: ${payload.pageUrl}`,
      "",
      "Question",
      payload.question,
      "",
      "Transcript",
      textTranscript,
      "",
      "Published citations",
      textCitations,
    ].join("\n"),
  });
}

function preparedRequest(request: HandoffDeliveryRequest) {
  if (request.signal?.aborted) throw new HandoffError("cancelled");
  return Object.freeze({
    idempotencyKey: normalizeHandoffIdempotencyKey(request.idempotencyKey),
    payload: normalizeHandoffPayload(request.payload),
    signal: request.signal,
  });
}

function isIpLiteral(hostname: string) {
  return (
    hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function ipv4Bytes(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) =>
    /^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN,
  );
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : null;
}

function ipv6Bytes(value: string) {
  let candidate = value.toLowerCase();
  if (candidate.includes("%")) return null;
  if (candidate.includes(".")) {
    const separator = candidate.lastIndexOf(":");
    const ipv4 = ipv4Bytes(candidate.slice(separator + 1));
    if (separator < 0 || !ipv4) return null;
    candidate = `${candidate.slice(0, separator)}:${(
      (ipv4[0]! << 8) |
      ipv4[1]!
    ).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = candidate.split("::");
  if (halves.length > 2) return null;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  if (
    groups.some((group) => !/^[\da-f]{1,4}$/u.test(group)) ||
    (halves.length === 1 && groups.length !== 8) ||
    (halves.length === 2 && groups.length >= 8)
  ) {
    return null;
  }
  const missing = halves.length === 2 ? 8 - groups.length : 0;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const expanded = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (expanded.length !== 8) return null;
  return expanded.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >> 8, number & 255];
  });
}

function publicIpv4(value: string) {
  const bytes = ipv4Bytes(value);
  if (!bytes) return false;
  const [first, second, third] = bytes;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first! >= 224 ||
    (first === 100 && second! >= 64 && second! <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function publicIpv6(value: string) {
  const bytes = ipv6Bytes(value);
  if (!bytes) return false;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255;
  if (ipv4Mapped) {
    return publicIpv4(bytes.slice(12).join("."));
  }
  const globalUnicast = (bytes[0]! & 0xe0) === 0x20;
  const documentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  const benchmarking =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x02;
  const retired6Bone = bytes[0] === 0x3f && bytes[1] === 0xfe;
  return globalUnicast && !documentation && !benchmarking && !retired6Bone;
}

function publicResolvedAddress(value: string) {
  return value.includes(":") ? publicIpv6(value) : publicIpv4(value);
}

async function validatePublicResolution(
  endpoint: string,
  resolveHostname: HandoffHostnameResolver,
) {
  let addresses: readonly string[];
  try {
    addresses = await resolveHostname(new URL(endpoint).hostname);
  } catch {
    throw new HandoffError("delivery-failed");
  }
  if (
    addresses.length < 1 ||
    addresses.length > 16 ||
    addresses.some((address) => !publicResolvedAddress(address))
  ) {
    throw new HandoffError("delivery-failed");
  }
  return addresses[0]!;
}

function publicHttpsEndpoint(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    return configuration();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return configuration();
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
  const blockedSuffixes = [
    ".home",
    ".home.arpa",
    ".internal",
    ".intranet",
    ".lan",
    ".local",
    ".localdomain",
    ".localhost",
  ];
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    isIpLiteral(hostname) ||
    blockedSuffixes.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    return configuration();
  }
  return endpoint.toString();
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response bodies are never consumed because they may contain private data.
  }
}

async function postJson(
  fetchImplementation: typeof fetch,
  endpoint: string,
  body: unknown,
  headers: Headers,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new HandoffError("cancelled");
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      headers,
      method: "POST",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new HandoffError(signal?.aborted ? "cancelled" : "delivery-failed");
  }
  await cancelResponseBody(response);
  if (!response.ok || response.redirected) {
    throw new HandoffError("delivery-failed");
  }
}

function fetchImplementation(value: typeof fetch | undefined) {
  const selected = value ?? globalThis.fetch;
  if (typeof selected !== "function") return configuration();
  return selected;
}

async function nodeHostnameResolver(hostname: string) {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address,
  );
}

export async function sendPinnedWebhookRequest(
  request: Parameters<HandoffNodeHttpsRequest>[0],
) {
  if (request.signal?.aborted) throw new HandoffError("cancelled");
  const [{ request: send }, { isIP }] = await Promise.all([
    import("node:https"),
    import("node:net"),
  ]);
  const endpoint = new URL(request.endpoint);
  const family = isIP(request.pinnedAddress);
  if (family !== 4 && family !== 6) throw new HandoffError("delivery-failed");
  await new Promise<void>((resolve, reject) => {
    const outbound = send(
      endpoint,
      {
        headers: {
          ...request.headers,
          "Content-Length": String(new TextEncoder().encode(request.body).byteLength),
        },
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) {
            callback(null, [
              { address: request.pinnedAddress, family },
            ]);
            return;
          }
          callback(null, request.pinnedAddress, family);
        },
        method: "POST",
        servername: endpoint.hostname,
        signal: request.signal,
      },
      (response) => {
        const accepted =
          typeof response.statusCode === "number" &&
          response.statusCode >= 200 &&
          response.statusCode < 300;
        response.destroy();
        if (accepted) resolve();
        else reject(new HandoffError("delivery-failed"));
      },
    );
    outbound.once("error", (error) => reject(error));
    outbound.end(request.body);
  });
}

export function createCloudflareEmailDelivery(
  options: EmailDestination & Readonly<{ binding: CloudflareEmailBinding }>,
): HandoffDelivery {
  if (!options.binding || typeof options.binding.send !== "function") {
    return configuration();
  }
  const destination = emailDestination(options);
  const binding = options.binding;
  return Object.freeze({
    async send(request: HandoffDeliveryRequest) {
      const prepared = preparedRequest(request);
      const document = emailDocument(prepared.payload);
      const message: EmailMessageBuilder = {
        from: destination.from,
        headers: { "X-OPAS-Handoff-ID": prepared.idempotencyKey },
        html: document.html,
        replyTo: prepared.payload.contact.email,
        subject: document.subject,
        text: document.text,
        to: destination.to,
      };
      try {
        await binding.send(message);
      } catch {
        throw new HandoffError("delivery-failed");
      }
    },
  });
}

export function createCloudflareRestEmailDelivery(
  options: EmailDestination &
    FetchDeliveryOptions &
    Readonly<{ accountId: string; apiToken: string }>,
): HandoffDelivery {
  if (!/^[a-f\d]{32}$/u.test(options.accountId)) return configuration();
  const destination = emailDestination(options);
  const token = configuredSecret(options.apiToken);
  const send = fetchImplementation(options.fetch);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/email/sending/send`;
  return Object.freeze({
    async send(request: HandoffDeliveryRequest) {
      const prepared = preparedRequest(request);
      const document = emailDocument(prepared.payload);
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      });
      await postJson(
        send,
        endpoint,
        {
          from: destination.from,
          headers: { "X-OPAS-Handoff-ID": prepared.idempotencyKey },
          html: document.html,
          reply_to: prepared.payload.contact.email,
          subject: document.subject,
          text: document.text,
          to: destination.to,
        },
        headers,
        prepared.signal,
      );
    },
  });
}

export function createCloudflareWebhookDelivery(
  options: FetchDeliveryOptions &
    Readonly<{ endpoint: string; token?: string }>,
): HandoffDelivery {
  const endpoint = publicHttpsEndpoint(options.endpoint);
  const token = options.token === undefined ? undefined : configuredSecret(options.token);
  const send = fetchImplementation(options.fetch);
  return Object.freeze({
    async send(request: HandoffDeliveryRequest) {
      const prepared = preparedRequest(request);
      const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": prepared.idempotencyKey,
      });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      await postJson(
        send,
        endpoint,
        {
          handoff: prepared.payload,
          idempotencyKey: prepared.idempotencyKey,
          type: "opas.support-handoff",
          version: 1,
        },
        headers,
        prepared.signal,
      );
    },
  });
}

export function createNodeWebhookDelivery(
  options: NodeDeliveryOptions &
    Readonly<{ endpoint: string; token?: string }>,
): HandoffDelivery {
  const endpoint = publicHttpsEndpoint(options.endpoint);
  const token = options.token === undefined ? undefined : configuredSecret(options.token);
  const resolveHostname = options.resolveHostname ?? nodeHostnameResolver;
  const send = options.request ?? sendPinnedWebhookRequest;
  return Object.freeze({
    async send(request: HandoffDeliveryRequest) {
      const prepared = preparedRequest(request);
      const pinnedAddress = await validatePublicResolution(
        endpoint,
        resolveHostname,
      );
      const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": prepared.idempotencyKey,
      });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      try {
        await send({
          body: JSON.stringify({
            handoff: prepared.payload,
            idempotencyKey: prepared.idempotencyKey,
            type: "opas.support-handoff",
            version: 1,
          }),
          endpoint,
          headers: Object.freeze(Object.fromEntries(headers.entries())),
          pinnedAddress,
          signal: prepared.signal,
        });
      } catch (error) {
        if (error instanceof HandoffError) throw error;
        throw new HandoffError(
          prepared.signal?.aborted ? "cancelled" : "delivery-failed",
        );
      }
    },
  });
}
