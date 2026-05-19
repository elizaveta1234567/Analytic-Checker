import {
  extractAnalyticsPayload,
  normalizeAnalyticsEventCandidate,
  validateExtractedPayload,
} from "@/lib/analytics/matcher/parseLogs";

const ANALYTIC_MARKER = "Analytic report:";
const SAFE_BARE_FUNNEL_PATH_RE = /^funnel\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/i;
const APPSFLYER_EVENT_RE =
  /\[AppsFlyerAnalytics\]\s*send\s+AppsFlyer\s+event\s+\[([^\]]+)\]/i;

export type UnityAnalyticsType = "AppsFlyer" | "AppMetrica" | "ABTest";

export type UnityAnalyticsLogLine = {
  analyticsLine: string;
  extractedEvent: string;
  analyticsType: UnityAnalyticsType;
};

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

function normalizePayload(
  payload: string,
  analyticsType: UnityAnalyticsType,
): UnityAnalyticsLogLine | null {
  const cleaned = stripTrailingDots(stripUnityMarkup(payload));
  const normalized = normalizeAnalyticsEventCandidate(cleaned).normalized;
  if (!validateExtractedPayload(normalized).valid) {
    return null;
  }
  return {
    analyticsLine: `${ANALYTIC_MARKER} ${normalized}`,
    extractedEvent: normalized,
    analyticsType,
  };
}

function normalizeAppsFlyerPayload(payload: string): UnityAnalyticsLogLine | null {
  const cleaned = stripTrailingDots(stripUnityMarkup(payload));
  const normalized = normalizeAnalyticsEventCandidate(cleaned).normalized;
  if (!normalized || /[\s,[\]]/.test(normalized)) {
    return null;
  }
  return {
    analyticsLine: `${ANALYTIC_MARKER} ${normalized}`,
    extractedEvent: normalized,
    analyticsType: "AppsFlyer",
  };
}

export function parseUnityAnalyticsLogLine(
  rawLine: string,
): UnityAnalyticsLogLine | null {
  const line = stripUnityMarkup(rawLine.replace(/\r$/, ""));
  if (line === "") {
    return null;
  }

  const appsFlyerMatch = APPSFLYER_EVENT_RE.exec(line);
  if (appsFlyerMatch?.[1]) {
    return normalizeAppsFlyerPayload(appsFlyerMatch[1]);
  }

  const markerIndex = line.indexOf(ANALYTIC_MARKER);
  if (markerIndex !== -1) {
    return normalizePayload(
      line.slice(markerIndex + ANALYTIC_MARKER.length),
      "AppMetrica",
    );
  }

  if (isUnityStackTraceNoise(line)) {
    return null;
  }

  const barePayload = extractAnalyticsPayload(line);
  if (barePayload === null) {
    return null;
  }
  const normalizedBarePayload = normalizeAnalyticsEventCandidate(barePayload);
  if (
    normalizedBarePayload.format !== "legacy-comma" &&
    !SAFE_BARE_FUNNEL_PATH_RE.test(barePayload)
  ) {
    return null;
  }

  return normalizePayload(barePayload, "AppMetrica");
}

export function normalizeUnityLogLine(rawLine: string): string | null {
  return parseUnityAnalyticsLogLine(rawLine)?.analyticsLine ?? null;
}

export function normalizeUnityRawLogLine(rawLine: string): string | null {
  const line = stripUnityMarkup(rawLine.replace(/\r$/, ""));
  return line === "" ? null : line;
}
