/**
 * Normalizes values for comparison (trim, collapse spaces, lowercase).
 */
export function normalizeValue(value: string | null): string {
  if (value === null) return "";
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
