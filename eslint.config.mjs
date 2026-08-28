// ABOUTME: Defines the lint rules for Next.js, React, and TypeScript source files.
// ABOUTME: Excludes generated deployment output while retaining strict framework checks.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".vercel/**",
    ".wrangler/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "out/**",
    "worker-configuration.d.ts",
  ]),
]);
