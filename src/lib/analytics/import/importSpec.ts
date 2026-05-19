import { buildSpecRows } from "./buildSpecRows";
import { extractHierarchyRows } from "./extractHierarchyRows";
import { parseWorkbookToMatrix } from "./parseWorkbook";
import type { ParsedSpecResult } from "./types";

type ImportSpecOptions = {
  checkColumnIndex?: number | null;
};

type MatrixDebugInput = {
  sheetNames?: string[];
  usedSheetName?: string;
  matrixRowCount?: number;
  matrixColCount?: number;
};

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

export function importSpecFromMatrix(
  matrix: string[][],
  checkboxMatrix: boolean[][],
  source: { fileName: string; fileSize: number },
  options: ImportSpecOptions = {},
  matrixDebug: MatrixDebugInput = {},
): ParsedSpecResult {
  const checkColumnIndex =
    options.checkColumnIndex === undefined
      ? findCheckColumnIndex(matrix)
      : options.checkColumnIndex;
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
      fileName: source.fileName,
      fileSize: source.fileSize,
      sheetNames: matrixDebug.sheetNames ?? [],
      usedSheetName: matrixDebug.usedSheetName ?? "",
      matrixRowCount: matrixDebug.matrixRowCount ?? matrix.length,
      matrixColCount:
        matrixDebug.matrixColCount ??
        matrix.reduce((max, row) => Math.max(max, row.length), 0),
      checkColumnIndex,
      meaningfulRowCount: hierarchyRows.length,
      specRowCount: rows.length,
    },
  };
}

function importSpecFromWorkbookData(
  data: ArrayBuffer | string,
  source: { fileName: string; fileSize: number },
  options: ImportSpecOptions = {},
): ParsedSpecResult {
  const { matrix, checkboxMatrix, debug: parseDebug } =
    parseWorkbookToMatrix(data);
  return importSpecFromMatrix(
    matrix,
    checkboxMatrix,
    source,
    options,
    parseDebug,
  );
}

export function importSpecFromArrayBuffer(
  data: ArrayBuffer,
  source: { fileName: string; fileSize: number },
): ParsedSpecResult {
  return importSpecFromWorkbookData(data, source);
}

export function importSpecFromCsvText(
  data: string,
  source: { fileName: string; fileSize: number },
  options: ImportSpecOptions = {},
): ParsedSpecResult {
  return importSpecFromWorkbookData(data, source, options);
}

/**
 * Full import: file → normalized matrix → hierarchy rows → spec preview rows.
 */
export async function importSpec(file: File): Promise<ParsedSpecResult> {
  const buffer = await file.arrayBuffer();
  return importSpecFromArrayBuffer(buffer, {
    fileName: file.name,
    fileSize: file.size,
  });
}
