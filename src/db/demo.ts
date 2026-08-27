// ABOUTME: Defines the deterministic workspace, content, and theme seeded by every deployment.
// ABOUTME: Keeps Postgres, Neon, and D1 demo records semantically identical.
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
    config: {
      logoUrl: null,
      fonts: {
        sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      },
      radius: {
        sm: "0.375rem",
        md: "0.75rem",
      },
      light: {
        background: "oklch(1 0 0)",
        surface: "oklch(0.975 0 0)",
        surfaceStrong: "oklch(0.94 0.005 27)",
        foreground: "oklch(0.2 0.018 27)",
        muted: "oklch(0.46 0.014 27)",
        border: "oklch(0.88 0.009 27)",
        primary: "oklch(0.464 0.169 26.9)",
        primaryForeground: "oklch(1 0 0)",
        focus: "oklch(0.62 0.18 27)",
      },
      dark: {
        background: "oklch(0.17 0.014 27)",
        surface: "oklch(0.21 0.014 27)",
        surfaceStrong: "oklch(0.26 0.016 27)",
        foreground: "oklch(0.95 0.006 27)",
        muted: "oklch(0.72 0.012 27)",
        border: "oklch(0.34 0.016 27)",
        primary: "oklch(0.69 0.2 27)",
        primaryForeground: "oklch(0.16 0.014 27)",
        focus: "oklch(0.75 0.18 27)",
      },
    },
  },
} as const;
