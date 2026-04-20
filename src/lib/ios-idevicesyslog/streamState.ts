import { maxBufferedLogs } from "./iosConfig";

let running = false;
const lastLogs: string[] = [];
const listeners = new Set<(line: string) => void>();

/**
 * In-memory singleton state for iOS live syslog stream.
 * Kept separate from Android state to avoid cross-platform coupling.
 */
export const streamState = {
  setRunning(value: boolean) {
    running = value;
  },

  isRunning(): boolean {
    return running;
  },

  addLog(line: string) {
    lastLogs.push(line);
    while (lastLogs.length > maxBufferedLogs) {
      lastLogs.shift();
    }
    for (const listener of listeners) {
      listener(line);
    }
  },

  subscribe(listener: (line: string) => void) {
    listeners.add(listener);
  },

  unsubscribe(listener: (line: string) => void) {
    listeners.delete(listener);
  },

  clear() {
    lastLogs.length = 0;
  },

  getSnapshot(): string[] {
    return [...lastLogs];
  },
};

