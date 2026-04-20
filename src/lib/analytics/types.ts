/**
 * Core domain types for Analytics Checker.
 * Column mapping and hierarchy are filled in by the import layer; matcher consumes normalized rows.
 */

/** One row from the analytics spec after import (Excel-agnostic). */
export type AnalyticsSpecRow = {
  id: string;
  /** Semantic path segments, e.g. ["shop", "purchase", "completed"] */
  hierarchy: string[];
  /** Original cell values keyed by column id from the workbook (not hard-coded Excel names). */
  cells: Record<string, string | number | boolean | null>;
  /** Row status updated by the session / matcher. */
  status:
    | "pending"
    | "matched"
    | "unmatched"
    | "error"
    | "not_checked"
    | "partial";
  /** Populated by the matcher when logs are processed. */
  matchCount?: number;
  matchedLogIds?: string[];
  firstMatchedAt?: number;
  lastMatchedAt?: number;
  meta?: Record<string, unknown>;
};

/** One parsed / matched line from a debug console log. */
export type ParsedLogEntry = {
  id: string;
  raw: string;
  /** Payload after extractAnalyticsPayload (null if not extracted here). */
  extracted: string | null;
  /** Normalized / resolved event path when known. */
  eventPath: string | null;
  /** Normalized remainder (value segment) when resolved. */
  value: string | null;
  timestamp: number;
  matchType: "passed" | "duplicate" | "partial" | "unknown";
  matchedRowId: string | null;
  reason: string | null;
};

/** Session aggregates import + logs + matcher results. */
export type AnalyticsSessionState = {
  specRows: AnalyticsSpecRow[];
  logEntries: ParsedLogEntry[];
  /** Row id → matched log entry ids (or empty if unmatched). */
  matches: Record<string, string[]>;
  lastImportAt: number | null;
  lastLogIngestAt: number | null;
};
