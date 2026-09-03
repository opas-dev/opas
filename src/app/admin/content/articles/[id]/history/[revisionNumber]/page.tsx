// ABOUTME: Resolves a revision number to its immutable identity for conflict links.
// ABOUTME: Redirects to the exact comparison without trusting a client-supplied revision ID.
import { notFound, redirect } from "next/navigation";

import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export default async function ArticleRevisionResolverPage({
  params,
}: {
  params: Promise<{ id: string; revisionNumber: string }>;
}) {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const { id, revisionNumber: value } = await params;
  if (!/^[1-9][0-9]*$/u.test(value)) notFound();
  const revisionNumber = Number(value);
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber === Number.MAX_SAFE_INTEGER) {
    notFound();
  }

  const history = await (await getRepository()).listArticleRevisionHistory({
    actor: { memberId: admin.memberId, sessionId: admin.sessionId },
    articleId: id,
    beforeRevisionNumber: revisionNumber + 1,
    limit: 1,
    workspaceId: demoIds.workspace,
  });
  const revision = history?.items[0];
  if (!revision || revision.revisionNumber !== revisionNumber) notFound();
  redirect(
    `/admin/content/articles/${id}/history/${revision.revisionNumber}/${revision.revisionId}`,
  );
}
