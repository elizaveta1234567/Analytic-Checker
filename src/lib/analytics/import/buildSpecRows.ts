import type { AnalyticsSpecRow } from "../types";
import type { ParsedHierarchyRow } from "./types";

/**
 * Heuristic: compact token / snake-ish name without spaces — treated as an "action" node parent.
 */
function looksLikeActionNode(s: string): boolean {
  if (!s || /\s/.test(s)) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(s);
}

function rowHasCheckCheckbox(
  hr: ParsedHierarchyRow,
  checkColumnIndex: number | null,
  checkboxMatrix: boolean[][],
): boolean {
  if (checkColumnIndex === null) {
    return false;
  }

  return checkboxMatrix[hr.sheetRowIndex]?.[checkColumnIndex] === true;
}

function rowHasMeaningfulTestContent(
  hr: ParsedHierarchyRow,
  checkColumnIndex: number | null,
): boolean {
  const meaningfulColumnIndexes = [0, 1, 2, 3, 4, 7, 8];

  return meaningfulColumnIndexes.some(
    (index) =>
      index !== checkColumnIndex &&
      (hr.rawRow[index]?.trim().length ?? 0) > 0,
  );
}

/**
 * Turns hierarchy lines into AnalyticsSpecRow preview rows (MVP).
 */
export function buildSpecRows(
  hierarchyRows: ParsedHierarchyRow[],
  options: {
    checkColumnIndex?: number | null;
    checkboxMatrix?: boolean[][];
  } = {},
): { rows: AnalyticsSpecRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: AnalyticsSpecRow[] = [];
  const seenKeys = new Set<string>();
  let path: string[] = [];
  const checkColumnIndex = options.checkColumnIndex ?? null;
  const checkboxMatrix = options.checkboxMatrix ?? [];

  for (const hr of hierarchyRows) {
    const { level, label, descriptionCandidate, sheetRowIndex } = hr;
    const parentStack = path.slice(0, level);
    const parentLabel = level > 0 ? parentStack[level - 1] : undefined;

    const newPath = [...parentStack, label];
    path = newPath;

    let value: string | null = null;
    let hierarchyForSpec: string[];

    if (/\s/.test(label) && parentLabel && looksLikeActionNode(parentLabel)) {
      value = label;
      hierarchyForSpec = parentStack;
    } else {
      hierarchyForSpec = newPath;
    }

    const eventPath = hierarchyForSpec.join(".");
    const desc = descriptionCandidate;

    if (
      !rowHasCheckCheckbox(hr, checkColumnIndex, checkboxMatrix) ||
      !rowHasMeaningfulTestContent(hr, checkColumnIndex)
    ) {
      continue;
    }

    const dedupeKey = `${eventPath}\0${value ?? ""}\0${desc}`;
    if (seenKeys.has(dedupeKey)) {
      warnings.push(
        `duplicate parsed row key (sheet row ${sheetRowIndex + 1}, "${eventPath}")`,
      );
    } else {
      seenKeys.add(dedupeKey);
    }

    rows.push({
      id: `spec-${sheetRowIndex}`,
      hierarchy: hierarchyForSpec,
      cells: {
        label,
        eventPath,
        description: desc,
        value,
        sheetRowIndex,
        level,
      },
      status: "not_checked",
      meta: {
        sheetRowIndex,
        level,
        fullPath: newPath.join("."),
      },
    });
  }

  return { rows, warnings };
}
