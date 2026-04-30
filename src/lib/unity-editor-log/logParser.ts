import {
  extractAnalyticsPayload,
  validateExtractedPayload,
} from "@/lib/analytics/matcher/parseLogs";

const ANALYTIC_MARKER = "Analytic report:";
const SAFE_BARE_FUNNEL_PATH_RE = /^funnel\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/i;

function stripUnityMarkup(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/<\/?color(?:=[^>]*)?>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .trim();
}

function stripTrailingDots(value: string): string {
  return value.replace(/[.\s]+$/g, "").trim();
}

function isUnityStackTraceNoise(line: string): boolean {
  return (
    /^\(Filename:.*Line:\s*\d+\)$/i.test(line) ||
    /^\(at\s+.+:\d+\)$/i.test(line) ||
    /^\s*at\s+/.test(line) ||
    /^UnityEngine\./.test(line) ||
    /^DebugLogHandler:/.test(line) ||
    /^StackTraceUtility:/.test(line) ||
    /^[\w.$<>]+:[\w.$<>]+\s*\(/.test(line)
  );
}

function normalizePayload(payload: string): string | null {
  const cleaned = stripTrailingDots(stripUnityMarkup(payload));
  if (!validateExtractedPayload(cleaned).valid) {
    return null;
  }
  return `${ANALYTIC_MARKER} ${cleaned}`;
}

export function normalizeUnityLogLine(rawLine: string): string | null {
  const line = stripUnityMarkup(rawLine.replace(/\r$/, ""));
  if (line === "") {
    return null;
  }

  const markerIndex = line.indexOf(ANALYTIC_MARKER);
  if (markerIndex !== -1) {
    return normalizePayload(line.slice(markerIndex + ANALYTIC_MARKER.length));
  }

  if (isUnityStackTraceNoise(line)) {
    return null;
  }

  const barePayload = extractAnalyticsPayload(line);
  if (barePayload === null) {
    return null;
  }
  if (!SAFE_BARE_FUNNEL_PATH_RE.test(barePayload)) {
    return null;
  }

  return normalizePayload(barePayload);
}
