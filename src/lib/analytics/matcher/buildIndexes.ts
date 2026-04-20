import type { AnalyticsSpecRow } from "../types";
import { normalizeValue } from "./normalize";

export function makeRowKey(eventPath: string, value: string | null): string {
  return `${eventPath}::${value ?? ""}`;
}

function specEventPath(row: AnalyticsSpecRow): string {
  return String(row.cells.eventPath ?? row.hierarchy.join("."));
}

function specValue(row: AnalyticsSpecRow): string | null {
  const v = row.cells.value;
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

export type MatcherIndexes = {
  /** Normalized paths, longest first (longest-prefix match). */
  eventPathIndex: string[];
  /** Keys use normalized eventPath and normalized value (empty string when no value). */
  rowMap: Map<string, AnalyticsSpecRow>;
  /** Normalized path → rows with that path. */
  rowsByEventPath: Map<string, AnalyticsSpecRow[]>;
};

export function buildEventPathIndex(rows: AnalyticsSpecRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    set.add(normalizeValue(specEventPath(row)));
  }
  const unique = [...set].filter((p) => p.length > 0);
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

export function buildRowMap(rows: AnalyticsSpecRow[]): Map<string, AnalyticsSpecRow> {
  const map = new Map<string, AnalyticsSpecRow>();
  for (const row of rows) {
    const ep = normalizeValue(specEventPath(row));
    const sv = specValue(row);
    const vk = sv !== null ? normalizeValue(sv) : "";
    const key = makeRowKey(ep, vk || null);
    map.set(key, row);
  }
  return map;
}

function buildRowsByEventPath(rows: AnalyticsSpecRow[]): Map<string, AnalyticsSpecRow[]> {
  const m = new Map<string, AnalyticsSpecRow[]>();
  for (const row of rows) {
    const ep = normalizeValue(specEventPath(row));
    const list = m.get(ep) ?? [];
    list.push(row);
    m.set(ep, list);
  }
  return m;
}

export function buildMatcherIndexes(rows: AnalyticsSpecRow[]): MatcherIndexes {
  return {
    eventPathIndex: buildEventPathIndex(rows),
    rowMap: buildRowMap(rows),
    rowsByEventPath: buildRowsByEventPath(rows),
  };
}
