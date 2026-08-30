// ABOUTME: Defines the JSON contract shared by the import route and admin review panel.
// ABOUTME: Keeps dry-run, blocked, completed, and request-error states explicit.
import type { ImportReport } from "@/import/report";

export type ImportResponse =
  | {
      status: "ready" | "blocked" | "complete";
      report: ImportReport;
    }
  | {
      status: "error";
      message: string;
    };
