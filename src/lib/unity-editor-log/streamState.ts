import { maxBufferedLogs } from "./unityConfig";

export type UnityLiveStatus = "disconnected" | "connecting" | "live";

let status: UnityLiveStatus = "disconnected";
let activeLogPath: string | null = null;
const lastLogs: string[] = [];
const listeners = new Set<(line: string) => void>();

export const streamState = {
  setStatus(value: UnityLiveStatus) {
    status = value;
  },

  getStatus(): UnityLiveStatus {
    return status;
  },

  setActiveLogPath(value: string | null) {
    activeLogPath = value;
  },

  getActiveLogPath(): string | null {
    return activeLogPath;
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
