// ABOUTME: Bounds stored zero-result search samples with fixed daily slots and retention.
// ABOUTME: Creates portable miss records and cleanup cutoffs for both database dialects.
import type { SearchMiss } from "@/db/repository";

const dailySearchMissSlots = 1_024;
const searchMissRetentionDays = 30;
const millisecondsPerDay = 86_400_000;

export function createSearchMiss(workspaceId: string, query: string): SearchMiss {
  const createdAt = new Date();
  const day = createdAt.toISOString().slice(0, 10).replaceAll("-", "");
  const randomValue = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
  const slot = String(randomValue % dailySearchMissSlots).padStart(4, "0");

  return {
    id: `search_miss_${workspaceId}_${day}_${slot}`,
    workspaceId,
    query,
    createdAt,
  };
}

export function searchMissRetentionStart(createdAt: Date) {
  return new Date(createdAt.getTime() - searchMissRetentionDays * millisecondsPerDay);
}
