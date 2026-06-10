import {
  normalizeAnalyticsEventCandidate,
  validateExtractedPayload,
} from "@/lib/analytics/matcher/parseLogs";

const ANALYTIC_MARKER = "Analytic report:";
const APPSFLYER_ANALYTICS_RE = /AppsFlyerAnalytics/i;
const APPSFLYER_SEND_EVENT_RE = /send\s+AppsFlyer\s+event\b/i;
const SQUARE_BRACKET_VALUE_RE = /\[([^\]]+)\]/g;
const ANALYTICS_CONTROLLER_RE = /AnalyticsController/i;
const ANALYTICS_CONTROLLER_EVENT_RE =
  /reported\s+event\s*:\s*([^\s{]+)/i;

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
  options: { allowSingleSegment?: boolean } = {},
): UnityAnalyticsLogLine | null {
  const cleaned = stripTrailingDots(stripUnityMarkup(payload));
  const normalized = normalizeAnalyticsEventCandidate(cleaned).normalized;
  const payloadCheck = validateExtractedPayload(normalized);
  const isSingleSegment =
    normalized.split(".").filter((segment) => segment.trim()).length === 1;
  if (
    !payloadCheck.valid &&
    !(options.allowSingleSegment === true && isSingleSegment)
  ) {
    return null;
  }
  return {
    analyticsLine: `${ANALYTIC_MARKER} ${normalized}`,
    extractedEvent: normalized,
    analyticsType,
  };
}

function extractLastSquareBracketValue(value: string): string | null {
  let lastValue: string | null = null;
  SQUARE_BRACKET_VALUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SQUARE_BRACKET_VALUE_RE.exec(value)) !== null) {
    lastValue = match[1]?.trim() || null;
  }
  return lastValue;
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

function parseAppsFlyerAnalyticsLogLine(
  line: string,
): UnityAnalyticsLogLine | null {
  if (!APPSFLYER_ANALYTICS_RE.test(line)) {
    return null;
  }
  const sendEventMatch = APPSFLYER_SEND_EVENT_RE.exec(line);
  if (sendEventMatch === null) {
    return null;
  }
  const payload = extractLastSquareBracketValue(
    line.slice(sendEventMatch.index),
  );
  return payload === null ? null : normalizeAppsFlyerPayload(payload);
}

function parseAnalyticsControllerLogLine(
  line: string,
): UnityAnalyticsLogLine | null {
  if (!ANALYTICS_CONTROLLER_RE.test(line)) {
    return null;
  }
  const eventMatch = ANALYTICS_CONTROLLER_EVENT_RE.exec(line);
  if (!eventMatch?.[1]) {
    return null;
  }
  return normalizePayload(eventMatch[1], "AppMetrica", {
    allowSingleSegment: true,
  });
}

export function parseUnityAnalyticsLogLine(
  rawLine: string,
): UnityAnalyticsLogLine | null {
  const line = stripUnityMarkup(rawLine.replace(/\r$/, ""));
  if (line === "") {
    return null;
  }

  const appsFlyerLogLine = parseAppsFlyerAnalyticsLogLine(line);
  if (appsFlyerLogLine !== null) {
    return appsFlyerLogLine;
  }

  const analyticsControllerLogLine = parseAnalyticsControllerLogLine(line);
  if (analyticsControllerLogLine !== null) {
    return analyticsControllerLogLine;
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
  return null;
}

export function normalizeUnityLogLine(rawLine: string): string | null {
  return parseUnityAnalyticsLogLine(rawLine)?.analyticsLine ?? null;
}

export function normalizeUnityRawLogLine(rawLine: string): string | null {
  const line = stripUnityMarkup(rawLine.replace(/\r$/, ""));
  return line === "" ? null : line;
}
