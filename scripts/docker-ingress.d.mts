// ABOUTME: Types the Docker ingress header sanitizer for deployment contract tests.
// ABOUTME: Keeps the executable proxy dependency-free while preserving strict TypeScript checks.
import type { IncomingHttpHeaders, Server } from "node:http";

export function ingressRequestHeaders(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
): IncomingHttpHeaders;

export function createIngressServer(): Server;
