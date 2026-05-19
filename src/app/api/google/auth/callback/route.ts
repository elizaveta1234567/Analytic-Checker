import { exchangeGoogleOAuthCode } from "@/lib/google-sheets/oauth";

export const runtime = "nodejs";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(title: string, body: string, ok: boolean) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <style>
      body { font-family: system-ui, sans-serif; background: ${ok ? "#f4f6fb" : "#fff1f2"}; color: #111827; padding: 32px; }
      main { max-width: 520px; margin: 0 auto; border: 1px solid #d8dee9; border-radius: 12px; background: white; padding: 24px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeBody}</p>
    </main>
    <script>setTimeout(() => window.close(), 1200);</script>
  </body>
</html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: ok ? 200 : 400,
    },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    return htmlResponse("Google auth failed", error, false);
  }

  if (!code || !state) {
    return htmlResponse("Google auth failed", "Missing OAuth code or state.", false);
  }

  try {
    await exchangeGoogleOAuthCode(code, state);
    return htmlResponse(
      "Google connected",
      "You can return to Analytics Checker.",
      true,
    );
  } catch (e) {
    return htmlResponse(
      "Google auth failed",
      e instanceof Error ? e.message : String(e),
      false,
    );
  }
}
