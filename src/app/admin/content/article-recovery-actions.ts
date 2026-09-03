// ABOUTME: Wires named-member authorization to article archive and recovery actions.
// ABOUTME: Revalidates public and private content only after a repository transition commits.
"use server";

import { revalidatePath } from "next/cache";

import { scheduleEmbeddingRecovery } from "@/ai/embedding-scheduling";
import type { ArticleRecoveryActionState } from "@/app/admin/content/article-recovery-contracts";
import {
  runArticleRecoveryAction,
  type ArticleRecoveryDependencies,
  type ArticleRecoveryIntent,
} from "@/app/admin/content/article-recovery-runtime";
import { requireMemberCapability } from "@/auth/admin";
import type { Capability } from "@/auth/capabilities";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

function revalidateContent() {
  revalidatePath("/", "layout");
}

async function recoveryAction(
  capability: Capability,
  intent: ArticleRecoveryIntent,
  formData: FormData,
) {
  const member = await requireMemberCapability(capability, demoIds.workspace);
  const dependencies: ArticleRecoveryDependencies = {
    actor: { memberId: member.memberId, sessionId: member.sessionId },
    repository: await getRepository(),
    revalidateContent,
    scheduleEvidenceRecovery: scheduleEmbeddingRecovery,
    reportFailure(error) {
      console.error("Article recovery failed.", {
        type: error instanceof Error ? error.name : "UnknownError",
      });
    },
    workspaceId: demoIds.workspace,
  };
  return runArticleRecoveryAction(intent, formData, dependencies);
}

export async function archiveArticleAction(
  _previousState: ArticleRecoveryActionState,
  formData: FormData,
) {
  return recoveryAction("article:retire", "archive", formData);
}

export async function restoreArchivedArticleAction(
  _previousState: ArticleRecoveryActionState,
  formData: FormData,
) {
  return recoveryAction("revision:restore", "restoreArchive", formData);
}

export async function restoreArticleRevisionAction(
  _previousState: ArticleRecoveryActionState,
  formData: FormData,
) {
  return recoveryAction("revision:restore", "restoreRevision", formData);
}
