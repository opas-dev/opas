// ABOUTME: Defines the deterministic workspace, content, and theme seeded by every deployment.
// ABOUTME: Keeps Postgres, Neon, and D1 demo records semantically identical.
import { themePresets } from "@/theme/presets";

export const demoIds = {
  workspace: "workspace_demo",
  gettingStartedCategory: "category_getting_started",
  customizationCategory: "category_customization",
  publishedArticle: "article_runtime_mdx",
  draftArticle: "article_customize_help_center",
  theme: "theme_default",
} as const;

export const demoSeededAt = "2026-01-01T00:00:00.000Z";

export const demoContent = {
  workspace: {
    id: demoIds.workspace,
    slug: "demo",
    name: "OPAS Demo",
  },
  categories: [
    {
      id: demoIds.gettingStartedCategory,
      workspaceId: demoIds.workspace,
      slug: "getting-started",
      name: "Getting started",
      description: "The essentials for running and shaping OPAS.",
      position: 0,
    },
    {
      id: demoIds.customizationCategory,
      workspaceId: demoIds.workspace,
      slug: "customization",
      name: "Customization",
      description: "Make the help center match your product and voice.",
      position: 1,
    },
  ],
  articles: [
    {
      id: demoIds.publishedArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.gettingStartedCategory,
      slug: "runtime-mdx",
      title: "Runtime MDX in OPAS",
      mdx: `# Runtime MDX in OPAS

This article is loaded from the deployment database through **Drizzle ORM** and compiled when the request arrives.

> Edit this article, reload the page, and OPAS renders the updated answer without rebuilding.

The same content model runs on Docker, Vercel, and Cloudflare Workers.`,
      status: "published",
      isFaq: false,
      authorName: "OPAS",
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.draftArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "customize-your-help-center",
      title: "Customize your help center",
      mdx: `# Customize your help center

This draft explains how runtime themes let OPAS match your product without rebuilding the application.`,
      status: "draft",
      isFaq: false,
      authorName: "OPAS",
      publishedAt: null,
    },
  ],
  theme: {
    id: demoIds.theme,
    workspaceId: demoIds.workspace,
    name: "OPAS Default",
    config: themePresets.opas,
  },
} as const;
