import type { AnalyticsSpecRow } from "../types";

/** One normalized row from the worksheet (all cells are strings). */
export type RawSheetRow = string[];

/** One non-empty sheet row interpreted as a hierarchy line. */
export type ParsedHierarchyRow = {
  /** 0-based index in the normalized matrix (Excel row - 1 if no header skip). */
  sheetRowIndex: number;
  /** Column index of the first non-empty cell. */
  level: number;
  label: string;
  /** Longest textual cell strictly to the right of the label column. */
  descriptionCandidate: string;
  rawRow: RawSheetRow;
};

export type ParsedSpecResult = {
  rows: AnalyticsSpecRow[];
  warnings: string[];
  debug: Record<string, unknown>;
};
