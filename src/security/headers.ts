// ABOUTME: Defines the browser security policy applied to every OPAS response.
// ABOUTME: Keeps runtime MDX viable while restricting unrelated browser capabilities.

export const contentSecurityPolicy = [
  "default-src 'self'",
  // Validated database-stored MDX uses the Function constructor in the browser on workerd.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
] satisfies Array<{ key: string; value: string }>;
