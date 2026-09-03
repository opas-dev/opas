// ABOUTME: Defines the fixed public-safe CROFusion help-center seed profile.
// ABOUTME: Keeps its categories, articles, and theme independent from the generic OPAS demo.
import { demoIds } from "@/db/demo";
import { themePresets } from "@/theme/presets";

export const crofusionDemoSeededAt = "2026-08-31T05:00:00.000Z";

export const crofusionDemoContent = {
  workspace: {
    id: demoIds.workspace,
    slug: "demo",
    name: "CROFusion Help Center",
  },
  categories: [
    {
      id: "category_crofusion_getting_started",
      workspaceId: demoIds.workspace,
      slug: "getting-started",
      name: "Getting started",
      description: "Start creating with a clear brief and the right brand inputs.",
      position: 0,
    },
    {
      id: "category_crofusion_landing_pages",
      workspaceId: demoIds.workspace,
      slug: "landing-pages",
      name: "Landing pages",
      description: "Generate and improve conversion-focused landing pages in the browser.",
      position: 1,
    },
    {
      id: "category_crofusion_services",
      workspaceId: demoIds.workspace,
      slug: "managed-services",
      name: "Managed services",
      description: "Choose the delivery model and specialist support that fit your team.",
      position: 2,
    },
  ],
  articles: [
    {
      id: "article_crofusion_platform_access",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_getting_started",
      slug: "is-crofusion-browser-based",
      title: "Is CROFusion browser-based?",
      mdx: `# Is CROFusion browser-based?

Yes. CROFusion is fully cloud-based, so there is no software to download, install, maintain, or support with a separate IT setup.

Use CROFusion from a desktop device in Chrome, Safari, Firefox, or Edge. Updates arrive automatically through the platform.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 0,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_generation_prompt",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_getting_started",
      slug: "what-should-i-include-in-my-brief",
      title: "What should I include in my landing page brief?",
      mdx: `# What should I include in my landing page brief?

Describe the brand, the intended audience, and the conversion goal. Those three details give CROFusion useful direction for the page structure and copy.

The public generator currently accepts a prompt of up to 2,000 characters.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 1,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_brand_inputs",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_getting_started",
      slug: "which-brand-inputs-can-i-add",
      title: "Which brand inputs can I add?",
      mdx: `# Which brand inputs can I add?

You can optionally provide colors, a logo, a heading font, and a page font during generation.

These inputs help the result match the visual brand, while the audience and conversion goal guide the content.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 2,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_conversion_optimization",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_landing_pages",
      slug: "what-does-crofusion-generate-and-optimize",
      title: "What does CROFusion generate and optimize?",
      mdx: `# What does CROFusion generate and optimize?

CROFusion generates and optimizes conversion-focused landing pages. Its AI-assisted workflow can support behavioral analysis, experimentation, and iterative page improvement.

Optimization can improve the evidence behind a decision, but it does not guarantee a specific conversion result.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 0,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_self_service",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_landing_pages",
      slug: "can-i-use-crofusion-without-a-developer",
      title: "Can I use CROFusion without a developer?",
      mdx: `# Can I use CROFusion without a developer?

Yes. The self-service platform is browser-based and is designed for businesses that want to generate and optimize landing pages directly.

It does not require a software download or a developer dependency for normal use.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 1,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_managed_services",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_services",
      slug: "what-is-included-in-managed-services",
      title: "What is included in managed marketing services?",
      mdx: `# What is included in managed marketing services?

The managed option includes digital marketing consulting, online advertising management, demand generation, and lead generation.

The team works alongside the business to plan, launch, and optimize campaigns.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 0,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_managed_team",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_services",
      slug: "who-works-on-a-managed-campaign",
      title: "Who works on a managed campaign?",
      mdx: `# Who works on a managed campaign?

The fully managed offer names a conversion strategist, a paid media analyst, and a copywriter.

Their work covers campaign strategy, audience setup, landing page generation, ongoing A/B testing, optimization, performance tracking, and weekly reporting.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 1,
      publishedAt: crofusionDemoSeededAt,
    },
    {
      id: "article_crofusion_delivery_choice",
      workspaceId: demoIds.workspace,
      categoryId: "category_crofusion_services",
      slug: "should-i-choose-self-service-or-managed",
      title: "Should I choose self-service or managed?",
      mdx: `# Should I choose self-service or managed?

Choose self-service when your team wants to operate the software directly. Choose managed service when the business wants campaign specialists working alongside the platform.

Both paths use CROFusion; the difference is how much operational support the team wants.`,
      status: "published",
      isFaq: true,
      authorName: "CROFusion",
      position: 2,
      publishedAt: crofusionDemoSeededAt,
    },
  ],
  theme: {
    id: demoIds.theme,
    workspaceId: demoIds.workspace,
    name: "CROFusion",
    config: themePresets.crofusion,
  },
} as const;
