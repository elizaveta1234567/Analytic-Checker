/**
 * Minimal server-side filter for iOS syslog lines before buffering / SSE.
 * Emits a single canonical line: "Analytic report: <event.path>" so the client
 * matcher (extractAnalyticsPayload) and live UI stay compatible without syslog noise.
 */

import { validateExtractedPayload } from "@/lib/analytics/matcher/parseLogs";

const ANALYTIC_MARKER = "Analytic report:";
const CLIENT_EVENT_RECEIVED = "Client event is received:";
const CLIENT_EVENT_SAVED = "Client event is saved to db:";

// NOTE: temporary raw-line diagnostics live in iosManager.ts.
// Keep normalizeIosLogLine logic stable while we verify whether analytics is printed to syslog.

/** Strip repeated [Tag] prefixes sometimes copied into the payload. */
function stripLeadingBracketTags(s: string): string {
  let t = s.trim();
  while (/^\[[^\]]+]\s*/.test(t)) {
    t = t.replace(/^\[[^\]]+]\s*/, "").trim();
  }
  return t;
}

/** Remove trailing "(apiKey: …)" / metadata parentheticals from SDK logs. */
function stripTrailingParenGroups(s: string): string {
  let t = s.trim();
  // Also allow trailing punctuation like '.' after the closing paren.
  while (/\([^)]*\)\s*[.\s]*$/.test(t)) {
    t = t.replace(/\s*\([^)]*\)\s*[.\s]*$/, "").trim();
  }
  return t;
}

function stripTrailingDots(s: string): string {
  return s.replace(/[.\s]+$/g, "").trim();
}

function stripFunnelPrefix(s: string): string {
  return s.replace(/^funnel\./i, "").trim();
}

/**
 * Raw analytics tail: after Analytic report:, or from funnel., or a bare dot-path
 * (only when the remainder looks like a single event path token sequence).
 */
function extractRawPayloadTail(working: string): string | null {
  const FUNNEL_PATH_RE = /\bfunnel\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/i;
  const DOT_PATH_RE = /\b[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/;

  const reportIdx = working.indexOf(ANALYTIC_MARKER);
  if (reportIdx !== -1) {
    const rest = working.slice(reportIdx + ANALYTIC_MARKER.length).trim();
    if (rest === "") return null;
    const funnel = rest.match(FUNNEL_PATH_RE);
    if (funnel?.[0]) return funnel[0];
    const dot = rest.match(DOT_PATH_RE);
    return dot?.[0] ?? null;
  }

  const funnel = working.match(FUNNEL_PATH_RE);
  if (funnel?.[0]) return funnel[0];

  return null;
}

function toCleanEventPath(raw: string): string | null {
  let t = stripLeadingBracketTags(raw);
  t = stripTrailingParenGroups(t);
  t = stripTrailingDots(t);
  t = stripFunnelPrefix(t);
  t = stripTrailingParenGroups(t);
  t = stripTrailingDots(t);
  if (t === "") {
    return null;
  }
  // Tighten acceptance to real event paths (prevents accidental UUID tail fragments, etc).
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(t)) {
    return null;
  }
  const check = validateExtractedPayload(t);
  return check.valid ? t : null;
}

function formatCanonicalLine(eventPath: string): string {
  return `${ANALYTIC_MARKER} ${eventPath}`;
}

export function normalizeIosLogLine(rawLine: string): string | null {
  const line = rawLine.replace(/\r$/, "");
  if (line.trim() === "") {
    return null;
  }
  const lower = line.toLowerCase();

  if (lower.includes("appleneuralengine") || lower.includes("cidevicemotion")) {
    return null;
  }

  if (line.includes(CLIENT_EVENT_SAVED)) {
    return null;
  }

  let working = line;
  if (line.includes(CLIENT_EVENT_RECEIVED)) {
    const idx = line.indexOf(CLIENT_EVENT_RECEIVED);
    working = line.slice(idx + CLIENT_EVENT_RECEIVED.length).trim();
    if (working === "") {
      return null;
    }
  }

  const hasAnalyticMarkerInFullLine = line.includes(ANALYTIC_MARKER);
  const hasFunnelInFullLine = /\bfunnel\./i.test(line);
  const hasClientReceived = line.includes(CLIENT_EVENT_RECEIVED);

  if (
    lower.includes("accessibility") &&
    !hasAnalyticMarkerInFullLine &&
    !hasFunnelInFullLine &&
    !hasClientReceived
  ) {
    return null;
  }

  working = stripLeadingBracketTags(working);

  const rawTail = extractRawPayloadTail(working);
  if (rawTail === null) {
    return null;
  }

  const eventPath = toCleanEventPath(rawTail);
  if (eventPath === null) {
    return null;
  }

  return formatCanonicalLine(eventPath);
}
