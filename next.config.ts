// ABOUTME: Configures the shared Next.js build used by every OPAS deployment target.
// ABOUTME: Produces a standalone Node server artifact for container packaging.
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

import { embedParentOrigins } from "./src/embed/config";
import {
  createEmbedContentSecurityPolicy,
  securityHeaders,
} from "./src/security/headers";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg-cloudflare"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          {
            key: "Link",
            value:
              '</llms.txt>; rel="llms-txt", </llms-full.txt>; rel="llms-full-txt"',
          },
          {
            key: "X-Llms-Txt",
            value: "/llms.txt",
          },
        ],
      },
      {
        source: "/embed",
        headers: [
          {
            key: "Content-Security-Policy",
            value: createEmbedContentSecurityPolicy(embedParentOrigins()),
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: "/:categorySlug/:articleSlug\\.md",
          destination: "/api/markdown/:categorySlug/:articleSlug",
        },
      ],
      fallback: [],
    };
  },
  turbopack: {
    resolveAlias: {
      "fumadocs-core/mdx-plugins": "./src/content/runtime-mdx-plugins.ts",
    },
  },
};

export default nextConfig;

if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}
