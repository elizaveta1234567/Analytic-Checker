import * as XLSX from "xlsx";

export type ParseWorkbookDebug = {
  sheetNames: string[];
  usedSheetName: string;
  matrixRowCount: number;
  matrixColCount: number;
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

/**
 * Reads the first worksheet from an .xlsx / .xls / .csv buffer into a string matrix.
 */
export function parseWorkbookToMatrix(data: ArrayBuffer): {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  debug: ParseWorkbookDebug;
} {
  const workbook = XLSX.read(data, { type: "array", cellDates: false });
  const sheetNames = workbook.SheetNames;
  const usedSheetName = sheetNames[0] ?? "";
  const sheet = workbook.Sheets[usedSheetName];

  if (!sheet) {
    return {
      matrix: [],
      checkboxMatrix: [],
      debug: {
        sheetNames,
        usedSheetName,
        matrixRowCount: 0,
        matrixColCount: 0,
      },
    };
  }

  const raw = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(
    sheet,
    {
      header: 1,
      defval: "",
      raw: false,
    },
  );

  const rawValues = XLSX.utils.sheet_to_json<
    (string | number | boolean | null)[]
  >(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  const normalized: string[][] = [];
  const checkboxRows: boolean[][] = [];
  const rowCount = Math.max(raw.length, rawValues.length);

  for (let r = 0; r < rowCount; r++) {
    const displayRow = Array.isArray(raw[r]) ? raw[r] : [];
    const rawRow = Array.isArray(rawValues[r]) ? rawValues[r] : [];
    const colCount = Math.max(displayRow.length, rawRow.length);
    const normalizedRow: string[] = [];
    const checkboxRow: boolean[] = [];

    for (let c = 0; c < colCount; c++) {
      const rawCell = rawRow[c];
      const isBooleanCell = typeof rawCell === "boolean";
      let normalizedCell = normalizeCell(displayRow[c]);
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
      matrixRowCount: matrix.length,
      matrixColCount,
    },
  };
}
