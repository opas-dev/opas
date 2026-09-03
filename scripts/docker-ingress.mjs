// ABOUTME: Proxies Docker HTTP traffic onto the private OPAS application network.
// ABOUTME: Rebuilds the sole trusted login-source header from the client socket address.
import http from "node:http";

const listenPort = Number.parseInt(process.env.PORT ?? "8080", 10);
const upstreamHost = process.env.OPAS_UPSTREAM_HOST ?? "app";
const upstreamPort = Number.parseInt(process.env.OPAS_UPSTREAM_PORT ?? "3000", 10);
const trustedSourceHeader = "x-opas-client-address";
const untrustedSourceHeaders = [
  trustedSourceHeader,
  "cf-connecting-ip",
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "x-vercel-forwarded-for",
];
const hopByHopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function connectionHeaders(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function ingressRequestHeaders(headers, remoteAddress) {
  if (typeof remoteAddress !== "string" || remoteAddress.length === 0) {
    throw new Error("DOCKER_CLIENT_ADDRESS_UNAVAILABLE");
  }
  const sanitized = { ...headers };
  for (const name of [
    ...untrustedSourceHeaders,
    ...hopByHopHeaders,
    ...connectionHeaders(headers.connection),
  ]) {
    delete sanitized[name];
  }
  sanitized[trustedSourceHeader] = remoteAddress;
  return sanitized;
}

function responseHeaders(headers) {
  const sanitized = { ...headers };
  for (const name of [...hopByHopHeaders, ...connectionHeaders(headers.connection)]) {
    delete sanitized[name];
  }
  return sanitized;
}

export function createIngressServer() {
  return http.createServer((request, response) => {
    let headers;
    try {
      headers = ingressRequestHeaders(request.headers, request.socket.remoteAddress);
    } catch {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Service Unavailable\n");
      return;
    }

    const upstream = http.request(
      {
        headers,
        host: upstreamHost,
        method: request.method,
        path: request.url,
        port: upstreamPort,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("Bad Gateway\n");
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error("The Docker ingress port is invalid.");
  }
  createIngressServer().listen(listenPort, "0.0.0.0");
}
