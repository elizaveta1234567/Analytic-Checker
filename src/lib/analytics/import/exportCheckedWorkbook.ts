import * as ExcelJS from "exceljs";
import type { Alignment, Cell, Worksheet } from "exceljs";
import type { AnalyticsSpecRow } from "../types";

export type ExportCheckedWorkbookOptions = {
  originalWorkbook: ArrayBuffer;
  rows: AnalyticsSpecRow[];
  usedSheetName: string;
  checkColumnIndex: number;
  doneColumnIndex?: number | null;
};

const PASSED_MARK = "\u2705";
const NOT_PASSED_MARK = "\u2B1C";

const checkAlignment: Partial<Alignment> = {
  horizontal: "center",
  vertical: "middle",
};

function asSheetRowIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function asColumnIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function getSheetRowIndex(row: AnalyticsSpecRow): number | null {
  return (
    asSheetRowIndex(row.meta?.sheetRowIndex) ??
    asSheetRowIndex(row.cells.sheetRowIndex)
  );
}

function toExcelRowNumber(sheetRowIndex: number): number {
  return sheetRowIndex + 1;
}

function toExcelColumnNumber(columnIndex: number): number {
  return columnIndex + 1;
}

function getCellText(
  worksheet: Worksheet,
  rowNumber: number,
  columnNumber: number,
): string {
  const cell = worksheet.findCell(rowNumber, columnNumber);
  if (!cell) {
    return "";
  }

  return cell.text.trim();
}

function findHeaderRowNumber(
  worksheet: Worksheet,
  checkColumnNumber: number,
): number {
  const maxRow = Math.max(worksheet.rowCount, 1);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber++) {
    if (
      getCellText(worksheet, rowNumber, checkColumnNumber).toLowerCase() ===
      "check"
    ) {
      return rowNumber;
    }
  }

  return 1;
}

function findColumnNumberByHeader(
  worksheet: Worksheet,
  headerRowNumber: number,
  headerName: string,
): number | null {
  const headerRow = worksheet.findRow(headerRowNumber);
  if (!headerRow) {
    return null;
  }

  let foundColumnNumber: number | null = null;
  headerRow.eachCell((cell, columnNumber) => {
    if (
      foundColumnNumber === null &&
      cell.text.trim().toLowerCase() === headerName.toLowerCase()
    ) {
      foundColumnNumber = columnNumber;
    }
  });

  return foundColumnNumber;
}

function mergeAlignment(
  current: Partial<Alignment> | undefined,
  next: Partial<Alignment>,
): Partial<Alignment> {
  return {
    ...(current ?? {}),
    ...next,
  };
}

function applyCheckAlignment(cell: Cell) {
  cell.alignment = mergeAlignment(cell.alignment, checkAlignment);
}

function setResultCell(
  worksheet: Worksheet,
  rowNumber: number,
  columnNumber: number,
  value: string,
) {
  const cell = worksheet.getCell(rowNumber, columnNumber);
  cell.value = value;
  applyCheckAlignment(cell);
}

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }

  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

export async function exportCheckedWorkbook({
  originalWorkbook,
  rows,
  usedSheetName,
  checkColumnIndex,
  doneColumnIndex,
}: ExportCheckedWorkbookOptions): Promise<ArrayBuffer> {
  if (usedSheetName.trim() === "") {
    throw new Error("Worksheet name is missing.");
  }

  if (!Number.isInteger(checkColumnIndex) || checkColumnIndex < 0) {
    throw new Error("Check column metadata is missing.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(originalWorkbook as unknown as Buffer);

  const worksheet = workbook.getWorksheet(usedSheetName);
  if (!worksheet) {
    throw new Error(`Worksheet "${usedSheetName}" was not found.`);
  }

  const checkColumnNumber = toExcelColumnNumber(checkColumnIndex);
  const headerRowNumber = findHeaderRowNumber(worksheet, checkColumnNumber);
  const doneColumnNumber =
    asColumnIndex(doneColumnIndex) !== null
      ? toExcelColumnNumber(doneColumnIndex as number)
      : findColumnNumberByHeader(worksheet, headerRowNumber, "done");

  if (doneColumnNumber === null) {
    console.warn(
      "[export-checked-workbook] Done column was not found; only Check cells will be marked.",
    );
  }

  for (const row of rows) {
    const sheetRowIndex = getSheetRowIndex(row);
    if (sheetRowIndex === null) {
      continue;
    }

    const excelRowNumber = toExcelRowNumber(sheetRowIndex);
    const resultMark =
      row.status === "matched" ? PASSED_MARK : NOT_PASSED_MARK;

    setResultCell(
      worksheet,
      excelRowNumber,
      checkColumnNumber,
      resultMark,
    );

    if (doneColumnNumber !== null) {
      setResultCell(
        worksheet,
        excelRowNumber,
        doneColumnNumber,
        resultMark,
      );
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return toArrayBuffer(output);
}
