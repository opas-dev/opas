// ABOUTME: Defines the response headers that isolate the public MCP endpoint.
// ABOUTME: Shares one policy between Next route configuration and direct MCP responses.
export const mcpResponseHeaders = Object.freeze([
  { key: "Cache-Control", value: "no-store, no-transform" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
]);
