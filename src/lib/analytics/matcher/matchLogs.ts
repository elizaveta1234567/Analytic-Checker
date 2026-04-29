import type { AnalyticsSpecRow, ParsedLogEntry } from "../types";
import {
  buildMatcherIndexes,
  makeRowKey,
  type MatcherIndexes,
} from "./buildIndexes";
import { normalizeValue } from "./normalize";
import { extractAnalyticsPayload, validateExtractedPayload } from "./parseLogs";

const CLICK_LIKE_DUPLICATE_WINDOW_MS = 250;
const SOURCE_ORDER_DUPLICATE_WINDOW_EVENTS = 1;

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

type TimestampSource = "parsed" | "source-order";

type LogTimestamp = {
  value: number;
  source: TimestampSource;
};

type LastDuplicateCandidate = {
  timestamp: number;
  timestampSource: TimestampSource;
  sequenceIndex: number;
};

function parseFractionalMs(value: string | undefined): number {
  if (!value) return 0;
  return Number(value.padEnd(3, "0").slice(0, 3));
}

function parseRawLogTimestamp(raw: string, baseTime: number): number | null {
  const normalizedRaw = raw.replace(",", ".");
  const isoMatch = normalizedRaw.match(
    /\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)\b/,
  );
  if (isoMatch?.[1]) {
    const parsed = Date.parse(isoMatch[1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const androidMatch = normalizedRaw.match(
    /(?:^|\s)(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:\s|$)/,
  );
  if (androidMatch) {
    const base = new Date(baseTime);
    return new Date(
      base.getFullYear(),
      Number(androidMatch[1]) - 1,
      Number(androidMatch[2]),
      Number(androidMatch[3]),
      Number(androidMatch[4]),
      Number(androidMatch[5]),
      parseFractionalMs(androidMatch[6]),
    ).getTime();
  }

  const timeOnlyMatch = normalizedRaw.match(
    /(?:^|\s)(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:\s|$)/,
  );
  if (timeOnlyMatch) {
    const base = new Date(baseTime);
    return new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number(timeOnlyMatch[1]),
      Number(timeOnlyMatch[2]),
      Number(timeOnlyMatch[3]),
      parseFractionalMs(timeOnlyMatch[4]),
    ).getTime();
  }

  return null;
}

function resolveLogTimestamp(
  raw: string,
  fallbackTimestamp: number,
  baseTime: number,
): LogTimestamp {
  const parsed = parseRawLogTimestamp(raw, baseTime);
  if (parsed !== null) {
    return { value: parsed, source: "parsed" };
  }

  return { value: fallbackTimestamp, source: "source-order" };
}

function duplicateFingerprint(
  result: MatchPayloadResult,
  extracted: string,
): string | null {
  if (!result.eventPath) {
    return null;
  }

  return [
    normalizeValue(result.eventPath),
    normalizeValue(result.value),
    normalizeValue(extracted),
  ].join("\0");
}

function duplicateEventSignal(
  result: MatchPayloadResult,
  extracted: string,
): string {
  return [result.eventPath ?? "", result.value ?? "", extracted]
    .map((part) => normalizeValue(part).replace(/[^a-z0-9]+/g, " "))
    .join(" ")
    .trim();
}

function signalHasAny(signal: string, terms: string[]): boolean {
  const tokens = new Set(signal.split(/\s+/).filter(Boolean));
  return terms.some((term) =>
    term.includes(" ") ? signal.includes(term) : tokens.has(term),
  );
}

function isHardDuplicateCandidate(
  result: MatchPayloadResult,
  extracted: string,
): boolean {
  const signal = duplicateEventSignal(result, extracted);
  const excludedTokens = [
    "impression",
    "view",
    "show",
    "screen",
    "open",
    "opened",
    "claim",
    "purchase attempt",
    "purchaseattempt",
    "ad",
    "ads",
    "service",
    "internal",
    "sdk",
    "adservice",
  ];

  if (signalHasAny(signal, excludedTokens)) {
    return false;
  }

  const clickLikeTokens = [
    "click",
    "tap",
    "tapped",
    "clicked",
    "confirm",
    "button",
    "press",
    "submit",
    "accept",
  ];

  return signalHasAny(signal, clickLikeTokens);
}

function duplicateReason(
  deltaMs: number,
  currentSource: TimestampSource,
  previousSource: TimestampSource,
): string {
  if (currentSource === "parsed" && previousSource === "parsed") {
    return `Duplicate within ${deltaMs} ms (same event fingerprint)`;
  }

  return "Same event fingerprint repeated in short source-order window";
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
  const lastDuplicateCandidateByFingerprint = new Map<
    string,
    LastDuplicateCandidate
  >();
  const baseTime = Date.now();
  let eventSequence = 0;

  lines.forEach((raw, lineIndex) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const extracted = extractAnalyticsPayload(raw);
    if (extracted === null) return;

    eventSequence += 1;
    const sequenceIndex = eventSequence;
    const timestamp = resolveLogTimestamp(raw, baseTime + lineIndex, baseTime);
    const payloadCheck = validateExtractedPayload(extracted);
    if (!payloadCheck.valid) {
      logs.push({
        id: nextLogId(),
        raw,
        extracted,
        eventPath: null,
        value: null,
        timestamp: timestamp.value,
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
      const fingerprint = duplicateFingerprint(m, extracted);
      const isDuplicateCandidate = isHardDuplicateCandidate(m, extracted);
      if (fingerprint && isDuplicateCandidate) {
        const windowMs = CLICK_LIKE_DUPLICATE_WINDOW_MS;
        const previous =
          lastDuplicateCandidateByFingerprint.get(fingerprint);
        const isImmediateBurst =
          previous !== undefined &&
          sequenceIndex - previous.sequenceIndex <=
            SOURCE_ORDER_DUPLICATE_WINDOW_EVENTS;
        if (previous && isImmediateBurst) {
          if (
            timestamp.source === "parsed" &&
            previous.timestampSource === "parsed"
          ) {
            const deltaMs = timestamp.value - previous.timestamp;
            if (deltaMs >= 0 && deltaMs < windowMs) {
              matchType = "duplicate";
              reason = duplicateReason(
                deltaMs,
                timestamp.source,
                previous.timestampSource,
              );
            }
          } else {
            const sequenceDelta = sequenceIndex - previous.sequenceIndex;
            if (
              sequenceDelta > 0 &&
              sequenceDelta <= SOURCE_ORDER_DUPLICATE_WINDOW_EVENTS
            ) {
              matchType = "duplicate";
              reason = duplicateReason(
                0,
                timestamp.source,
                previous.timestampSource,
              );
            }
          }
        }
        lastDuplicateCandidateByFingerprint.set(fingerprint, {
          timestamp: timestamp.value,
          timestampSource: timestamp.source,
          sequenceIndex,
        });
      }
    }

    const entry: ParsedLogEntry = {
      id: nextLogId(),
      raw: raw,
      extracted,
      eventPath: m.eventPath,
      value: m.value,
      timestamp: timestamp.value,
      matchType,
      matchedRowId: m.matchedRowId,
      reason,
    };

    logs.push(entry);
    applyMatchToRows(rows, entry);
  });

  return { logs, rows };
}
