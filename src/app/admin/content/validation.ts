// ABOUTME: Validates category and article submissions from the authenticated content editor.
// ABOUTME: Converts untrusted form values into the fixed single-workspace content contract.
import { z } from "zod";

import { isAssetManifestId } from "@/assets/identity";
import { articleTitleHeadingIssue } from "@/content/runtime-mdx-plugins";

const identifierSchema = z
  .string()
  .trim()
  .min(1, "The requested record is missing")
  .max(100, "The requested record is invalid");

const slugSchema = z
  .string()
  .trim()
  .min(1, "Enter a URL slug")
  .max(120, "URL slugs must be 120 characters or fewer")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers, and single hyphens only",
  );

const categorySlugSchema = slugSchema.refine(
  (slug) => !new Set(["admin", "api", "spike"]).has(slug),
  "This URL slug is reserved by the application",
);

const categoryFields = {
  name: z
    .string()
    .trim()
    .min(1, "Enter a category name")
    .max(100, "Category names must be 100 characters or fewer"),
  slug: categorySlugSchema,
  description: z
    .string()
    .trim()
    .max(300, "Descriptions must be 300 characters or fewer")
    .transform((value) => value || null),
  position: z.coerce
    .number()
    .int("Position must be a whole number")
    .min(0, "Position cannot be negative")
    .max(10_000, "Position must be 10,000 or lower"),
};

const categoryVersionSchema = z.coerce
  .number()
  .int("The category version is invalid")
  .min(1, "The category version is invalid");

const categoryRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("create"), ...categoryFields }),
  z.strictObject({
    mode: z.literal("update"),
    id: identifierSchema,
    expectedCategoryVersion: categoryVersionSchema,
    ...categoryFields,
  }),
]);

const articleFields = {
  categoryId: identifierSchema,
  title: z
    .string()
    .trim()
    .min(1, "Enter an article title")
    .max(160, "Article titles must be 160 characters or fewer"),
  slug: slugSchema,
  mdx: z
    .string()
    .min(1, "Enter article content")
    .max(100_000, "Article content must be 100 KB or smaller"),
  status: z.enum(["draft", "published"]),
  isFaq: z.literal("on").optional().transform(Boolean),
  authorName: z
    .string()
    .trim()
    .min(1, "Enter an author name")
    .max(100, "Author names must be 100 characters or fewer"),
  assetManifestId: z
    .string()
    .refine(isAssetManifestId, "The asset manifest is invalid")
    .optional(),
};

const articleRequestSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("create"), ...articleFields }),
    z.strictObject({ mode: z.literal("update"), id: identifierSchema, ...articleFields }),
  ])
  .superRefine((article, context) => {
    const headingIssue = articleTitleHeadingIssue(article.mdx, article.title);
    if (headingIssue) {
      context.addIssue({
        code: "custom",
        path: ["mdx"],
        message: headingIssue,
      });
    }
  });

const recordRequestSchema = z.strictObject({ id: identifierSchema });
const categoryDeleteRequestSchema = z.strictObject({
  id: identifierSchema,
  expectedCategoryVersion: categoryVersionSchema,
});

export type CategoryRequest = z.infer<typeof categoryRequestSchema>;
export type ArticleRequest = z.infer<typeof articleRequestSchema>;

export type ContentFieldErrors = Partial<
  Record<
    | "form"
    | "id"
    | "expectedCategoryVersion"
    | "name"
    | "slug"
    | "description"
    | "position"
    | "categoryId"
    | "title"
    | "mdx"
    | "status"
    | "isFaq"
    | "authorName"
    | "assetManifestId",
    string
  >
>;

export type ContentRequestResult<T> =
  | { success: true; data: T }
  | { success: false; fieldErrors: ContentFieldErrors };

function formValues(formData: FormData) {
  return Object.fromEntries(
    [...formData.entries()].filter(([name]) => !name.startsWith("$ACTION_")),
  );
}

function requestErrors(error: z.ZodError): ContentFieldErrors {
  const errors: ContentFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && field in contentFieldNames && !errors[field as keyof ContentFieldErrors]) {
      errors[field as keyof ContentFieldErrors] = issue.message;
    }
  }

  if (error.issues.some((issue) => issue.path.length === 0)) {
    errors.form = "The request contained unexpected fields.";
  }

  if (Object.keys(errors).length === 0) {
    errors.form = "Review the submitted fields.";
  }

  return errors;
}

const contentFieldNames = {
  id: true,
  expectedCategoryVersion: true,
  name: true,
  slug: true,
  description: true,
  position: true,
  categoryId: true,
  title: true,
  mdx: true,
  status: true,
  isFaq: true,
  authorName: true,
  assetManifestId: true,
} as const;

function parseRequest<T>(
  schema: z.ZodType<T>,
  formData: FormData,
): ContentRequestResult<T> {
  const parsed = schema.safeParse(formValues(formData));

  if (!parsed.success) {
    return { success: false, fieldErrors: requestErrors(parsed.error) };
  }

  return { success: true, data: parsed.data };
}

export function parseCategoryRequest(formData: FormData) {
  return parseRequest(categoryRequestSchema, formData);
}

export function parseArticleRequest(formData: FormData) {
  return parseRequest(articleRequestSchema, formData);
}

export function parseCategoryDeleteRequest(formData: FormData) {
  return parseRequest(categoryDeleteRequestSchema, formData);
}

export function parseRecordRequest(formData: FormData) {
  return parseRequest(recordRequestSchema, formData);
}
