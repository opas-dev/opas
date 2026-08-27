// ABOUTME: Defines browser-safe limits for anonymous article analytics requests.
// ABOUTME: Keeps client and server validation aligned without importing server dependencies.
export const maximumArticleEventBodyBytes = 16 * 1024;
export const maximumFeedbackCommentLength = 1_000;
