// ABOUTME: Defines the frozen portable acceptance fixture for team-safe article authoring.
// ABOUTME: Covers roles, revisions, retained media, archive recovery, and bounded bulk import.

import type { ArticleRevisionSnapshot } from "@/content/article-revision";

const workspaceId = "workspace_team_authoring_standard";
const firstAssetHash = "1".repeat(64);
const secondAssetHash = "2".repeat(64);
const largeHeading = "# Large authoring guide\n\n";
const largeParagraph = "A deterministic paragraph for revision capacity testing.\n\n";
const nearMaximumMdx = `${largeHeading}${largeParagraph.repeat(
  Math.floor((99_000 - largeHeading.length) / largeParagraph.length),
)}`;

const members = Object.freeze([
  Object.freeze({
    id: "member_team_admin",
    email: "admin@team-authoring.invalid",
    displayName: "Avery Admin",
    role: "administrator" as const,
  }),
  Object.freeze({
    id: "member_team_editor",
    email: "editor@team-authoring.invalid",
    displayName: "Emery Editor",
    role: "editor" as const,
  }),
  Object.freeze({
    id: "member_team_reviewer",
    email: "reviewer@team-authoring.invalid",
    displayName: "Riley Reviewer",
    role: "reviewer" as const,
  }),
]);

const categories = Object.freeze([
  Object.freeze({ id: "category_team_start", slug: "start", name: "Start here" }),
  Object.freeze({ id: "category_team_manage", slug: "manage", name: "Manage OPAS" }),
]);

const publishedArticle: ArticleRevisionSnapshot = Object.freeze({
  workspaceId,
  articleId: "article_team_published",
  categoryId: categories[0].id,
  categorySlug: categories[0].slug,
  categoryName: categories[0].name,
  slug: "team-authoring",
  title: "Team authoring",
  mdx: [
    "# Team authoring",
    "",
    "| Step | Owner |",
    "| --- | --- |",
    "| Draft | Editor |",
    "| Review | Reviewer |",
    "",
    "Continue with [reviewing changes](/manage/reviewing-changes).",
    "",
    `![Draft screen](/api/assets/${firstAssetHash})`,
    "",
    `![Review screen](/api/assets/${secondAssetHash})`,
    "",
    "![Remote status](https://media.example.invalid/status.png)",
  ].join("\n"),
  isFaq: false,
  authorName: "OPAS",
  position: 0,
  assetHashes: Object.freeze([firstAssetHash, secondAssetHash]),
});

const largeDraft: ArticleRevisionSnapshot = Object.freeze({
  ...publishedArticle,
  articleId: "article_team_large_draft",
  slug: "large-authoring-guide",
  title: "Large authoring guide",
  mdx: nearMaximumMdx,
  position: 1,
  assetHashes: Object.freeze([]),
});

const archivedArticle: ArticleRevisionSnapshot = Object.freeze({
  ...publishedArticle,
  articleId: "article_team_archived",
  categoryId: categories[1].id,
  categorySlug: categories[1].slug,
  categoryName: categories[1].name,
  slug: "retired-workflow",
  title: "Retired workflow",
  mdx: "# Retired workflow\n\nThis article is retained for archive recovery tests.",
  position: 0,
  assetHashes: Object.freeze([firstAssetHash]),
});

const migrationDraftArticle: ArticleRevisionSnapshot = Object.freeze({
  workspaceId,
  articleId: "article_team_migration_draft",
  categoryId: categories[1].id,
  categorySlug: categories[1].slug,
  categoryName: categories[1].name,
  slug: "migration-draft",
  title: "Migration draft",
  mdx: "# Migration draft\n\nUnpublished baseline content.",
  isFaq: true,
  authorName: "OPAS",
  position: 2,
  assetHashes: Object.freeze([firstAssetHash]),
});

const importedArticles = Object.freeze(
  Array.from({ length: 100 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return Object.freeze({
      id: `article_team_import_${number}`,
      categoryId: categories[index % categories.length].id,
      slug: `imported-article-${number}`,
      title: `Imported article ${number}`,
      mdx: `# Imported article ${number}\n\nDeterministic import fixture ${number}.`,
      status: index % 2 === 0 ? ("published" as const) : ("draft" as const),
    });
  }),
);

const teamAuthoringStandardContract = Object.freeze({
  id: "team-authoring-standard",
  version: 1,
  workspaceId,
  members,
  categories,
  assets: Object.freeze([
    Object.freeze({ hash: firstAssetHash, mediaType: "image/png" as const }),
    Object.freeze({ hash: secondAssetHash, mediaType: "image/webp" as const }),
  ]),
  publishedArticle,
  largeDraft,
  archivedArticle,
  importedArticles,
  migrationCases: Object.freeze([
    Object.freeze({
      article: publishedArticle,
      status: "published" as const,
      expectedSerialization:
        '["opas.article-revision.v1","workspace_team_authoring_standard","article_team_published","category_team_start","start","Start here","team-authoring","Team authoring","# Team authoring\\n\\n| Step | Owner |\\n| --- | --- |\\n| Draft | Editor |\\n| Review | Reviewer |\\n\\nContinue with [reviewing changes](/manage/reviewing-changes).\\n\\n![Draft screen](/api/assets/1111111111111111111111111111111111111111111111111111111111111111)\\n\\n![Review screen](/api/assets/2222222222222222222222222222222222222222222222222222222222222222)\\n\\n![Remote status](https://media.example.invalid/status.png)",false,"OPAS",0,["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"]]',
      expectedHash: "c84353354046d2bf8dbee2ac990304f5f8556a89e70ab76296e2be144483bc00",
      expectedRevisionId:
        "revision_9c148afa30906fb1f03b597b82a0e7eb47ca6659948ed3e33f641168418040f4",
      expectedHead: Object.freeze({
        workingRevisionNumber: 1,
        publishedRevisionNumber: 1,
        reviewState: "published" as const,
      }),
    }),
    Object.freeze({
      article: migrationDraftArticle,
      status: "draft" as const,
      expectedSerialization:
        '["opas.article-revision.v1","workspace_team_authoring_standard","article_team_migration_draft","category_team_manage","manage","Manage OPAS","migration-draft","Migration draft","# Migration draft\\n\\nUnpublished baseline content.",true,"OPAS",2,["1111111111111111111111111111111111111111111111111111111111111111"]]',
      expectedHash: "d4a8fd9889c1979743a757a0b5f99652c75c588362e773d8642b35df0d4dd377",
      expectedRevisionId:
        "revision_26e5f2a25abb22b38f5078f3ad019135452c14546c352e2c83b89bdd9b560595",
      expectedHead: Object.freeze({
        workingRevisionNumber: 1,
        publishedRevisionNumber: null,
        reviewState: "editing" as const,
      }),
    }),
  ]),
});

export const teamAuthoringStandardHashInputV1 = JSON.stringify(
  teamAuthoringStandardContract,
);

export const teamAuthoringStandard = Object.freeze({
  ...teamAuthoringStandardContract,
  contentHash: "2a7302be231e6d30148407469713c50bb39ef3b63c4a07d46233d1313390e2d2",
});
