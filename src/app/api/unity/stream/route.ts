import { unityManager } from "@/lib/unity-editor-log/unityManager";
import type { UnityLogStreamEntry } from "@/lib/unity-editor-log/streamState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeSseDataLine(entry: UnityLogStreamEntry): Uint8Array {
  const normalized = JSON.stringify(entry).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const encoder = new TextEncoder();
  const lines = normalized.split("\n");
  const payload = lines.map((line) => `data: ${line}`).join("\n") + "\n\n";
  return encoder.encode(payload);
}

export function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (entry: UnityLogStreamEntry) => {
        controller.enqueue(encodeSseDataLine(entry));
      };

      for (const log of unityManager.getBufferedLogs()) {
        send(log);
      }

      const listener = (entry: UnityLogStreamEntry) => {
        send(entry);
      };

      unityManager.subscribe(listener);

      request.signal.addEventListener("abort", () => {
        unityManager.unsubscribe(listener);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
