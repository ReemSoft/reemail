import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail-sent-copy-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const token = typeof body?.mailSessionToken === "string" ? body.mailSessionToken : "";
          const jobId = typeof body?.jobId === "string" ? body.jobId : "";
          if (!token || !jobId) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
          const auth = await resolveBridgeAuth(token);
          if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
          const upstream = await fetch(`${auth.bridgeUrl}/api/send-status`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Bridge-Key": auth.bridgeKey,
            },
            body: JSON.stringify({ account: auth.bridgeAccount, jobId }),
          });
          const result = await upstream.text();
          return new Response(result, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
            },
          });
        } catch {
          return json({ ok: false, error: "INVALID_PAYLOAD" }, 400);
        }
      },
    },
  },
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
