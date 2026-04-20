import { adbManager } from "@/lib/android-adb/adbManager";

function encodeSseDataLine(log: string): Uint8Array {
  const normalized = log.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const encoder = new TextEncoder();
  const lines = normalized.split("\n");
  const payload = lines.map((line) => `data: ${line}`).join("\n") + "\n\n";
  return encoder.encode(payload);
}

export function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (log: string) => {
        controller.enqueue(encodeSseDataLine(log));
      };

      for (const log of adbManager.getBufferedLogs()) {
        send(log);
      }

      const listener = (line: string) => {
        send(line);
      };

      adbManager.subscribe(listener);

      request.signal.addEventListener("abort", () => {
        adbManager.unsubscribe(listener);
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
