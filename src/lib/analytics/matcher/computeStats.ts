import type { AnalyticsSpecRow, ParsedLogEntry } from "../types";

export type RowStats = {
  total: number;
  passed: number;
  partial: number;
  notChecked: number;
};

export type LogStats = {
  totalLogs: number;
  duplicateLogs: number;
  partialLogs: number;
  unknownLogs: number;
};

export type MatcherStats = {
  rowStats: RowStats;
  logStats: LogStats;
};

function isNotCheckedRow(r: AnalyticsSpecRow): boolean {
  return (
    r.status === "not_checked" ||
    r.status === "pending" ||
    r.status === "unmatched" ||
    r.status === "error"
  );
}

export function computeStats(
  rows: AnalyticsSpecRow[],
  logs: ParsedLogEntry[],
): MatcherStats {
  const total = rows.length;
  const passed = rows.filter((r) => r.status === "matched").length;
  const partial = rows.filter((r) => r.status === "partial").length;
  const notChecked = rows.filter(isNotCheckedRow).length;

  const totalLogs = logs.length;
  const duplicateLogs = logs.filter((l) => l.matchType === "duplicate").length;
  const partialLogs = logs.filter((l) => l.matchType === "partial").length;
  const unknownLogs = logs.filter((l) => l.matchType === "unknown").length;

  return {
    rowStats: { total, passed, partial, notChecked },
    logStats: { totalLogs, duplicateLogs, partialLogs, unknownLogs },
  };
}
