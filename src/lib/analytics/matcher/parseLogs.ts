const ANALYTIC_MARKER = "Analytic report:";

/**
 * Extracts analytics payload from a single console line, or null if not applicable.
 */
export function extractAnalyticsPayload(rawLine: string): string | null {
  const idx = rawLine.indexOf(ANALYTIC_MARKER);
  if (idx !== -1) {
    const rest = rawLine.slice(idx + ANALYTIC_MARKER.length).trim();
    return rest === "" ? null : rest;
  }
  const t = rawLine.trim();
  if (t.toLowerCase().startsWith("funnel.")) {
    return t;
  }
  return null;
}

const INVALID_FORMAT_REASON = "invalid payload format";

/**
 * Rejects malformed event payloads before matching.
 * - Trailing `.`
 * - Empty segments (`..`, `.` at edges after split)
 * - Single segment only (insufficient depth vs roots like `funnel`)
 */
export function validateExtractedPayload(
  payload: string,
): { valid: true } | { valid: false; reason: string } {
  const p = payload.trim();
  if (p === "") {
    return { valid: false, reason: INVALID_FORMAT_REASON };
  }
  if (p.endsWith(".")) {
    return { valid: false, reason: INVALID_FORMAT_REASON };
  }
  const segments = p.split(".");
  if (segments.some((s) => s.trim() === "")) {
    return { valid: false, reason: INVALID_FORMAT_REASON };
  }
  if (segments.length < 2) {
    return { valid: false, reason: INVALID_FORMAT_REASON };
  }
  return { valid: true };
}
