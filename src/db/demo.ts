// ABOUTME: Provides stable identifiers for the seeded single-workspace OPAS demo.
// ABOUTME: Lets every deployment target serve the same initial content without lookup ambiguity.
export const demoIds = {
  workspace: "workspace_demo",
  category: "category_getting_started",
  article: "article_runtime_mdx",
} as const;
