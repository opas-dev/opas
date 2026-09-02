// ABOUTME: Defines the portable article workflow states and revision-pointer transitions.
// ABOUTME: Makes stale writes, exact publication, rollback, and preview pinning explicit.

export const articleReviewStates = [
  "editing",
  "in_review",
  "changes_requested",
  "approved",
  "published",
] as const;

export type ArticleReviewState = (typeof articleReviewStates)[number];

export const articleReviewActions = [
  "submitted",
  "withdrawn",
  "changes_requested",
  "category_changed",
  "approved",
  "published",
  "unpublished",
  "archived",
  "restored",
  "emergency_published",
] as const;

export type ArticleReviewAction = (typeof articleReviewActions)[number];

export const articleWorkflowTransitions = Object.freeze({
  save: Object.freeze({
    from: Object.freeze([
      "editing",
      "changes_requested",
      "approved",
      "published",
    ] as const),
    to: "editing",
  }),
  submit: Object.freeze({
    from: Object.freeze(["editing", "changes_requested"] as const),
    to: "in_review",
  }),
  withdraw: Object.freeze({
    from: Object.freeze(["in_review"] as const),
    to: "editing",
  }),
  requestChanges: Object.freeze({
    from: Object.freeze(["in_review"] as const),
    to: "changes_requested",
  }),
  approve: Object.freeze({
    from: Object.freeze(["in_review"] as const),
    to: "approved",
  }),
  publish: Object.freeze({
    from: Object.freeze(["approved"] as const),
    to: "published",
  }),
  emergencyPublish: Object.freeze({ from: articleReviewStates, to: "published" }),
  unpublish: Object.freeze({ from: articleReviewStates, to: "state-dependent" }),
  archive: Object.freeze({ from: articleReviewStates, to: "state-dependent" }),
  restoreArchive: Object.freeze({ from: articleReviewStates, to: "editing" }),
  categoryChange: Object.freeze({
    from: Object.freeze(["in_review", "approved"] as const),
    to: "changes_requested",
  }),
});

export type ArticleHeadContract = {
  workingRevisionId: string;
  workingRevisionNumber: number;
  publishedRevisionId: string | null;
  publishedRevisionNumber: number | null;
  publicStatus: "draft" | "published";
  reviewState: ArticleReviewState;
  archived: boolean;
};

export type WorkflowConflictCode =
  | "ARTICLE_ARCHIVED"
  | "INVALID_REVIEW_STATE"
  | "REVISION_MISMATCH"
  | "STALE_REVISION";

export class ArticleWorkflowConflict extends Error {
  constructor(readonly code: WorkflowConflictCode) {
    super(code);
    this.name = "ArticleWorkflowConflict";
  }
}

function assertCurrentRevision(
  head: ArticleHeadContract,
  expectedWorkingRevisionNumber: number,
) {
  if (head.workingRevisionNumber !== expectedWorkingRevisionNumber) {
    throw new ArticleWorkflowConflict("STALE_REVISION");
  }
}

function assertRevisionIdentity(
  head: ArticleHeadContract,
  expectedWorkingRevisionNumber: number,
  revisionId: string,
) {
  assertCurrentRevision(head, expectedWorkingRevisionNumber);
  if (head.workingRevisionId !== revisionId) {
    throw new ArticleWorkflowConflict("REVISION_MISMATCH");
  }
}

function assertEditable(head: ArticleHeadContract) {
  if (head.archived) {
    throw new ArticleWorkflowConflict("ARTICLE_ARCHIVED");
  }
  if (head.reviewState === "in_review") {
    throw new ArticleWorkflowConflict("INVALID_REVIEW_STATE");
  }
}

export function advanceWorkingRevision(
  head: ArticleHeadContract,
  request: {
    expectedWorkingRevisionNumber: number;
    revisionId: string;
  },
): ArticleHeadContract {
  assertCurrentRevision(head, request.expectedWorkingRevisionNumber);
  assertEditable(head);
  return {
    ...head,
    workingRevisionId: request.revisionId,
    workingRevisionNumber: head.workingRevisionNumber + 1,
    reviewState: "editing",
  };
}

export function publishApprovedRevision(
  head: ArticleHeadContract,
  request: {
    expectedWorkingRevisionNumber: number;
    revisionId: string;
  },
): ArticleHeadContract {
  assertRevisionIdentity(
    head,
    request.expectedWorkingRevisionNumber,
    request.revisionId,
  );
  if (head.archived) {
    throw new ArticleWorkflowConflict("ARTICLE_ARCHIVED");
  }
  if (head.reviewState !== "approved") {
    throw new ArticleWorkflowConflict("INVALID_REVIEW_STATE");
  }
  return {
    ...head,
    publishedRevisionId: request.revisionId,
    publishedRevisionNumber: head.workingRevisionNumber,
    publicStatus: "published",
    reviewState: "published",
  };
}

function transitionExactRevision(
  head: ArticleHeadContract,
  request: {
    expectedWorkingRevisionNumber: number;
    revisionId: string;
  },
  allowedStates: readonly ArticleReviewState[],
  reviewState: ArticleReviewState,
) {
  assertRevisionIdentity(
    head,
    request.expectedWorkingRevisionNumber,
    request.revisionId,
  );
  if (head.archived) {
    throw new ArticleWorkflowConflict("ARTICLE_ARCHIVED");
  }
  if (!allowedStates.includes(head.reviewState)) {
    throw new ArticleWorkflowConflict("INVALID_REVIEW_STATE");
  }
  return { ...head, reviewState };
}

export function submitRevisionForReview(
  head: ArticleHeadContract,
  request: { expectedWorkingRevisionNumber: number; revisionId: string },
) {
  return transitionExactRevision(
    head,
    request,
    articleWorkflowTransitions.submit.from,
    "in_review",
  );
}

export function withdrawRevisionFromReview(
  head: ArticleHeadContract,
  request: { expectedWorkingRevisionNumber: number; revisionId: string },
) {
  return transitionExactRevision(
    head,
    request,
    articleWorkflowTransitions.withdraw.from,
    "editing",
  );
}

export function requestRevisionChanges(
  head: ArticleHeadContract,
  request: { expectedWorkingRevisionNumber: number; revisionId: string },
) {
  return transitionExactRevision(
    head,
    request,
    articleWorkflowTransitions.requestChanges.from,
    "changes_requested",
  );
}

export function approveRevision(
  head: ArticleHeadContract,
  request: { expectedWorkingRevisionNumber: number; revisionId: string },
) {
  return transitionExactRevision(
    head,
    request,
    articleWorkflowTransitions.approve.from,
    "approved",
  );
}

export function invalidateReviewForCategoryChange(
  head: ArticleHeadContract,
): ArticleHeadContract {
  if (head.reviewState !== "in_review" && head.reviewState !== "approved") {
    return head;
  }
  return { ...head, reviewState: "changes_requested" };
}

export function emergencyPublishRevision(
  head: ArticleHeadContract,
  request: { expectedWorkingRevisionNumber: number; revisionId: string },
) {
  assertRevisionIdentity(
    head,
    request.expectedWorkingRevisionNumber,
    request.revisionId,
  );
  if (head.archived) {
    throw new ArticleWorkflowConflict("ARTICLE_ARCHIVED");
  }
  return {
    ...head,
    publishedRevisionId: request.revisionId,
    publishedRevisionNumber: head.workingRevisionNumber,
    publicStatus: "published" as const,
    reviewState: "published" as const,
  };
}

function privateReviewState(head: ArticleHeadContract) {
  return head.workingRevisionId === head.publishedRevisionId
    ? ("approved" as const)
    : head.reviewState;
}

type ExpectedHeadState = {
  expectedWorkingRevisionNumber: number;
  revisionId: string;
  expectedReviewState: ArticleReviewState;
  expectedPublicStatus: "draft" | "published";
};

function assertExpectedHeadState(
  head: ArticleHeadContract,
  request: ExpectedHeadState,
) {
  assertRevisionIdentity(
    head,
    request.expectedWorkingRevisionNumber,
    request.revisionId,
  );
  if (
    head.reviewState !== request.expectedReviewState ||
    head.publicStatus !== request.expectedPublicStatus
  ) {
    throw new ArticleWorkflowConflict("INVALID_REVIEW_STATE");
  }
}

export function unpublishArticle(
  head: ArticleHeadContract,
  request: ExpectedHeadState,
): ArticleHeadContract {
  assertExpectedHeadState(head, request);
  if (head.archived || head.publicStatus !== "published") {
    throw new ArticleWorkflowConflict(
      head.archived ? "ARTICLE_ARCHIVED" : "INVALID_REVIEW_STATE",
    );
  }
  return {
    ...head,
    publicStatus: "draft",
    reviewState: privateReviewState(head),
  };
}

export function archiveArticle(
  head: ArticleHeadContract,
  request: ExpectedHeadState,
): ArticleHeadContract {
  assertExpectedHeadState(head, request);
  if (head.archived) {
    throw new ArticleWorkflowConflict("ARTICLE_ARCHIVED");
  }
  return {
    ...head,
    publicStatus: "draft",
    reviewState: privateReviewState(head),
    archived: true,
  };
}

export function restoreArchivedArticle(
  head: ArticleHeadContract,
  request: ExpectedHeadState,
): ArticleHeadContract {
  assertExpectedHeadState(head, request);
  if (!head.archived) {
    throw new ArticleWorkflowConflict("INVALID_REVIEW_STATE");
  }
  return {
    ...head,
    publicStatus: "draft",
    reviewState: "editing",
    archived: false,
  };
}

export function restoreRevisionAsDraft(
  head: ArticleHeadContract,
  request: {
    expectedWorkingRevisionNumber: number;
    revisionId: string;
    restoredFromRevisionId: string;
  },
) {
  const restoredHead = advanceWorkingRevision(head, request);
  return {
    head: restoredHead,
    restoredFromRevisionId: request.restoredFromRevisionId,
  } as const;
}

export function articlePreviewSubject(revisionId: string) {
  return Object.freeze({ revisionId });
}
