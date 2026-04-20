import { buildSpecRows } from "./buildSpecRows";
import { extractHierarchyRows } from "./extractHierarchyRows";
import { parseWorkbookToMatrix } from "./parseWorkbook";
import type { ParsedSpecResult } from "./types";

/**
 * Full import: file → normalized matrix → hierarchy rows → spec preview rows.
 */
export async function importSpec(file: File): Promise<ParsedSpecResult> {
  const buffer = await file.arrayBuffer();
  const { matrix, debug: parseDebug } = parseWorkbookToMatrix(buffer);
  const { rows: hierarchyRows, warnings: wExtract } =
    extractHierarchyRows(matrix);
  const { rows, warnings: wBuild } = buildSpecRows(hierarchyRows);

  const warnings = [...wExtract, ...wBuild];

  return {
    rows,
    warnings,
    debug: {
      fileName: file.name,
      fileSize: file.size,
      ...parseDebug,
      meaningfulRowCount: hierarchyRows.length,
      specRowCount: rows.length,
    },
  };
}
