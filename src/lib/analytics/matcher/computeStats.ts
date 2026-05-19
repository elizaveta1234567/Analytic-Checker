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

export function computeStats(
  rows: AnalyticsSpecRow[],
  logs: ParsedLogEntry[],
): MatcherStats {
  const total = rows.length;
  const knownRowIds = new Set(rows.map((r) => r.id));
  const passedRowIds = new Set(
    rows.filter((r) => r.status === "matched").map((r) => r.id),
  );
  const partialRowIds = new Set(
    rows.filter((r) => r.status === "partial").map((r) => r.id),
  );

  for (const log of logs) {
    if (!log.matchedRowId || !knownRowIds.has(log.matchedRowId)) {
      continue;
    }
    if (log.matchType === "passed") {
      passedRowIds.add(log.matchedRowId);
      partialRowIds.delete(log.matchedRowId);
    } else if (
      log.matchType === "partial" &&
      !passedRowIds.has(log.matchedRowId)
    ) {
      partialRowIds.add(log.matchedRowId);
    }
  }

  const passed = passedRowIds.size;
  const partial = partialRowIds.size;
  const notChecked = Math.max(0, total - passed - partial);

  const totalLogs = logs.length;
  const duplicateLogs = logs.filter((l) => l.matchType === "duplicate").length;
  const partialLogs = logs.filter((l) => l.matchType === "partial").length;
  const unknownLogs = logs.filter((l) => l.matchType === "unknown").length;

  return {
    rowStats: { total, passed, partial, notChecked },
    logStats: { totalLogs, duplicateLogs, partialLogs, unknownLogs },
  };
}
