import type { ParsedHierarchyRow, RawSheetRow } from "./types";

/**
 * Drops fully empty rows and builds ParsedHierarchyRow for each remaining line.
 */
export function extractHierarchyRows(
  matrix: string[][],
  options: { checkColumnIndex?: number | null } = {},
): {
  rows: ParsedHierarchyRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows: ParsedHierarchyRow[] = [];
  const checkColumnIndex = options.checkColumnIndex ?? null;

  matrix.forEach((rawRow, sheetRowIndex) => {
    if (rawRow.every((c) => c === "")) {
      return;
    }

    let firstIdx = -1;
    for (let i = 0; i < rawRow.length; i++) {
      if (i === checkColumnIndex) {
        continue;
      }
      if (rawRow[i] !== "") {
        firstIdx = i;
        break;
      }
    }

    if (firstIdx < 0) {
      return;
    }

    const label = rawRow[firstIdx]!;
    const level =
      checkColumnIndex !== null && checkColumnIndex < firstIdx
        ? firstIdx - 1
        : firstIdx;
    let descriptionCandidate = "";
    let bestLen = 0;

    for (let c = firstIdx + 1; c < rawRow.length; c++) {
      if (c === checkColumnIndex) {
        continue;
      }
      const cell = rawRow[c]!;
      if (cell.length > bestLen) {
        descriptionCandidate = cell;
        bestLen = cell.length;
      }
    }

    const rowCopy: RawSheetRow = [...rawRow];

    rows.push({
      sheetRowIndex,
      level,
      label,
      descriptionCandidate,
      rawRow: rowCopy,
    });
  });

  return { rows, warnings };
}
