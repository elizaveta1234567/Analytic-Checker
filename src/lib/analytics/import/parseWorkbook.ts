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

/**
 * Reads the first worksheet from an .xlsx / .xls / .csv buffer into a string matrix.
 */
export function parseWorkbookToMatrix(data: ArrayBuffer): {
  matrix: string[][];
  debug: ParseWorkbookDebug;
} {
  const workbook = XLSX.read(data, { type: "array", cellDates: false });
  const sheetNames = workbook.SheetNames;
  const usedSheetName = sheetNames[0] ?? "";
  const sheet = workbook.Sheets[usedSheetName];

  if (!sheet) {
    return {
      matrix: [],
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

  const normalized: string[][] = raw.map((row) => {
    if (!Array.isArray(row)) return [];
    return row.map((cell) => normalizeCell(cell));
  });

  const matrix = rectangularize(normalized);
  const matrixColCount = matrix.reduce((m, r) => Math.max(m, r.length), 0);

  return {
    matrix,
    debug: {
      sheetNames,
      usedSheetName,
      matrixRowCount: matrix.length,
      matrixColCount,
    },
  };
}
