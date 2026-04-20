import type { AnalyticsSpecRow, ParsedLogEntry } from "../types";
import {
  buildMatcherIndexes,
  makeRowKey,
  type MatcherIndexes,
} from "./buildIndexes";
import { normalizeValue } from "./normalize";
import { extractAnalyticsPayload, validateExtractedPayload } from "./parseLogs";

function specEventPath(row: AnalyticsSpecRow): string {
  return String(row.cells.eventPath ?? row.hierarchy.join("."));
}

function specValue(row: AnalyticsSpecRow): string | null {
  const v = row.cells.value;
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

/** True if at least one spec row for this path has a non-null value (value is enumerated / fixed). */
function eventPathHasFixedValues(
  normPath: string,
  rowsByEventPath: Map<string, AnalyticsSpecRow[]>,
): boolean {
  const list = rowsByEventPath.get(normPath) ?? [];
  return list.some((row) => specValue(row) != null);
}

/** Representative row for an "open value" event (spec rows only declare the path). */
function pickOpenValueRow(
  normPath: string,
  rowsByEventPath: Map<string, AnalyticsSpecRow[]>,
): AnalyticsSpecRow | null {
  const list = rowsByEventPath.get(normPath) ?? [];
  if (list.length === 0) return null;
  const withoutValue = list.find((r) => specValue(r) == null);
  return withoutValue ?? list[0] ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remainder after path prefix in the original payload (case-insensitive path). */
function extractRemainderCaseInsensitive(
  payload: string,
  pathRaw: string,
): string {
  const pl = payload.trim();
  const pr = pathRaw.trim();
  if (!pr) return pl;
  if (pl.toLowerCase() === pr.toLowerCase()) return "";
  const re = new RegExp("^" + escapeRe(pr) + "\\.", "i");
  const m = pl.match(re);
  if (m && m.index === 0) {
    return pl.slice(m[0].length).trim();
  }
  return "";
}

export type MatchPayloadResult = {
  eventPath: string | null;
  value: string | null;
  matchedRowId: string | null;
  matchType: ParsedLogEntry["matchType"];
  reason: string | null;
};

function unknown(reason: string): MatchPayloadResult {
  return {
    eventPath: null,
    value: null,
    matchedRowId: null,
    matchType: "unknown",
    reason,
  };
}

/**
 * Matches one normalized payload string against the spec (longest-prefix + row map).
 * `originalPayload` is used for raw vs normalized partial detection.
 */
export function matchPayload(
  originalPayload: string,
  rows: AnalyticsSpecRow[],
  idx: MatcherIndexes,
): MatchPayloadResult {
  const N = normalizeValue(originalPayload);
  if (!N) {
    return unknown("Empty payload");
  }

  const { eventPathIndex, rowMap, rowsByEventPath } = idx;

  // 1) Exact whole payload = event path, spec row has no value
  for (const row of rows) {
    const ep = normalizeValue(specEventPath(row));
    const sv = specValue(row);
    if (ep === N && (sv === null || normalizeValue(sv) === "")) {
      return {
        eventPath: ep,
        value: null,
        matchedRowId: row.id,
        matchType: "passed",
        reason: null,
      };
    }
  }

  // 2) Longest prefix (index sorted by length desc)
  let bestPath: string | null = null;
  for (const path of eventPathIndex) {
    if (N === path || N.startsWith(path + ".")) {
      bestPath = path;
      break;
    }
  }

  if (!bestPath) {
    return unknown("No known event path");
  }

  const remNorm = N === bestPath ? "" : N.slice(bestPath.length + 1);

  // 3) Exact row: normalized path + value
  const directKey = makeRowKey(bestPath, remNorm || null);
  if (rowMap.has(directKey)) {
    const row = rowMap.get(directKey)!;
    const pathRaw = specEventPath(row);
    const remRaw = extractRemainderCaseInsensitive(originalPayload, pathRaw);
    const vSpec = specValue(row) != null ? String(specValue(row)) : "";
    const normEq =
      normalizeValue(vSpec) === normalizeValue(remRaw) ||
      (remNorm === "" && normalizeValue(vSpec) === "");
    const rawEq = vSpec.trim() === remRaw.trim();
    if (normEq && !rawEq) {
      return {
        eventPath: bestPath,
        value: remNorm || null,
        matchedRowId: row.id,
        matchType: "partial",
        reason: "Matched only after normalization",
      };
    }
    return {
      eventPath: bestPath,
      value: remNorm || null,
      matchedRowId: row.id,
      matchType: "passed",
      reason: null,
    };
  }

  // 4) Same path, find row by normalized value
  const candidates = rowsByEventPath.get(bestPath) ?? [];
  let valueMatch: AnalyticsSpecRow | null = null;
  for (const row of candidates) {
    const sv = specValue(row);
    const nv = sv !== null ? normalizeValue(sv) : "";
    if (nv === remNorm) {
      valueMatch = row;
      break;
    }
  }

  if (valueMatch) {
    const pathRaw = specEventPath(valueMatch);
    const remRaw = extractRemainderCaseInsensitive(originalPayload, pathRaw);
    const vSpec =
      specValue(valueMatch) != null ? String(specValue(valueMatch)) : "";
    const normEq = normalizeValue(vSpec) === normalizeValue(remRaw);
    const rawEq = vSpec.trim() === remRaw.trim();
    if (normEq && !rawEq) {
      return {
        eventPath: bestPath,
        value: remNorm || null,
        matchedRowId: valueMatch.id,
        matchType: "partial",
        reason: "Matched only after normalization",
      };
    }
    return {
      eventPath: bestPath,
      value: remNorm || null,
      matchedRowId: valueMatch.id,
      matchType: "passed",
      reason: null,
    };
  }

  // No enumerated value matched: if spec never fixes value for this path, accept any remainder as passed.
  if (!eventPathHasFixedValues(bestPath, rowsByEventPath)) {
    const openRow = pickOpenValueRow(bestPath, rowsByEventPath);
    if (openRow) {
      return {
        eventPath: bestPath,
        value: remNorm || null,
        matchedRowId: openRow.id,
        matchType: "passed",
        reason: null,
      };
    }
  }

  return {
    eventPath: bestPath,
    value: remNorm || null,
    matchedRowId: null,
    matchType: "partial",
    reason: "Known event path, but value is not present in spec",
  };
}

export function applyMatchToRows(
  rows: AnalyticsSpecRow[],
  log: ParsedLogEntry,
): void {
  if (!log.matchedRowId) return;
  const row = rows.find((r) => r.id === log.matchedRowId);
  if (!row) return;

  row.matchCount = (row.matchCount ?? 0) + 1;
  if (!row.matchedLogIds) row.matchedLogIds = [];
  row.matchedLogIds.push(log.id);
  const t = log.timestamp;
  if (row.firstMatchedAt == null) row.firstMatchedAt = t;
  row.lastMatchedAt = t;

  if (log.matchType === "passed" || log.matchType === "duplicate") {
    row.status = "matched";
  } else if (log.matchType === "partial") {
    row.status = "partial";
  }
}

function cloneSpecRow(row: AnalyticsSpecRow): AnalyticsSpecRow {
  return {
    ...row,
    cells: { ...row.cells },
    matchedLogIds: row.matchedLogIds ? [...row.matchedLogIds] : [],
    matchCount: row.matchCount ?? 0,
    firstMatchedAt: row.firstMatchedAt,
    lastMatchedAt: row.lastMatchedAt,
  };
}

export function cloneSpecRows(rows: AnalyticsSpecRow[]): AnalyticsSpecRow[] {
  return rows.map(cloneSpecRow);
}

let logIdSeq = 0;

function nextLogId(): string {
  logIdSeq += 1;
  return `log-${Date.now()}-${logIdSeq}`;
}

/**
 * Parses multi-line input, matches each payload, applies duplicate detection and row updates.
 */
export function matchLogLinesAgainstSpec(
  rawText: string,
  specRows: AnalyticsSpecRow[],
): { logs: ParsedLogEntry[]; rows: AnalyticsSpecRow[] } {
  const rows = cloneSpecRows(specRows);
  if (rows.length === 0) {
    return { logs: [], rows };
  }

  const idx = buildMatcherIndexes(rows);
  const lines = rawText.split(/\r?\n/);
  const logs: ParsedLogEntry[] = [];
  const seenPassed = new Set<string>();
  const baseTime = Date.now();

  lines.forEach((raw, lineIndex) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const extracted = extractAnalyticsPayload(raw);
    if (extracted === null) return;

    const ts = baseTime + lineIndex;
    const payloadCheck = validateExtractedPayload(extracted);
    if (!payloadCheck.valid) {
      logs.push({
        id: nextLogId(),
        raw,
        extracted,
        eventPath: null,
        value: null,
        timestamp: ts,
        matchType: "unknown",
        matchedRowId: null,
        reason: payloadCheck.reason,
      });
      return;
    }

    const m = matchPayload(extracted, rows, idx);

    let matchType = m.matchType;
    let reason = m.reason;

    if (matchType === "passed" && m.matchedRowId) {
      const dupKey = `${m.matchedRowId}::${normalizeValue(extracted)}`;
      if (seenPassed.has(dupKey)) {
        matchType = "duplicate";
        reason = "Duplicate log (same row + payload as earlier line)";
      } else {
        seenPassed.add(dupKey);
      }
    }

    const entry: ParsedLogEntry = {
      id: nextLogId(),
      raw: raw,
      extracted,
      eventPath: m.eventPath,
      value: m.value,
      timestamp: ts,
      matchType,
      matchedRowId: m.matchedRowId,
      reason,
    };

    logs.push(entry);
    applyMatchToRows(rows, entry);
  });

  return { logs, rows };
}
