import type { AnalyticsSpecRow } from "@/lib/analytics/types";
import type { MockTableRow } from "./mock-ui";
import type { StatusDotVariant } from "./StatusDot";

export type TableRowModel = {
  id: string;
  dotStatus: StatusDotVariant;
  statusLabel: string;
  event: string;
  value: string | null;
  description: string;
};

export function formatSpecStatus(status: AnalyticsSpecRow["status"]): string {
  if (status === "not_checked" || status === "pending") return "not checked";
  if (status === "matched") return "passed";
  if (status === "partial") return "partial";
  return status;
}

export function specStatusToDot(
  status: AnalyticsSpecRow["status"],
): StatusDotVariant {
  switch (status) {
    case "matched":
      return "passed";
    case "partial":
      return "partial";
    case "unmatched":
      return "unknown";
    case "error":
      return "unknown";
    case "not_checked":
    case "pending":
    default:
      return "unchecked";
  }
}

export function mockToTableRowModel(row: MockTableRow): TableRowModel {
  return {
    id: row.id,
    dotStatus: row.status,
    statusLabel: row.status === "unchecked" ? "not checked" : row.status,
    event: row.event,
    value: row.value === "—" ? null : row.value,
    description: row.description,
  };
}

export function specToTableRowModel(row: AnalyticsSpecRow): TableRowModel {
  const event = String(
    row.cells.eventPath ?? row.hierarchy.join("."),
  );
  const rawValue = row.cells.value;
  const value =
    rawValue === null || rawValue === undefined
      ? null
      : typeof rawValue === "string"
        ? rawValue
        : String(rawValue);

  return {
    id: row.id,
    dotStatus: specStatusToDot(row.status),
    statusLabel: formatSpecStatus(row.status),
    event,
    value,
    description: String(row.cells.description ?? ""),
  };
}
