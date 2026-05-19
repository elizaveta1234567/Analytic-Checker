const ANALYTIC_MARKER = "Analytic report:";
const EVENT_SEGMENT_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

export type AnalyticsEventFormat = "legacy-comma" | "dotted";

export type NormalizedAnalyticsEventCandidate = {
  raw: string;
  normalized: string;
  format: AnalyticsEventFormat;
};

function collapseDots(value: string): string {
  return value.replace(/\.+/g, ".").replace(/^\./, "").replace(/\.$/, "");
}

function isLikelyLegacyCommaAnalyticsPayload(value: string): boolean {
  if (!value.includes(",")) {
    return false;
  }
  const segments = value
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (
    segments.length >= 2 &&
    segments.every((segment) => EVENT_SEGMENT_RE.test(segment))
  );
}

export function normalizeAnalyticsEventCandidate(
  payload: string,
): NormalizedAnalyticsEventCandidate {
  const raw = payload.trim();
  if (isLikelyLegacyCommaAnalyticsPayload(raw)) {
    const normalized = collapseDots(
      raw
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("."),
    );
    return { raw, normalized, format: "legacy-comma" };
  }
  return { raw, normalized: collapseDots(raw), format: "dotted" };
}

export const analyticsEventNormalizationManualChecks = [
  {
    input: "subscription, first.time, subscription.impression2, close",
    expected: "subscription.first.time.subscription.impression2.close",
  },
  {
    input: "inapp, impression, wheels",
    expected: "inapp.impression.wheels",
  },
  {
    input: "subscription.first.time.step1.impression",
    expected: "subscription.first.time.step1.impression",
  },
] as const;

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
  if (isLikelyLegacyCommaAnalyticsPayload(t)) {
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
