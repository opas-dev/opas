// ABOUTME: Configures the shared Next.js build used by every OPAS deployment target.
// ABOUTME: Produces a standalone Node server artifact for container packaging.
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg-cloudflare"],
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
