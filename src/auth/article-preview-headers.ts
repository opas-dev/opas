// ABOUTME: Defines the private response policy shared by preview pages and assets.
// ABOUTME: Prevents caching, indexing, framing, and referrer disclosure for preview content.

import { contentSecurityPolicy } from "@/security/headers";

export const articlePreviewResponseHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": contentSecurityPolicy,
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

export function applyArticlePreviewResponseHeaders(headers: Headers) {
  for (const [name, value] of Object.entries(articlePreviewResponseHeaders)) {
    headers.set(name, value);
  }
}
