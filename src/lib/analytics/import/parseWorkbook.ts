import * as XLSX from "xlsx";

export type ParseWorkbookDebug = {
  sheetNames: string[];
  usedSheetName: string;
  requestedSheetName?: string | null;
  sheetFound?: boolean;
  matrixRowCount: number;
  matrixColCount: number;
};

export type ParseWorkbookOptions = {
  sheetName?: string | null;
};

/**
 * Collapses internal whitespace and trims. Null/undefined → "".
 */
export function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  if (s === "") return "";
  return s.replace(/\s+/g, " ");
}

function rectangularize(rows: string[][]): string[][] {
  const maxCol = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < maxCol) next.push("");
    return next;
  });
}

function rectangularizeBooleans(rows: boolean[][], width: number): boolean[][] {
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push(false);
    return next;
  });
}

function findWorkbookSheetName(
  sheetNames: string[],
  requestedSheetName: string | null,
): string | null {
  const requested = requestedSheetName?.trim();
  if (!requested) {
    return sheetNames[0] ?? null;
  }

  return (
    sheetNames.find((sheetName) => sheetName === requested) ??
    sheetNames.find((sheetName) => sheetName.trim() === requested) ??
    null
  );
}

/**
 * Reads a worksheet from an .xlsx / .xls / .csv buffer into a string matrix.
 */
export function parseWorkbookToMatrix(
  data: ArrayBuffer | string,
  options: ParseWorkbookOptions = {},
): {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  debug: ParseWorkbookDebug;
} {
  const workbook = XLSX.read(data, {
    type: typeof data === "string" ? "string" : "array",
    cellDates: false,
  });
  const sheetNames = workbook.SheetNames;
  const requestedSheetName = options.sheetName?.trim() || null;
  const selectedSheetName = findWorkbookSheetName(
    sheetNames,
    requestedSheetName,
  );
  const usedSheetName = selectedSheetName ?? requestedSheetName ?? "";
  const sheet = selectedSheetName ? workbook.Sheets[selectedSheetName] : null;
  const sheetFound = Boolean(sheet);

  if (!sheet) {
    return {
      matrix: [],
      checkboxMatrix: [],
      debug: {
        sheetNames,
        usedSheetName,
        requestedSheetName,
        sheetFound,
        matrixRowCount: 0,
        matrixColCount: 0,
      },
    };
  }

  const normalized: string[][] = [];
  const checkboxRows: boolean[][] = [];
  const ref = sheet["!ref"];
  if (!ref) {
    return {
      matrix: [],
      checkboxMatrix: [],
      debug: {
        sheetNames,
        usedSheetName,
        requestedSheetName,
        sheetFound,
        matrixRowCount: 0,
        matrixColCount: 0,
      },
    };
  }

  const range = XLSX.utils.decode_range(ref);
  const rowCount = range.e.r + 1;
  const colCount = range.e.c + 1;

  for (let r = 0; r < rowCount; r++) {
    const normalizedRow: string[] = [];
    const checkboxRow: boolean[] = [];

    for (let c = 0; c < colCount; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddress];
      const rawCell = cell?.v ?? "";
      const isBooleanCell = typeof rawCell === "boolean";
      let normalizedCell = normalizeCell(cell?.w ?? rawCell);
      if (isBooleanCell) {
        normalizedCell = rawCell ? "TRUE" : "FALSE";
      }
      checkboxRow.push(isBooleanCell);
      normalizedRow.push(normalizedCell);
    }

    normalized.push(normalizedRow);
    checkboxRows.push(checkboxRow);
  }

  const matrix = rectangularize(normalized);
  const matrixColCount = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const checkboxMatrix = rectangularizeBooleans(
    checkboxRows,
    matrixColCount,
  );

  return {
    matrix,
    checkboxMatrix,
    debug: {
      sheetNames,
      usedSheetName,
      requestedSheetName,
      sheetFound,
      matrixRowCount: matrix.length,
      matrixColCount,
    },
  };
}
