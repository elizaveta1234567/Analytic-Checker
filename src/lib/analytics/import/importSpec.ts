import { buildSpecRows } from "./buildSpecRows";
import { extractHierarchyRows } from "./extractHierarchyRows";
import { parseWorkbookToMatrix } from "./parseWorkbook";
import type { ParsedSpecResult } from "./types";

function findCheckColumnIndex(matrix: string[][]): number | null {
  for (const row of matrix) {
    for (let i = 0; i < row.length; i++) {
      if (row[i]?.trim().toLowerCase() === "check") {
        return i;
      }
    }
  }

  return null;
}

/**
 * Full import: file → normalized matrix → hierarchy rows → spec preview rows.
 */
export async function importSpec(file: File): Promise<ParsedSpecResult> {
  const buffer = await file.arrayBuffer();
  const { matrix, checkboxMatrix, debug: parseDebug } =
    parseWorkbookToMatrix(buffer);
  const checkColumnIndex = findCheckColumnIndex(matrix);
  const { rows: hierarchyRows, warnings: wExtract } =
    extractHierarchyRows(matrix, { checkColumnIndex });
  const { rows, warnings: wBuild } = buildSpecRows(hierarchyRows, {
    checkColumnIndex,
    checkboxMatrix,
  });

  const warnings = [
    ...(checkColumnIndex === null
      ? ["Check column not found; no checkbox-gated spec rows imported."]
      : []),
    ...wExtract,
    ...wBuild,
  ];

  return {
    rows,
    warnings,
    debug: {
      fileName: file.name,
      fileSize: file.size,
      ...parseDebug,
      checkColumnIndex,
      meaningfulRowCount: hierarchyRows.length,
      specRowCount: rows.length,
    },
  };
}
