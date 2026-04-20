/**
 * Session state: wires import + matcher + UI-facing updates.
 */

import type { AnalyticsSessionState } from "../types";

export type { AnalyticsSessionState } from "../types";

export function createEmptySession(): AnalyticsSessionState {
  return {
    specRows: [],
    logEntries: [],
    matches: {},
    lastImportAt: null,
    lastLogIngestAt: null,
  };
}
