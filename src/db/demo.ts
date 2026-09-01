// ABOUTME: Defines the deterministic workspace, content, and theme seeded by every deployment.
// ABOUTME: Keeps Postgres, Neon, and D1 demo records semantically identical.
import { themePresets } from "@/theme/presets";

export const demoIds = {
  workspace: "workspace_demo",
  gettingStartedCategory: "category_getting_started",
  customizationCategory: "category_customization",
  answersCategory: "category_answers",
  deploymentCategory: "category_deployment",
  publishedArticle: "article_runtime_mdx",
  draftArticle: "article_customize_help_center",
  whatIsOpasArticle: "article_what_is_opas",
  contentOwnershipArticle: "article_content_ownership",
  groundedAnswersArticle: "article_grounded_answers",
  answerUncertaintyArticle: "article_answer_uncertainty",
  visualAuthoringArticle: "article_visual_authoring",
  runtimeThemesArticle: "article_runtime_themes",
  deploymentTargetsArticle: "article_deployment_targets",
  agentAccessArticle: "article_agent_access",
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
    {
      id: demoIds.answersCategory,
      workspaceId: demoIds.workspace,
      slug: "answers",
      name: "Answers",
      description: "How OPAS finds evidence, cites sources, and handles uncertainty.",
      position: 2,
    },
    {
      id: demoIds.deploymentCategory,
      workspaceId: demoIds.workspace,
      slug: "deployment",
      name: "Deployment and agents",
      description: "Run OPAS where you choose and publish content for people and agents.",
      position: 3,
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
      id: demoIds.whatIsOpasArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.gettingStartedCategory,
      slug: "what-is-opas",
      title: "What is OPAS?",
      mdx: `# What is OPAS?

OPAS is an open-source help center for publishing support content and answering reader questions from that content.

Teams can write in a visual editor or Markdown, publish without rebuilding the application, apply a complete runtime theme, and keep control of their infrastructure and data.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 1,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.contentOwnershipArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.gettingStartedCategory,
      slug: "who-owns-opas-content",
      title: "Who owns the content in OPAS?",
      mdx: `# Who owns the content in OPAS?

The team operating OPAS owns its help content, database, deployment, and theme. The core product is licensed under AGPL-3.0 and can be run on infrastructure the team controls.

Published articles remain available as normal web pages and portable Markdown rather than being locked inside a proprietary editor.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 2,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.visualAuthoringArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "can-i-edit-visually-and-in-markdown",
      title: "Can I edit visually and in Markdown?",
      mdx: `# Can I edit visually and in Markdown?

Yes. The article editor supports visual authoring and direct Markdown source editing, with live preview, draft and published states, image assets, and validation before content is saved.

Both modes write the same portable article source, so authors can use the workflow that fits the change.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 0,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.runtimeThemesArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "can-opas-match-my-brand",
      title: "Can OPAS match my brand?",
      mdx: `# Can OPAS match my brand?

Yes. OPAS stores a complete semantic theme in the deployment database, including light and dark colors, typography, radii, and a logo.

Theme changes take effect at request time without rebuilding the application. The CROFusion demo is the same OPAS product with a separate theme and content set.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 1,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.groundedAnswersArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.answersCategory,
      slug: "how-do-grounded-answers-work",
      title: "How do source-grounded answers work?",
      mdx: `# How do source-grounded answers work?

OPAS searches the published knowledge base, retrieves relevant evidence, and asks the configured model to answer only from those sources.

Every accepted answer links back to the supporting article. Conversation outcomes and feedback can be retained for quality review under the deployment's configured privacy policy.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 0,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.answerUncertaintyArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.answersCategory,
      slug: "what-if-opas-is-not-sure",
      title: "What happens when OPAS is not sure?",
      mdx: `# What happens when OPAS is not sure?

OPAS abstains when the published evidence is missing, conflicting, unsafe, or too weak to support an answer. It does not turn an unsupported guess into help-center policy.

The reader can continue with search or send a bounded support handoff, while the unanswered question becomes useful input for improving the knowledge base.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 1,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.deploymentTargetsArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.deploymentCategory,
      slug: "where-can-i-deploy-opas",
      title: "Where can I deploy OPAS?",
      mdx: `# Where can I deploy OPAS?

OPAS runs as a Docker deployment with PostgreSQL, on Vercel with Neon, or on Cloudflare Workers with D1.

The same repository contract and database-backed content model are verified across those targets, so a help center is not tied to one hosting vendor.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 0,
      publishedAt: demoSeededAt,
    },
    {
      id: demoIds.agentAccessArticle,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.deploymentCategory,
      slug: "how-can-agents-read-opas",
      title: "How can AI agents read OPAS?",
      mdx: `# How can AI agents read OPAS?

Every deployment can publish compact and full LLM indexes, a Markdown version of each article, and a read-only MCP endpoint for search and article retrieval.

Those machine-readable surfaces come from the same published records readers see in the browser, so there is one source of truth.`,
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      position: 1,
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
