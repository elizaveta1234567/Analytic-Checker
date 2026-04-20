import type { ParsedHierarchyRow, RawSheetRow } from "./types";

/**
 * Drops fully empty rows and builds ParsedHierarchyRow for each remaining line.
 */
export function extractHierarchyRows(matrix: string[][]): {
  rows: ParsedHierarchyRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows: ParsedHierarchyRow[] = [];

  matrix.forEach((rawRow, sheetRowIndex) => {
    if (rawRow.every((c) => c === "")) {
      warnings.push(
        `skipped empty row (sheet row ${sheetRowIndex + 1})`,
      );
      return;
    }

    let firstIdx = -1;
    for (let i = 0; i < rawRow.length; i++) {
      if (rawRow[i] !== "") {
        firstIdx = i;
        break;
      }
    }

    if (firstIdx < 0) {
      warnings.push(
        `skipped empty row (sheet row ${sheetRowIndex + 1})`,
      );
      return;
    }

    const label = rawRow[firstIdx]!;
    let descriptionCandidate = "";
    let bestLen = 0;

    for (let c = firstIdx + 1; c < rawRow.length; c++) {
      const cell = rawRow[c]!;
      if (cell.length > bestLen) {
        descriptionCandidate = cell;
        bestLen = cell.length;
      }
    }

    const rowCopy: RawSheetRow = [...rawRow];

    rows.push({
      sheetRowIndex,
      level: firstIdx,
      label,
      descriptionCandidate,
      rawRow: rowCopy,
    });
  });

  return { rows, warnings };
}
