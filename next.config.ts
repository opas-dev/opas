// ABOUTME: Configures the shared Next.js build used by every OPAS deployment target.
// ABOUTME: Produces a standalone Node server artifact for container packaging.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
